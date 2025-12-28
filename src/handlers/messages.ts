import { AxiosError } from 'axios'
import * as emoji from 'node-emoji'
import * as showdown from 'showdown'
import { Entity, entities } from '../Entities'
import { IdMapping } from '../entity/IdMapping'
import log from '../helpers/logger'
import {
  getMessageId,
  getRoomId,
  getUserId,
  getUserMappingByName,
  save,
  getMapping,
} from '../helpers/storage'
import {
  axios,
  formatUserSessionOptions,
  getServerName,
} from '../helpers/synapse'
import emojiMap from '../emojis.json'
import { customEmojiNames } from './emojis'
import { executeAndHandleMissingMember } from './rooms'

const applicationServiceToken = process.env.AS_TOKEN || ''
if (!applicationServiceToken) {
  const message = 'No AS_TOKEN found in .env.'
  log.error(message)
  throw new Error(message)
}

/**
 * Type of Rocket.Chat messages
 */
export type RcMessage = {
  _id: string
  t?: string // Event type
  rid: string // The unique id for the room
  msg: string // The content of the message.
  tmid?: string
  ts: {
    $date: string
  }
  mentions?: string[]
  u: {
    _id: string
    username?: string
    name?: string
  }
  // md?: any // The message's content in a markdown format.
  pinned?: boolean
  pinnedBy?: {
    _id?: string
    username?: string
  }
  drid?: string // The direct room id (if belongs to a direct room).
  file?: {
    _id: string
    name: string
    type: string
  }
  attachments?: {
    title?: string
    title_link?: string
    image_url?: string
    audio_url?: string
    video_url?: string
    image_type?: string
    audio_type?: string
    video_type?: string
    image_size?: number
    audio_size?: number
    video_size?: number
    description?: string
  }[]
  reactions?: {
    [key: string]: {
      usernames: string[]
    }
  }
  md?: string
}

/**
 * Type of Matrix message event bodies
 */
export type MatrixMessage = {
  body: string
  msgtype: string
  type: string
  format?: string
  formatted_body?: string
  'm.mentions'?: {
    room?: boolean
    user_ids?: Array<string>
  }
  url?: string
  info?: {
    mimetype?: string
    size?: number
    [key: string]: any
  }
  'm.relates_to'?: {
    rel_type: 'm.thread'
    event_id: string
    is_falling_back: true
    'm.in_reply_to': {
      event_id: string
    }
  }
}

/**
 * Emojis translated from Rocket.Chat to Unicode emojis, which Matrix uses
 */
export type EmojiMappings = {
  [key: string]: string
}

export async function mapTextMessage(
  rcMessage: RcMessage
): Promise<MatrixMessage> {
  let msg = rcMessage.msg

  const synapseServerName = await getServerName()

  const converterOptions: showdown.ConverterOptions = {
    literalMidWordUnderscores: true,
    simpleLineBreaks: true,
  }
  const mentions: MatrixMessage['m.mentions'] = {}

  if (msg.includes('@all')) {
    converterOptions['ghMentions'] = false

    msg = msg.replace('@all', '@room')

    mentions.room = true
  } else if (msg.includes('@here')) {
    converterOptions['ghMentions'] = false
  } else {
    converterOptions['ghMentions'] = true
    converterOptions['ghMentionsLink'] =
      'https://matrix.to/#/@{u}:' + synapseServerName

    for (const mention of msg.matchAll(
      /(^|\s)(\\)?(@([a-z\d]+(?:[a-z\d._-]+?[a-z\d]+)*))/gi
    )) {
      const username = '@' + mention[4] + ':' + synapseServerName

      mentions.user_ids = mentions?.user_ids || []
      mentions.user_ids.push(username)
    }
  }

  const converter = new showdown.Converter(converterOptions)

  const emojified = msg.replace(/:[\w\-+]+:/g, getEmoji)
  const htmled = converter.makeHtml(emojified)
  const matrixMessage: MatrixMessage = {
    type: 'm.room.message',
    msgtype: 'm.text',
    body: emojified,
  }
  if (mentions && (mentions.room || mentions.user_ids)) {
    matrixMessage['m.mentions'] = mentions
  }

  if (htmled.replace(/^<p>/, '').replace(/<\/p>$/, '') === emojified) {
    // markdown adds <p></p> tags, if it only adds this, don't add html part
    return matrixMessage
  } else {
    return {
      ...matrixMessage,
      format: 'org.matrix.custom.html',
      formatted_body: htmled,
    }
  }
}

/**
 * Translate a Rocket.Chat message to a Matrix message event body
 * @param rcMessage The Rocket.Chat message to convert
 * @returns The Matrix event body
 */
export async function mapMessage(rcMessage: RcMessage): Promise<MatrixMessage> {
  // If there's an uploaded file with a mapping, return an appropriate media message.
  if (rcMessage.file && rcMessage.file._id) {
    const uploadMapping = await getMapping(
      rcMessage.file._id,
      entities[Entity.Uploads].mappingType
    )
    if (uploadMapping && uploadMapping.matrixId) {
      const mime = rcMessage.file.type || ''
      const msgtype = mime.startsWith('image/')
        ? 'm.image'
        : mime.startsWith('video/')
          ? 'm.video'
          : mime.startsWith('audio/')
            ? 'm.audio'
            : 'm.file'

      return {
        type: 'm.room.message',
        msgtype: msgtype,
        body: rcMessage.file.name,
        url: uploadMapping.matrixId,
        info: {
          mimetype: rcMessage.file.type,
        },
      }
    } else {
      // File upload has no mapping - file wasn't migrated (missing from export)
      // Create a text message indicating the missing file
      log.warn(
        `File upload ${rcMessage.file._id} (${rcMessage.file.name}) not found in uploads - creating placeholder message`
      )
      return {
        type: 'm.room.message',
        msgtype: 'm.text',
        body: `[File not migrated: ${rcMessage.file.name}]${rcMessage.msg ? '\n' + rcMessage.msg : ''}`,
      }
    }
  }

  // Basic handling for attachments that reference external URLs (images, audio, video)
  if (rcMessage.attachments && rcMessage.attachments.length > 0) {
    const att = rcMessage.attachments[0]
    if (att.image_url) {
      return {
        type: 'm.room.message',
        msgtype: 'm.image',
        body: att.title || rcMessage.msg || 'image',
        url: att.image_url,
        info: {
          mimetype: att.image_type,
          size: att.image_size,
        },
      }
    }
    if (att.video_url) {
      return {
        type: 'm.room.message',
        msgtype: 'm.video',
        body: att.title || rcMessage.msg || 'video',
        url: att.video_url,
        info: {
          mimetype: att.video_type,
          size: att.video_size,
        },
      }
    }
    if (att.audio_url) {
      return {
        type: 'm.room.message',
        msgtype: 'm.audio',
        body: att.title || rcMessage.msg || 'audio',
        url: att.audio_url,
        info: {
          mimetype: att.audio_type,
          size: att.audio_size,
        },
      }
    }
  }

  // Fallback to text mapping for any other message type
  return mapTextMessage(rcMessage)
}

/**
 * Save an ID mapping in the local database
 * @param rcId Rocket.Chat message ID
 * @param matrixId Matrix message ID
 */
export async function createMapping(
  rcId: string,
  matrixId: string
): Promise<void> {
  const messageMapping = new IdMapping()
  messageMapping.rcId = rcId
  messageMapping.matrixId = matrixId
  messageMapping.type = entities[Entity.Messages].mappingType

  await save(messageMapping)
  log.debug('Mapping added:', messageMapping)
}

/**
 * Send a request to Synapse, creating the message event
 * @param matrixMessage The Matrix event body to use
 * @param room_id The Matrix room, the message will be posted to
 * @param user_id The user the message will be posted by
 * @param ts The timestamp to which the message will be dated
 * @param transactionId An unique identifier to distinguish identical messages
 * @returns The Matrix Message/event ID
 */
export async function createMessage(
  matrixMessage: MatrixMessage,
  room_id: string,
  user_id: string,
  ts: number,
  transactionId: string
): Promise<string> {
  // Ensure 'body' exists — Matrix requires it for m.room.message content
  const msgToSend = { ...matrixMessage }
  if (
    !msgToSend.body ||
    typeof msgToSend.body !== 'string' ||
    msgToSend.body.trim() === ''
  ) {
    // Try to derive a body from formatted_body by stripping tags
    if (
      msgToSend.formatted_body &&
      typeof msgToSend.formatted_body === 'string'
    ) {
      msgToSend.body =
        msgToSend.formatted_body.replace(/<[^>]+>/g, '').trim() || ' '
    } else if (msgToSend.url) {
      // For media messages, use a simple placeholder
      msgToSend.body =
        msgToSend.msgtype === 'm.image'
          ? 'Image'
          : msgToSend.msgtype === 'm.video'
            ? 'Video'
            : 'File'
    } else {
      msgToSend.body = ' '
    }
    log.warn(
      'Message had no body; using fallback body for transaction',
      transactionId,
      msgToSend
    )
  }

  return (
    await axios.put(
      `/_matrix/client/v3/rooms/${room_id}/send/m.room.message/${transactionId}?user_id=${user_id}&ts=${ts}`,
      msgToSend,
      formatUserSessionOptions(applicationServiceToken)
    )
  ).data.event_id
}

/**
 * Add reactions to the event
 * @param reactions A Rocket.Chat reactions object
 * @param matrixMessageId The Matrix event reacted to
 * @param matrixRoomId The Matrix room
 */
export async function handleReactions(
  reactions: RcMessage['reactions'],
  matrixMessageId: string,
  matrixRoomId: string
): Promise<void> {
  for (const [reaction, value] of Object.entries(reactions || {})) {
    // Lookup key/emoji
    const reactionEmoji: string = getEmoji(reaction)

    if (reactionEmoji === reaction) {
      log.warn(
        `Could not find an emoji for ${reaction} for message ${matrixMessageId}, skipping`
      )
      continue
    }

    await Promise.all(
      [...new Set(value.usernames)] // Deduplicate users
        .map(async (rcUsername: string) => {
          // generate transaction id
          const transactionId = Buffer.from(
            [matrixMessageId, reactionEmoji, rcUsername].join('\0')
          ).toString('base64url')
          // lookup user access token
          const userMapping = await getUserMappingByName(rcUsername)
          if (!userMapping || !userMapping.accessToken) {
            log.warn(
              `Could not find user mapping for name: ${rcUsername}, attempting to send reaction as AS fallback for message ${matrixMessageId}`
            )

            // Fallback: if we have an application service token, try to post the reaction
            // on behalf of the user using the user_id query parameter.
            const asToken = applicationServiceToken
            if (asToken) {
              try {
                const serverName = await getServerName()
                const matrixUserId = `@${rcUsername}:${serverName}`
                await executeAndHandleMissingMember(() =>
                  axios.put(
                    `/_matrix/client/v3/rooms/${matrixRoomId}/send/m.reaction/${transactionId}?user_id=${encodeURIComponent(
                      matrixUserId
                    )}`,
                    {
                      'm.relates_to': {
                        rel_type: 'm.annotation',
                        event_id: matrixMessageId,
                        key: reactionEmoji,
                      },
                    },
                    formatUserSessionOptions(asToken)
                  )
                )
                log.http(
                  `Added reaction ${reactionEmoji} for user ${rcUsername} using AS fallback`
                )
                return
              } catch (asError: any) {
                log.warn(
                  `AS fallback failed for ${rcUsername}: ${asError?.response?.data || asError.message}`
                )
              }
            }

            log.warn(
              `Skipping reaction ${reactionEmoji} for message ${matrixMessageId} as no mapping or AS fallback available for ${rcUsername}`
            )
            return
          }

          const userSessionOptions = formatUserSessionOptions(
            userMapping.accessToken
          )
          log.http(
            `Adding reaction to message ${matrixMessageId} with symbol ${reactionEmoji} for user ${rcUsername}`
          )
          // put reaction
          try {
            await executeAndHandleMissingMember(() =>
              axios.put(
                `/_matrix/client/v3/rooms/${matrixRoomId}/send/m.reaction/${transactionId}`,
                {
                  'm.relates_to': {
                    rel_type: 'm.annotation',
                    event_id: matrixMessageId,
                    key: reactionEmoji,
                  },
                },
                userSessionOptions
              )
            )
          } catch (error) {
            if (
              error instanceof AxiosError &&
              error.response &&
              error.response.data.errcode === 'M_DUPLICATE_ANNOTATION'
            ) {
              log.debug(
                `Duplicate reaction to message ${matrixMessageId} with symbol ${reactionEmoji} for user ${rcUsername}, skipping.`
              )
            } else {
              throw error
            }
          }
        })
    )
  }
}

/**
 * Lookup an emoji first by its name representation and return a unicode emoji.
 *
 * First the emojis.json is looked up, then the emoji library. If no emoji is found, the search string is returned.
 * @param searchString Name of the emoji, possibly surrounded by colons
 * @returns The found emoji or `searchString`
 */
export function getEmoji(searchString: string): string {
  // First check our local custom emoji set (they are stored as :name:)
  if (customEmojiNames.has(searchString)) return searchString

  return (
    (emojiMap as EmojiMappings)[searchString] ||
    emoji.get(searchString.replaceAll(':', '')) ||
    searchString
  )
}

/**
 * Handle a line of a Rocket.Chat message JSON export
 * @param rcMessage A Rocket.Chat message object
 */
export async function handle(rcMessage: RcMessage): Promise<void> {
  log.info(`Parsing message with ID: ${rcMessage._id}`)

  const matrixId = await getMessageId(rcMessage._id)
  if (matrixId) {
    log.debug(`Mapping exists: ${rcMessage._id} -> ${matrixId}`)
    return
  }

  const room_id = await getRoomId(rcMessage.rid)
  if (!room_id) {
    if ((process.env.INCLUDED_ROOMS || '').length > 0) {
      log.debug(
        `Could not find room ${rcMessage.rid} for message ${rcMessage._id}, skipping (likely excluded).`
      )
    } else {
      log.warn(
        `Could not find room ${rcMessage.rid} for message ${rcMessage._id}, skipping.`
      )
    }
    return
  }

  if (rcMessage.t) {
    log.warn(
      `Message ${rcMessage._id} is of unhandled type ${rcMessage.t}, skipping.`
    )
    return
  }

  const user_id = await getUserId(rcMessage.u._id)
  if (!user_id) {
    log.warn(
      `Could not find author ${rcMessage.u.username} for message ${rcMessage._id}, skipping.`
    )
    return
  }
  const matrixMessage = await mapMessage(rcMessage)
  const ts = new Date(rcMessage.ts.$date).valueOf()

  if (rcMessage.tmid) {
    const event_id = await getMessageId(rcMessage.tmid)
    if (!event_id) {
      log.warn(`Related message ${rcMessage.tmid} missing, skipping.`)
      return
    } else {
      matrixMessage['m.relates_to'] = {
        rel_type: 'm.thread',
        event_id,
        is_falling_back: true,
        'm.in_reply_to': {
          event_id,
        },
      }
    }
  }
  await executeAndHandleMissingMember(() =>
    createEventsAndMapping(matrixMessage, room_id, user_id, ts, rcMessage)
  )
}

/**
 * Wrapper function to combine the creation of a message, the reactions, adding of authors and the database mapping
 * @param matrixMessage The Matrix message event body
 * @param room_id The Matrix room ID
 * @param user_id The Matrix ID of the author
 * @param ts The Timestamp the message was originally created
 * @param rcMessage The originam Rocket.Chat message object
 */
async function createEventsAndMapping(
  matrixMessage: MatrixMessage,
  room_id: string,
  user_id: string,
  ts: number,
  rcMessage: RcMessage
): Promise<void> {
  const event_id = await createMessage(
    matrixMessage,
    room_id,
    user_id,
    ts,
    rcMessage._id
  )
  if (rcMessage.reactions) {
    log.info(
      `Parsing reactions for message ${rcMessage._id}`,
      rcMessage.reactions
    )
    await handleReactions(rcMessage.reactions, event_id, room_id)
  }
  await createMapping(rcMessage._id, event_id)
}

import fs from 'fs'
import path from 'path'
import { Entity, entities } from '../Entities'
import log from '../helpers/logger'
import {
  adminAccessToken,
  axios,
  formatUserSessionOptions,
  getAdminUserId,
  getServerName,
} from '../helpers/synapse'

export type RcEmoji = {
  _id: string
  name: string
  aliases?: string[]
  extension: string
  _updatedAt: { $date: string }
}

export type MatrixImagePackImage = {
  url: string
  body?: string
  info?: {
    mimetype: string
    w?: number
    h?: number
    size?: number
  }
  usage?: string[]
}

export type MatrixImagePack = {
  images: { [key: string]: MatrixImagePackImage }
  pack?: {
    display_name?: string
    avatar_url?: string
    usage?: string[]
  }
}

const imagePack: MatrixImagePack = {
  images: {},
  pack: {
    display_name: process.env.EMOJI_PACK_NAME || 'vup',
    usage: ['emoticon', 'sticker'],
  },
}

// Track names of custom emojis we've successfully processed so other modules can consult them
export const customEmojiNames: Set<string> = new Set()

/**
 * Uploads an image file to the Matrix Media Repository
 * @param filePath Path to the local file
 * @param contentType MIME type of the file
 * @param accessToken Access token for the upload
 * @returns The MXC URI of the uploaded content
 */
async function uploadContent(
  filePath: string,
  contentType: string,
  accessToken: string
): Promise<string | null> {
  try {
    const fileData = fs.readFileSync(filePath)
    const response = await axios.post(
      '/_matrix/media/v3/upload',
      fileData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': contentType,
        },
        params: {
          filename: path.basename(filePath),
        },
      }
    )
    return response.data.content_uri
  } catch (error) {
    log.error(`Failed to upload ${filePath}: ${error}`)
    return null
  }
}

/**
 * Handle a Rocket.Chat custom emoji
 * @param rcEmoji The Rocket.Chat emoji object
 */
export async function handle(rcEmoji: RcEmoji): Promise<void> {
  const emojiName = rcEmoji.name
  const extension = rcEmoji.extension
  const filename = `${emojiName}.${extension}`
  // Assuming files are in inputs/fileupload/custom_emoji/ or similar, 
  // but user said "inputs/fileupload". We'll try to find it there.
  // Rocket.Chat often stores them by name or ID. We'll try name first.
  
  let filePath = path.join('./inputs/fileupload', filename)
  
  // If not found by name, maybe try ID? (Rocket.Chat usually uses name for custom emojis on disk if exported manually, 
  // but if it's from GridFS dump, it might be different. We'll assume name for now based on user description).
  
  if (!fs.existsSync(filePath)) {
    // Try finding by ID if name fails, just in case
    const idPath = path.join('./inputs/fileupload', `${rcEmoji._id}.${extension}`)
    if (fs.existsSync(idPath)) {
      filePath = idPath
    } else {
      log.warn(`Emoji file not found for ${emojiName}: ${filePath}`)
      return
    }
  }

  log.info(`Processing emoji: ${emojiName}`)

  const adminId = await getAdminUserId()
  const mxcUrl = await uploadContent(
    filePath,
    `image/${extension}`,
    adminAccessToken
  )

  if (mxcUrl) {
    imagePack.images[emojiName] = {
      url: mxcUrl,
      body: emojiName,
      info: {
        mimetype: `image/${extension}`,
      },
    }
    
    // Add aliases
    if (rcEmoji.aliases) {
      for (const alias of rcEmoji.aliases) {
        imagePack.images[alias] = {
          url: mxcUrl,
          body: alias,
          info: {
            mimetype: `image/${extension}`,
          },
        }
      }
    }
    // record the names (with colons) for reaction mapping
    customEmojiNames.add(`:${emojiName}:`)
    if (rcEmoji.aliases) {
      for (const alias of rcEmoji.aliases) {
        customEmojiNames.add(`:${alias}:`)
      }
    }
  }
}

/**
 * Finalizes the emoji import by saving the Image Pack to the admin user's account data
 */
export async function finalizeEmojis(): Promise<void> {
  if (Object.keys(imagePack.images).length === 0) {
    log.info('No emojis to import.')
    return
  }

  log.info(`Saving Image Pack with ${Object.keys(imagePack.images).length} emojis...`)
  
  const adminId = await getAdminUserId()
  const sessionOptions = formatUserSessionOptions(adminAccessToken)

  try {
    // Save as user account data (global for the user, often picked up by clients as "Personal Pack")
    // Using im.ponies.user_emotes is the legacy way, m.widgets or MSC2545 uses m.emote in room state.
    // For global server emojis, it's tricky. Usually we put them in a public room.
    // But putting them in Account Data of the admin is a good start for "Personal" pack.
    
    // We will save it to the admin's account data under `im.ponies.user_emotes` (FluffyChat/Element support this)
    await axios.put(
      `/_matrix/client/v3/user/${adminId}/account_data/im.ponies.user_emotes`,
      imagePack,
      sessionOptions
    )
    log.info('Successfully saved Image Pack to Admin Account Data (im.ponies.user_emotes)')

    // Add emojis to the #lounge room
    log.info('Adding emojis to #lounge room...')
    const loungeAlias = 'lounge'
    const serverName = await getServerName()
    const loungeRoomAlias = `#${loungeAlias}:${serverName}`

    try {
      // Resolve room alias to ID
      const resolveResponse = await axios.get(
        `/_matrix/client/v3/directory/room/${encodeURIComponent(loungeRoomAlias)}`,
        sessionOptions
      )
      const loungeRoomId = resolveResponse.data.room_id

      // Send state event to room (Legacy for FluffyChat)
      await axios.put(
        `/_matrix/client/v3/rooms/${loungeRoomId}/state/im.ponies.room_emotes`,
        imagePack,
        sessionOptions
      )
      
      // Send state event to room (Modern for Element / MSC2545)
      // Note: Element uses 'im.ponies.room_emotes' too in some versions, but 'm.emote' is the standard.
      // However, Element often looks for 'im.ponies.room_emotes' with a specific structure.
      // Let's also try adding it as 'io.element.ponies.room_emotes' which some Element versions used.
      
      await axios.put(
        `/_matrix/client/v3/rooms/${loungeRoomId}/state/io.element.ponies.room_emotes`,
        imagePack,
        sessionOptions
      )

      log.info(`Successfully added emojis to #lounge (${loungeRoomId})`)

    } catch (error: any) {
      if (error.response?.status === 404) {
        log.warn(`Room ${loungeRoomAlias} not found. Skipping emoji addition to lounge.`)
      } else {
        log.error(`Failed to add emojis to #lounge: ${error}`)
      }
    }

    // Create a global public room for emojis
    log.info('Creating global "Server Emojis" room...')
    const emojiRoomAlias = 'emojis'
    
    try {
      const createRoomResponse = await axios.post(
        '/_matrix/client/v3/createRoom',
        {
          preset: 'public_chat',
          name: 'Server Emojis',
          room_alias_name: emojiRoomAlias,
          topic: 'Global custom emojis from Rocket.Chat',
          initial_state: [
            {
              type: 'im.ponies.room_emotes',
              state_key: '',
              content: imagePack,
            },
            {
              type: 'io.element.ponies.room_emotes',
              state_key: '',
              content: imagePack,
            }
          ],
        },
        sessionOptions
      )
      log.info(`Successfully created Global Emoji Room: ${createRoomResponse.data.room_id}`)
      log.info(`Users can enable these emojis globally by joining #emojis:${await getServerName()}`)
    } catch (roomError: any) {
      if (roomError.response?.data?.errcode === 'M_ROOM_IN_USE') {
         log.warn('Emoji room alias already exists. Skipping creation.')
         // We could update the existing room here if needed
      } else {
         log.error(`Failed to create Emoji Room: ${roomError}`)
      }
    }

  } catch (error) {
    log.error(`Failed to save Image Pack: ${error}`)
  }
}


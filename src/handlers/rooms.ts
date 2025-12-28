import { AxiosError } from 'axios'
import { Entity, entities } from '../Entities'
import { IdMapping } from '../entity/IdMapping'
import log from '../helpers/logger'
import {
  createMembership,
  getMapping,
  getMappingByMatrixId,
  getMemberships,
  getRoomId,
  getUserId,
  save,
} from '../helpers/storage'
import {
  SessionOptions,
  axios,
  formatUserSessionOptions,
  getAsSessionOptions,
  getUserSessionOptions,
} from '../helpers/synapse'
import { RcUser, getUserMappings } from './users'

/**
 * Types of Rocket.Chat rooms
 */
export const enum RcRoomTypes {
  direct = 'd',
  chat = 'c',
  private = 'p',
  live = 'l',
}

/**
 * Type of Rocket.Chat rooms
 */
export type RcRoom = {
  _id: string
  t: RcRoomTypes
  usersCount?: number
  lastMessage?: { [key: string]: { [key: string]: string } }
  uids?: string[]
  usernames?: string[]
  name?: string
  u?: RcUser
  topic?: string
  fname?: string
  description?: string
}

/**
 * Presets of Matrix room permission settings
 */
export const enum MatrixRoomPresets {
  private = 'private_chat',
  public = 'public_chat',
  trusted = 'trusted_private_chat',
}

/**
 * Presets of Matrix room visibility settings
 */
export const enum MatrixRoomVisibility {
  private = 'private',
  public = 'public',
}

/**
 * Type of Matrix rooms
 */
export type MatrixRoom = {
  room_id?: string
  name?: string
  creation_content?: object
  room_alias_name?: string
  topic?: string
  is_direct?: boolean
  preset?: MatrixRoomPresets
  visibility?: MatrixRoomVisibility
}

/**
 * Parse channel mappings from environment variable
 * @returns A map of Rocket.Chat channel names to Matrix channel names
 */
function getChannelMappings(): Map<string, string> {
  const mappings = new Map<string, string>()
  const channelMappingsStr = process.env.CHANNEL_MAPPINGS || ''

  if (channelMappingsStr) {
    channelMappingsStr.split(',').forEach((mapping) => {
      const [rcName, matrixName] = mapping.split(':').map((s) => s.trim())
      if (rcName && matrixName) {
        mappings.set(rcName, matrixName)
      }
    })
  }

  return mappings
}

/**
 * Translate a Rocket.Chat room to a Matrix room
 * @param rcRoom The Rocket.Chat room to convert
 * @returns The Matrix room event body
 */
export function mapRoom(rcRoom: RcRoom): MatrixRoom {
  const room: MatrixRoom = {
    creation_content: {
      'm.federate': false,
    },
  }

  const channelMappings = getChannelMappings()

  if (rcRoom.fname || rcRoom.name) {
    // Determine the mapped channel name if it exists
    const mappedChannelName = rcRoom.name
      ? channelMappings.get(rcRoom.name)
      : undefined

    // Set room display name (prefer fname, but use mapped name if available and no fname)
    if (rcRoom.fname) {
      room.name = rcRoom.fname
    } else if (mappedChannelName) {
      room.name = mappedChannelName
    } else {
      room.name = rcRoom.name
    }

    // Set room alias name (this must be a valid Matrix alias)
    if (rcRoom.name) {
      room.room_alias_name = mappedChannelName || rcRoom.name
      if (mappedChannelName) {
        log.info(`Mapping channel ${rcRoom.name} to ${mappedChannelName}`)
      }
    }
  }

  const topics = [rcRoom.topic, rcRoom.description].filter(
    (t) => t && t.trim().length > 0
  )
  if (topics.length > 0) {
    room.topic = topics.join('\n')
  }

  switch (rcRoom.t) {
    case RcRoomTypes.direct:
      // For direct messages, do NOT set a room name (Matrix will show other participants)
      // EXCEPT for self-DMs (DMs with yourself) where we need to set a name
      // Also set name if there's an explicit fname (custom name)
      if (rcRoom.fname && !room.name) {
        room.name = rcRoom.fname
      } else if (
        rcRoom.usersCount === 1 &&
        rcRoom.usernames &&
        rcRoom.usernames.length === 1
      ) {
        // Self-DM: Set the username as the room name, with mapping applied
        const userMappings = getUserMappings()
        const mappedUsername =
          userMappings.get(rcRoom.usernames[0]) || rcRoom.usernames[0]
        room.name = mappedUsername
      } else {
        // Regular DM: Clear any name that might have been set earlier
        delete room.name
      }
      room.is_direct = true
      room.preset = MatrixRoomPresets.trusted
      break

    case RcRoomTypes.chat:
      room.preset = MatrixRoomPresets.public
      room.visibility = MatrixRoomVisibility.public
      break

    case RcRoomTypes.private:
      // Ensure private rooms have a name, even if empty
      if (!room.name || room.name.trim().length === 0) {
        room.name = rcRoom.name || `Private Room (${rcRoom._id})`
      }
      room.preset = MatrixRoomPresets.private
      room.visibility = MatrixRoomVisibility.private
      break

    case RcRoomTypes.live: {
      const messageLivechat = `Room ${
        rcRoom.name || 'with ID: ' + rcRoom._id
      } is a live chat. Migration not implemented`
      log.warn(messageLivechat)
      throw new Error(messageLivechat)
    }

    default: {
      const messageUnknownRoom = `Room ${
        rcRoom.name || 'with ID: ' + rcRoom._id
      } is of type ${rcRoom.t}, which is unknown or unimplemented`
      log.error(messageUnknownRoom)
      throw new Error(messageUnknownRoom)
    }
  }
  return room
}

/**
 * Return the ID of the room creator, depending on room type
 * @param rcRoom The Rocket.Chat room object
 * @returns The Rocket.Chat ID of the creator or empty string
 */
export function getCreator(rcRoom: RcRoom): string {
  if (rcRoom.u && rcRoom.u._id) {
    return rcRoom.u._id
  } else if (rcRoom.uids && rcRoom.uids.length >= 1) {
    return rcRoom.uids[0]
  } else {
    log.warn(
      `Creator ID could not be determined for room ${rcRoom.name} of type ${rcRoom.t}. This is normal for the default room. Using admin user.`
    )
    return ''
  }
}

/**
 * Wrapper function for membership creations for direct chats
 * @param rcRoom The Rocket.Chat room object
 */
export async function createDirectChatMemberships(
  rcRoom: RcRoom
): Promise<void> {
  if (rcRoom.t == RcRoomTypes.direct && rcRoom.uids) {
    await Promise.all(
      [...new Set(rcRoom.uids)] // Deduplicate users
        .map(async (uid) => {
          await createMembership(rcRoom._id, uid)
          log.debug(`${uid} membership in direct chat ${rcRoom._id} created`)
        })
    )
  }
}

/**
 * Get user credentials for Axios
 * @param creatorId The Rocket.Chat ID of the room creator
 * @returns A SessionOptions or empty object
 * @deprecated This has a high similarity with other functions, it might be replaced
 */
export async function getCreatorSessionOptions(
  creatorId: string
): Promise<SessionOptions | object> {
  if (creatorId) {
    try {
      const matrixUserId = await getUserId(creatorId)
      if (matrixUserId) {
        return getAsSessionOptions(matrixUserId)
      }
      const creatorSessionOptions = await getUserSessionOptions(creatorId)
      log.debug('Room owner session generated:', creatorSessionOptions)
      return creatorSessionOptions
    } catch (error) {
      log.warn(error)
    }
  }
  return {}
}

/**
 * Get the room ID for an existing room alias
 * @param roomAlias The room alias (without the # prefix or server name)
 * @returns The Matrix room ID if it exists, otherwise null
 */
async function getRoomIdByAlias(roomAlias: string): Promise<string | null> {
  try {
    const serverName =
      process.env.SYNAPSE_SERVER_NAME ||
      new URL(process.env.SYNAPSE_URL || 'http://localhost:8008').hostname
    const fullAlias = `#${roomAlias}:${serverName}`
    const response = await axios.get(
      `/_matrix/client/v3/directory/room/${encodeURIComponent(fullAlias)}`
    )
    return response.data.room_id
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 404) {
      return null
    }
    throw error
  }
}

/**
 * Send a request to Synapse, creating the room
 * @param matrixRoom The Matrix room object to create
 * @param creatorSessionOptions The credentials of the room creator
 * @returns The Matrix room ID
 */
export async function registerRoom(
  matrixRoom: MatrixRoom,
  creatorSessionOptions: SessionOptions | object
): Promise<string> {
  try {
    return (
      await axios.post(
        '/_matrix/client/v3/createRoom',
        matrixRoom,
        creatorSessionOptions
      )
    ).data.room_id
  } catch (error) {
    if (
      error instanceof AxiosError &&
      error.response?.status === 400 &&
      error.response?.data?.errcode === 'M_ROOM_IN_USE' &&
      matrixRoom.room_alias_name
    ) {
      log.info(
        `Room alias ${matrixRoom.room_alias_name} already exists, using existing room`
      )
      const existingRoomId = await getRoomIdByAlias(matrixRoom.room_alias_name)
      if (existingRoomId) {
        return existingRoomId
      }
    }
    throw error
  }
}

/**
 * Send events to Synapse, inviting users to a room. Already participating users will not cause problems.
 * @param inviteeId The Matrix ID of the invited user
 * @param roomId The Matrix ID of the room
 * @param creatorSessionOptions The credentials of the room creator
 */
export async function inviteMember(
  inviteeId: string,
  roomId: string,
  creatorSessionOptions: SessionOptions | object
): Promise<void> {
  log.http(`Invite member ${inviteeId}`)
  try {
    await axios.post(
      `/_matrix/client/v3/rooms/${roomId}/invite`,
      { user_id: inviteeId },
      creatorSessionOptions
    )
  } catch (error) {
    if (
      error instanceof AxiosError &&
      error.response &&
      error.response.data.errcode === 'M_FORBIDDEN' &&
      error.response.data.error === `${inviteeId} is already in the room.`
    ) {
      log.debug(
        `User ${inviteeId} is already in room ${roomId}, probably because this user created the room as a fallback.`
      )
    } else if (
      error instanceof AxiosError &&
      error.response &&
      error.response.data.errcode === 'M_FORBIDDEN' &&
      error.response.data.error.includes(`not in room ${roomId}.`)
    ) {
      log.warn(
        `Creator is not in room ${roomId}, skipping invitation for ${inviteeId}.`
      )
    } else {
      throw error
    }
  }
}

/**
 * Send events to Synapse, accepting an invitation to a room
 * @param inviteeMapping The IDMapping of the invited user
 * @param roomId The Matrix ID of the room
 */
export async function acceptInvitation(
  inviteeMapping: IdMapping,
  roomId: string
): Promise<void> {
  log.http(
    `Accepting invitation for member ${inviteeMapping.rcId} aka. ${inviteeMapping.matrixId}`
  )
  let sessionOptions = formatUserSessionOptions(
    inviteeMapping.accessToken || ''
  )
  if (inviteeMapping.matrixId) {
    try {
      sessionOptions = getAsSessionOptions(inviteeMapping.matrixId)
    } catch (e) {
      // Ignore if AS token not set
    }
  }
  await axios.post(`/_matrix/client/v3/join/${roomId}`, {}, sessionOptions)
}

/**
 * Filter out the room creator and non-existent users.
 * Users are non-existent, if they have no mapping, like when they are
 * excluded or have been deleted.
 * @param rcMemberIds An array of Rocket.Chat user IDs
 * @param creatorId The Rocket.Chat user ID of the room creator
 * @returns A filtered array of IdMappings
 */
export async function getFilteredMembers(
  rcMemberIds: string[],
  creatorId: string
): Promise<IdMapping[]> {
  const memberMappings = (
    await Promise.all(
      rcMemberIds
        .filter((rcMemberId) => rcMemberId != creatorId)
        .map(async (rcMemberId) => await getMapping(rcMemberId, 0))
    )
  ).filter((memberMapping): memberMapping is IdMapping => memberMapping != null)
  return memberMappings
}

/**
 * Save an ID mapping in the local database
 * @param rcId Rocket.Chat room ID
 * @param matrixId Matrix room ID
 */
export async function createMapping(
  rcId: string,
  matrixId: string
): Promise<void> {
  const roomMapping = new IdMapping()
  roomMapping.rcId = rcId
  roomMapping.matrixId = matrixId
  roomMapping.type = entities[Entity.Rooms].mappingType

  await save(roomMapping)
  log.debug('Mapping added:', roomMapping)
}

/**
 * Create a Matrix room from a Rocket.Chat room object and handle it's memberships
 * @param rcRoom The Rocket.Chat room object
 * @returns The Matrix room object, including it's ID
 */
export async function createRoom(rcRoom: RcRoom): Promise<MatrixRoom> {
  const room: MatrixRoom = mapRoom(rcRoom)
  const creatorId = getCreator(rcRoom)
  await createDirectChatMemberships(rcRoom)
  const creatorSessionOptions = await getCreatorSessionOptions(creatorId)
  log.debug('Creating room:', room)

  room.room_id = await registerRoom(room, creatorSessionOptions)

  await handleMemberships(rcRoom._id, room, creatorId, creatorSessionOptions)

  return room
}

/**
 * Create memberships for a room
 * @param rcRoomId The Rocket.Chat room ID
 * @param room The Matrix room object
 * @param creatorId The Rocket.Chat room creator ID
 * @param creatorSessionOptions The credentials of the room creator
 */
async function handleMemberships(
  rcRoomId: string,
  room: MatrixRoom,
  creatorId: string,
  creatorSessionOptions: object | SessionOptions
) {
  const rcMemberIds = await getMemberships(rcRoomId)
  const memberMappings = await getFilteredMembers(rcMemberIds, creatorId)
  log.info(
    `Inviting members to room ${
      room.room_alias_name || room.name || room.room_id
    }:`,
    memberMappings.map((mapping) => mapping.matrixId)
  )
  log.debug(
    'Excluded members:',
    rcMemberIds.filter(
      (x) => !memberMappings.map((mapping) => mapping.rcId).includes(x)
    )
  )

  await Promise.all(
    memberMappings.map(async (memberMapping) => {
      await addMember(memberMapping, room.room_id || '', creatorSessionOptions)
    })
  )
}

/**
 * Wrapper function to invite users to a room and make them join
 * @param memberMapping The IdMapping of the user to join
 * @param matrixRoomId The Matrix room ID
 * @param creatorSessionOptions The credentials of the inviting user
 */
export async function addMember(
  memberMapping: IdMapping,
  matrixRoomId: string,
  creatorSessionOptions: object | SessionOptions
) {
  await inviteMember(
    memberMapping.matrixId || '',
    matrixRoomId,
    creatorSessionOptions
  )
  await acceptInvitation(memberMapping, matrixRoomId)
}

/**
 * Execute the wrapped function, handling errors of members missing in rooms by adding them and repeating the function.
 * @param fn The function to execute, preferably wrapped
 * @returns void
 * @throws Other errors than "User not in room"
 * @example executeAndHandleMissingMember(() => myFunc('parameter1', 'parameter2'))
 */
export async function executeAndHandleMissingMember(
  fn: () => Promise<void>
): Promise<void> {
  const regEx: RegExp =
    /^User (?<matrixUserId>@.+) not in room (?<matrixRoomId>!.+)$/
  try {
    await fn()
  } catch (error) {
    if (
      error instanceof AxiosError &&
      error.response &&
      error.response.data.errcode === 'M_FORBIDDEN' &&
      error.response.data.error &&
      regEx.test(error.response.data.error)
    ) {
      log.info(`${error.response.data.error}, adding.`)

      const { matrixUserId, matrixRoomId } =
        error.response.data.error.match(regEx).groups

      const userMapping = await getMappingByMatrixId(matrixUserId)
      if (!userMapping || !userMapping.matrixId || !userMapping.accessToken) {
        log.warn(`Could not determine joining user ${matrixUserId}, skipping.`)
        return
      }

      // Get room creator session or use empty axios options
      let userSessionOptions = {}
      const roomCreatorId = (
        await axios.get(`/_synapse/admin/v1/rooms/${matrixRoomId}`)
      ).data.creator
      if (!roomCreatorId) {
        log.warn(
          `Could not determine room creator for room ${matrixRoomId}, using admin credentials.`
        )
      } else {
        const creatorMapping = await getMappingByMatrixId(roomCreatorId)
        if (!creatorMapping?.accessToken) {
          log.warn(`Could not get access token for ${roomCreatorId}, skipping.`)
          return
        }
        userSessionOptions = formatUserSessionOptions(
          creatorMapping.accessToken
        )
      }

      await addMember(userMapping, matrixRoomId, userSessionOptions)
      await fn()
    } else {
      throw error
    }
  }
}

/**
 * Handle a line of a Rocket.Chat room JSON export
 * @param rcRoom A Rocket.Chat room object
 */
export async function handle(rcRoom: RcRoom): Promise<void> {
  const includedRooms = (process.env.INCLUDED_ROOMS || '')
    .split(',')
    .map((room) => room.trim())
    .filter((room) => room !== '')

  if (includedRooms.length > 0) {
    const isIncludedByNameOrId =
      includedRooms.includes(rcRoom.name || '') ||
      includedRooms.includes(rcRoom._id)

    let isIncludedByUsernames = false
    if (rcRoom.t === RcRoomTypes.direct && rcRoom.usernames) {
      const roomUsernames = rcRoom.usernames.sort().join(';')
      isIncludedByUsernames = includedRooms.some((includedRoom) => {
        const includedUsernames = includedRoom.split(';').sort().join(';')
        return includedUsernames === roomUsernames
      })
    }

    if (!isIncludedByNameOrId && !isIncludedByUsernames) {
      return
    }
  }

  log.info(`Parsing room ${rcRoom.name || 'with ID: ' + rcRoom._id}`)

  const matrixRoomId = await getRoomId(rcRoom._id)
  if (matrixRoomId) {
    log.debug(`Mapping exists: ${rcRoom._id} -> ${matrixRoomId}`)
    const room = mapRoom(rcRoom)
    if (room.topic) {
      const creatorId = getCreator(rcRoom)
      const creatorSessionOptions = await getCreatorSessionOptions(creatorId)
      try {
        await axios.put(
          `/_matrix/client/v3/rooms/${matrixRoomId}/state/m.room.topic`,
          { topic: room.topic },
          creatorSessionOptions
        )
        log.debug(`Updated topic for room ${matrixRoomId}`)
      } catch (error) {
        // Ignore errors, e.g. if the user is not in the room anymore
      }
    }
  } else {
    const matrixRoom = await createRoom(rcRoom)
    await createMapping(rcRoom._id, matrixRoom.room_id!)
  }
}

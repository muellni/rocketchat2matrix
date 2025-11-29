import fs from 'fs'
import path from 'path'
import lineByLine from 'n-readlines'
import { axios, formatUserSessionOptions, adminAccessToken } from '../helpers/synapse'
import log from '../helpers/logger'
import { getMapping } from '../helpers/storage'
import { Entity, entities } from '../Entities'

interface AvatarEntry {
  _id: string
  userId?: string
  rid?: string
  type: string
  path?: string
  uid?: string
}

/**
 * Uploads an avatar to the Matrix Media Repository
 * @param filePath Path to the local file
 * @param contentType MIME type of the file
 * @param accessToken Access token for the upload
 * @returns The MXC URI of the uploaded content
 */
async function uploadAvatar(
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
    log.error(`Failed to upload avatar ${filePath}: ${error}`)
    return null
  }
}

/**
 * Sets the avatar for a Matrix user
 * @param userId The Matrix user ID
 * @param mxcUrl The MXC URI of the avatar
 * @param accessToken The user's access token
 */
async function setUserAvatar(
  userId: string,
  mxcUrl: string,
  accessToken: string
): Promise<void> {
  try {
    await axios.put(
      `/_matrix/client/v3/profile/${userId}/avatar_url`,
      { avatar_url: mxcUrl },
      formatUserSessionOptions(accessToken)
    )
    log.info(`Avatar set for user ${userId}`)
  } catch (error) {
    log.error(`Failed to set avatar for user ${userId}: ${error}`)
  }
}

/**
 * Sets the avatar for a Matrix room
 * @param roomId The Matrix room ID
 * @param mxcUrl The MXC URI of the avatar
 * @param accessToken The access token to use for the request
 */
async function setRoomAvatar(
  roomId: string,
  mxcUrl: string,
  accessToken: string
): Promise<void> {
  try {
    await axios.put(
      `/_matrix/client/v3/rooms/${roomId}/state/m.room.avatar`,
      { url: mxcUrl },
      formatUserSessionOptions(accessToken)
    )
    log.info(`Avatar set for room ${roomId}`)
  } catch (error) {
    log.error(`Failed to set avatar for room ${roomId}: ${error}`)
  }
}

export async function handleAvatars() {
  log.info('Starting avatar migration')
  const avatarJsonPath = path.join(process.cwd(), 'inputs', 'rocketchat_avatars.json')
  
  if (!fs.existsSync(avatarJsonPath)) {
    log.warn('No rocketchat_avatars.json found, skipping avatar migration')
    return
  }

  const rl = new lineByLine(avatarJsonPath)
  let line: false | Buffer

  while ((line = rl.next())) {
    const entry = JSON.parse(line.toString()) as AvatarEntry
    const avatarPath = path.join(process.cwd(), 'inputs', 'fileupload', entry._id)

    if (!fs.existsSync(avatarPath)) {
      log.warn(`Avatar file missing for entry ${entry._id}`)
      continue
    }

    if (entry.userId) {
      // Handle User Avatar
      const mapping = await getMapping(entry.userId, entities[Entity.Users].mappingType)
      if (mapping && mapping.matrixId && mapping.accessToken) {
        log.info(`Processing avatar for user ${entry.userId} -> ${mapping.matrixId}`)
        const mxcUrl = await uploadAvatar(avatarPath, entry.type, mapping.accessToken)
        if (mxcUrl) {
          await setUserAvatar(mapping.matrixId, mxcUrl, mapping.accessToken)
        }
      } else {
        log.debug(`No mapping found for user ${entry.userId}, skipping avatar`)
      }
    } else if (entry.rid) {
      // Handle Room Avatar
      const mapping = await getMapping(entry.rid, entities[Entity.Rooms].mappingType)
      if (mapping && mapping.matrixId) {
        log.info(`Processing avatar for room ${entry.rid} -> ${mapping.matrixId}`)
        
        let accessToken = adminAccessToken
        if (entry.uid) {
            const userMapping = await getMapping(entry.uid, entities[Entity.Users].mappingType)
            if (userMapping && userMapping.accessToken) {
                accessToken = userMapping.accessToken
            }
        }

        if (accessToken) {
             const mxcUrl = await uploadAvatar(avatarPath, entry.type, accessToken)
             if (mxcUrl) {
                 // If we are using admin token, we might need to join. If creator, they are already in.
                 if (accessToken === adminAccessToken) {
                      try {
                        await axios.post(
                          `/_matrix/client/v3/rooms/${mapping.matrixId}/join`,
                          {},
                          formatUserSessionOptions(accessToken)
                        )
                      } catch (e) {
                        log.warn(`Failed to join room ${mapping.matrixId} as admin: ${e}`)
                      }
                 }
                 await setRoomAvatar(mapping.matrixId, mxcUrl, accessToken)
             }
        } else {
            log.warn('No access token available for room avatar upload')
        }

      } else {
        log.debug(`No mapping found for room ${entry.rid}, skipping avatar`)
      }
    }
  }
  log.info('Avatar migration finished')
}

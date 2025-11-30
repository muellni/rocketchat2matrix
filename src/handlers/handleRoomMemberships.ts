import { Entity, entities } from '../Entities'
import log from '../helpers/logger'
import {
  getAllMappingsByType,
  getMappingByMatrixId,
  getMemberships,
} from '../helpers/storage'
import {
  axios,
  formatUserSessionOptions,
  getMatrixMembers,
  getAsSessionOptions,
} from '../helpers/synapse'
import adminTokenConfig from '../config/synapse_access_token.json'
import { getFilteredMembers } from './rooms'

/**
 * Remove all excess Matrix room members, which are not part of the Rocket.Chat room and not an admin
 * Set the room read status to "read all" for others
 */
export async function handleRoomMemberships() {
  const roomMappings = await getAllMappingsByType(
    entities[Entity.Rooms].mappingType
  )
  if (!roomMappings) {
    throw new Error(`No room mappings found`)
  }

  for (const roomMapping of roomMappings) {
      log.info(
        `Checking memberships for room ${roomMapping.rcId} / ${roomMapping.matrixId}`
      )
      // get all memberships from db
      const rcMemberIds = await getMemberships(roomMapping.rcId)
      const memberMappings = await getFilteredMembers(rcMemberIds, '')
      const memberNames: string[] = memberMappings.map(
        (memberMapping) => memberMapping.matrixId || ''
      )

      // get each mx rooms' mx users
      const actualMembers: string[] = await getMatrixMembers(
        roomMapping.matrixId || ''
      )

      // do action for any user in mx, but not in rc
      const adminUsername = process.env.ADMIN_USERNAME || ''
      await Promise.all(
        actualMembers.map(async (actualMember) => {
          let userSessionOptions = {}
          // Determine if this actual member is the configured admin user.
          const adminMatrixUserId = adminTokenConfig?.user_id || ''
          const isAdmin =
            (adminUsername && actualMember.includes(adminUsername)) ||
            (adminMatrixUserId && actualMember === adminMatrixUserId)

          // set session options for non-admins
          if (!isAdmin) {
            const memberMapping = await getMappingByMatrixId(actualMember)
            if (!memberMapping || !memberMapping.accessToken) {
              throw new Error(
                `Could not find access token for member ${actualMember}, this is a bug`
              )
            }
            userSessionOptions = formatUserSessionOptions(
              memberMapping.accessToken
            )
          }

          if (!memberNames.includes(actualMember) && !isAdmin) {
            // remove excess members from rooms
            log.warn(
              `Member ${actualMember} should not be in room ${roomMapping.matrixId}, removing`
            )

            // Try to have the user leave using their session token with retries
            const leaveUrl = `/_matrix/client/v3/rooms/${roomMapping.matrixId}/leave`
            const maxRetries = 3
            let attempt = 0
            let left = false
            while (attempt < maxRetries && !left) {
              attempt++
              try {
                await axios.post(leaveUrl, {}, userSessionOptions)
                left = true
                break
              } catch (leaveError: any) {
                const waitMs = 250 * attempt
                log.warn(
                  `Attempt ${attempt} to leave room failed for ${actualMember}: ${leaveError?.message || leaveError}. Retrying in ${waitMs}ms...`
                )
                await new Promise((r) => setTimeout(r, waitMs))
              }
            }

            if (left) {
              log.info(`Member ${actualMember} left room ${roomMapping.matrixId}`)
            } else {
              log.warn(
                `User leave failed after ${maxRetries} attempts for ${actualMember}`
              )
              // No AS fallback: give up after retries and leave the member in the room
            }
          } else {
            // set read status for allowed members
            const lastMessages = (
              await axios.get(
                `/_matrix/client/v3/rooms/${roomMapping.matrixId}/messages`,
                {
                  ...userSessionOptions,
                  params: {
                    ts: Date.now(),
                    dir: 'b', // direction: backwards, getting latest event first
                    limit: 1, // getting only the latest event
                    filter: { types: ['m.room.message'] }, // getting only message events
                  },
                }
              )
            ).data
            if (
              lastMessages.chunk.length == 0 ||
              !lastMessages.chunk[0].event_id
            ) {
              log.info(
                `No messages in room ${roomMapping.matrixId}, skipping setting read status for ${actualMember}`
              )
            } else {
              log.info(
                `Member ${actualMember} is allowed in room ${roomMapping.matrixId}, setting read status for message ${lastMessages.chunk[0].event_id}`
              )
              // Try to post the read-receipt with retries to handle transient errors
              const receiptUrl = `/_matrix/client/v3/rooms/${roomMapping.matrixId}/receipt/m.read/${lastMessages.chunk[0].event_id}`
              const maxReceiptRetries = 3
              let receiptAttempt = 0
              let receiptOk = false
              while (receiptAttempt < maxReceiptRetries && !receiptOk) {
                receiptAttempt++
                try {
                  await axios.post(receiptUrl, {}, userSessionOptions)
                  receiptOk = true
                } catch (receiptError: any) {
                  const waitMs = 200 * receiptAttempt
                  log.warn(
                    `Attempt ${receiptAttempt} to set read receipt failed for ${actualMember} in ${roomMapping.matrixId}: ${receiptError?.message || receiptError}. Retrying in ${waitMs}ms...`
                  )
                  await new Promise((r) => setTimeout(r, waitMs))
                }
              }
              if (!receiptOk) {
                log.warn(
                  `Failed to set read receipt for ${actualMember} in ${roomMapping.matrixId} after ${maxReceiptRetries} attempts`
                )
              }
            }
          }
        })
      )
    }
}

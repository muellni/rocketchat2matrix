import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { Entity, entities } from '../Entities'
import log from '../helpers/logger'
import { IdMapping } from '../entity/IdMapping'
import { getRoomId, save, getAccessToken } from '../helpers/storage'
import { axios, formatUserSessionOptions } from '../helpers/synapse'

export type RcUpload = {
  _id: string
  name: string
  size: number
  type: string
  rid: string
  store: string
  extension?: string
  path: string
  url: string
  userId: string
}

export async function handle(upload: RcUpload): Promise<void> {
  // Check if the room is migrated
  const matrixRoomId = await getRoomId(upload.rid)
  if (!matrixRoomId) {
    // Room not migrated, so we skip the upload
    return
  }

  const baseDir = join(__dirname, '../../inputs/fileupload')
  let filePath = join(baseDir, `${upload._id}.${upload.extension}`)

  if (!existsSync(filePath)) {
    // Try without extension
    const filePathNoExt = join(baseDir, upload._id)
    if (existsSync(filePathNoExt)) {
      filePath = filePathNoExt
    } else {
      log.warn(`File not found for upload ${upload._id}: ${filePath} (also tried ${filePathNoExt})`)
      return
    }
  }
  
  log.debug(`Processing upload ${upload._id}: ${filePath}`)

  const fileContent = readFileSync(filePath)

  // Determine who uploads the file
  let headers = {}
  try {
    const accessToken = await getAccessToken(upload.userId)
    if (accessToken) {
      headers = formatUserSessionOptions(accessToken).headers
    }
  } catch (e) {
    // Ignore error, use default headers (admin)
  }

  // Upload to Matrix
  try {
    const response = await axios.post('/_matrix/media/v3/upload', fileContent, {
      headers: {
        ...headers,
        'Content-Type': upload.type,
        'Content-Length': fileContent.length,
      },
      params: {
        filename: upload.name,
      },
    })

    const contentUri = response.data.content_uri
    
    // Save mapping
    const mapping = new IdMapping()
    mapping.rcId = upload._id
    mapping.matrixId = contentUri
    mapping.type = entities[Entity.Uploads].mappingType
    await save(mapping)
    
    log.info(`Uploaded ${upload.name} (${upload._id}) to ${contentUri}`)
  } catch (error: any) {
    // If upload failed with user token, try with admin token
    if (Object.keys(headers).length > 0) {
      log.warn(`Failed to upload ${upload._id} as user ${upload.userId}, retrying as admin...`)
      try {
        const response = await axios.post('/_matrix/media/v3/upload', fileContent, {
          headers: {
            'Content-Type': upload.type,
            'Content-Length': fileContent.length,
          },
          params: {
            filename: upload.name,
          },
        })

        const contentUri = response.data.content_uri
        
        // Save mapping
        const mapping = new IdMapping()
        mapping.rcId = upload._id
        mapping.matrixId = contentUri
        mapping.type = entities[Entity.Uploads].mappingType
        await save(mapping)
        
        log.info(`Uploaded ${upload.name} (${upload._id}) as admin to ${contentUri}`)
        return
      } catch (adminError: any) {
        log.error(`Failed to upload ${upload._id} as admin: ${adminError.message}`, adminError.response?.data)
      }
    }
    log.error(`Failed to upload ${upload._id}: ${error.message}`, error.response?.data)
  }
}

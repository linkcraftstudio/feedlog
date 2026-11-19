// Register the existing S3-compatible provider on Node / Docker.
import { consola } from 'consola'
import { createConfiguredS3Storage } from '../storage'

const logger = consola.withTag('blob')
export default defineNitroPlugin(() => {
  const storage = createConfiguredS3Storage()
  if (!storage) {
    if (process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY && process.env.S3_BUCKET) logger.warn('S3 disabled: set S3_REGION (for AWS) or S3_ENDPOINT (for R2/MinIO/OSS)')
    return
  }
  registerBlobProvider({ name: 's3', storage })
  logger.info('Registered blob provider: s3')
})

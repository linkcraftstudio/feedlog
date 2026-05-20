// S3-compatible blob provider — registers when S3_* env vars are set.
// Uses NuxtHub's own driver factory so behavior is identical to a
// build-time-baked S3 image. Falls back to the nuxthub default
// (registered by feedlog's main blob.ts plugin) when S3_* are absent.

import { createBlobStorage } from '@nuxthub/core/blob'
import { createDriver } from '@nuxthub/core/blob/drivers/s3'
import { consola } from 'consola'

const logger = consola.withTag('blob')

function isBucketEndpoint(endpoint: string | undefined, bucket: string) {
  if (!endpoint) return false
  try {
    const hostname = new URL(endpoint).hostname
    return hostname === bucket || hostname.startsWith(`${bucket}.`)
  }
  catch {
    return false
  }
}

export default defineNitroPlugin(() => {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY
  const bucket = process.env.S3_BUCKET
  if (!accessKeyId || !secretAccessKey || !bucket) return

  const endpoint = process.env.S3_ENDPOINT || undefined
  const region = process.env.S3_REGION || undefined

  // NuxtHub's s3 driver builds the URL as `https://${bucket}.s3.${region}.amazonaws.com`
  // when no endpoint is given, so a missing region on a non-AWS service
  // would yield a literal `undefined` in the host. Refuse to register.
  if (!endpoint && !region) {
    logger.warn('S3 disabled: set S3_REGION (for AWS) or S3_ENDPOINT (for R2/MinIO/OSS)')
    return
  }

  const endpointIncludesBucket = isBucketEndpoint(endpoint, bucket)
  const storage = createBlobStorage(createDriver({
    accessKeyId,
    secretAccessKey,
    bucket: endpointIncludesBucket ? '' : bucket,
    region,
    endpoint,
  }))

  registerBlobProvider({ name: 's3', storage })
  logger.info(`Registered blob provider: s3 (bucket=${bucket}${endpoint ? `, endpoint=${endpoint}` : ''}${endpointIncludesBucket ? ', bucketEndpoint=true' : ''})`)
})

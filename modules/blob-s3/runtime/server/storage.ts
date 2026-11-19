import { createBlobStorage } from '@nuxthub/core/blob'
import { createDriver } from '@nuxthub/core/blob/drivers/s3'

// Shared configuration for the existing S3 blob provider.
export function createConfiguredS3Storage() {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID, secretAccessKey = process.env.S3_SECRET_ACCESS_KEY, bucket = process.env.S3_BUCKET
  const endpoint = process.env.S3_ENDPOINT || undefined, region = process.env.S3_REGION || undefined
  if (!accessKeyId || !secretAccessKey || !bucket || (!endpoint && !region)) return
  let bucketEndpoint = false
  try { const host = new URL(endpoint!).hostname; bucketEndpoint = host === bucket || host.startsWith(`${bucket}.`) } catch { /* AWS uses the region endpoint. */ }
  return createBlobStorage(createDriver({ accessKeyId, secretAccessKey, bucket: bucketEndpoint ? '' : bucket, endpoint, region }))
}

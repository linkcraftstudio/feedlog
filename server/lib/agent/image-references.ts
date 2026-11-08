import type { H3Event } from 'h3'
import { withDependencyTimeout } from './dependency-timeout'
import { validateAgentImage } from './images'
import type { ImageLoader, ImageReference } from './image-batches'
import { CHAT_IMAGE_MAX_BYTES, ChatImageError } from '../../../shared/agent/images'

export async function imageReference(event: H3Event, orgId: string, key: string, index: number, signal: AbortSignal): Promise<ImageReference> {
  const prefix = useRuntimeConfig(event).public.uploadPrefix
  // Storage drivers decode paths. Reject encoded traversal before applying tenant ownership.
  if (decodeURIComponent(key) !== key || !key.startsWith(`${prefix}/${orgId}/`) || key.split('/').includes('..')) throw new ChatImageError('image_unavailable')
  const meta = await withDependencyTimeout(() => blobStorage.head(key), signal, 15_000)
  if (!meta || !meta.contentType?.startsWith('image/')) throw new ChatImageError('image_invalid')
  if (typeof meta.size !== 'number' || !Number.isSafeInteger(meta.size) || meta.size <= 0 || meta.size > CHAT_IMAGE_MAX_BYTES) throw new ChatImageError('image_too_large')
  return { index, key, bytes: meta.size, etag: meta.httpEtag ?? '' }
}

export const loadImageReference: ImageLoader = async (reference, signal) => {
  signal.throwIfAborted()
  // Uploads use unique, immutable keys. Recheck the version and size before any body read.
  const meta = await blobStorage.head(reference.key)
  signal.throwIfAborted()
  if (meta.size !== reference.bytes || (meta.httpEtag ?? '') !== reference.etag) throw new ChatImageError('image_unavailable')
  const body = await blobStorage.driver.getArrayBuffer(reference.key)
  signal.throwIfAborted()
  if (!body || body.byteLength !== reference.bytes) throw new ChatImageError('image_unavailable')
  const bytes = Buffer.from(body)
  const mime = validateAgentImage(bytes)
  return { index: reference.index, bytes: bytes.length, data: `data:${mime};base64,${bytes.toString('base64')}` }
}

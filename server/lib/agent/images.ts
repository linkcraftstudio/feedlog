import { imageMeta } from 'image-meta'
import { CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MAX_EDGE, ChatImageError } from '../../../shared/agent/images'

export function validateAgentImage(bytes: Uint8Array) {
  if (!bytes.byteLength) throw new ChatImageError('image_invalid')
  if (bytes.byteLength > CHAT_IMAGE_MAX_BYTES) throw new ChatImageError('image_too_large')
  let meta: ReturnType<typeof imageMeta>
  try { meta = imageMeta(bytes) } catch { throw new ChatImageError('image_unsupported') }
  const mime = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[meta.type ?? '']
  if (!mime) throw new ChatImageError('image_unsupported')
  if (!meta.width || !meta.height) throw new ChatImageError('image_invalid')
  if (Math.max(meta.width, meta.height) > CHAT_IMAGE_MAX_EDGE) throw new ChatImageError('image_too_large')
  return mime
}

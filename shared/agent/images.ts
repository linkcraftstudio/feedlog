export const CHAT_IMAGE_MAX_COUNT = 10
export const CHAT_IMAGE_MAX_BYTES = 16 * 1024 * 1024
export const CHAT_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024
export const CHAT_IMAGE_MAX_EDGE = 4096
export const CHAT_IMAGE_INPUT_BYTES = 32 * 1024 * 1024
export const CHAT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type ChatImageErrorCode = 'image_unsupported' | 'image_invalid' | 'image_too_large' | 'image_total_too_large' | 'image_unavailable'
export class ChatImageError extends Error {
  constructor(public code: ChatImageErrorCode) { super(code) }
}

// New messages are bounded independently from historical stored attachments.
export const CHAT_IMAGE_UPLOAD_BYTES = 2 * 1024 * 1024
export const CHAT_IMAGE_TARGET_BYTES = 1024 * 1024
export const CHAT_IMAGE_STANDARD_EDGE = 2048
export function validateNewImageBudget(sizes: number[]): void {
  if (sizes.length > CHAT_IMAGE_MAX_COUNT || sizes.some(size => !Number.isSafeInteger(size) || size <= 0 || size > CHAT_IMAGE_UPLOAD_BYTES)) throw new ChatImageError('image_too_large')
  if (sizes.reduce((total, size) => total + size, 0) > CHAT_IMAGE_TOTAL_BYTES) throw new ChatImageError('image_total_too_large')
}

import { ChatImageError } from '../../../shared/agent/images'

// Provider text is used only to classify failures, never returned to the customer or logged.
export function imageExecutionError(error: unknown): ChatImageError | undefined {
  if (error instanceof ChatImageError) return error
  const value = error as { message?: string; error?: unknown; cause?: unknown } | null
  const nested = value?.error ?? value?.cause
  if (nested && nested !== error) {
    const match = nested instanceof ChatImageError ? nested : undefined
    if (match) return match
  }
  const message = [value?.message, (nested as { message?: string } | null)?.message].filter(Boolean).join(' ')
  if (!/image/i.test(message)) return
  if (/too large|size limit|exceed.*(?:size|bytes|mb|pixels)|image.*dimensions/i.test(message)) return new ChatImageError('image_too_large')
  if (/unsupported|invalid|format|decode|corrupt|could not.*image|unable to.*image/i.test(message)) return new ChatImageError('image_invalid')
}

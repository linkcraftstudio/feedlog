import type { ImageBatchLimits } from './image-batches'

export function imageBatchLimits(): ImageBatchLimits {
  const limit = (name: string, fallback: number, minimum: number, maximum: number) => {
    const raw = process.env[name]
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`)
    return value
  }
  return {
    maxImages: limit('AGENT_IMAGE_BATCH_MAX_IMAGES', 10, 1, 10),
    maxBytes: limit('AGENT_IMAGE_BATCH_MAX_MIB', 16, 4, 16) * 1024 * 1024,
  }
}


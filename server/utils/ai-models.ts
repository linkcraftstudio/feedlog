export function embeddingModel(): string {
  return process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-large'
}

export function visionModel(): string | undefined {
  return process.env.OPENAI_VISION_MODEL || process.env.OPENAI_TEXT_MODEL
}

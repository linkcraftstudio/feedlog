import { generateEmbedding, isEmbeddingEnabled } from '#layers/feedlog/server/utils/embedding'

// Returns the query embedding, or null if embeddings are disabled or the provider
// errors — callers fall back to trigram. Never throws (a search box must not 5xx).
export async function embedQueryOrNull(text: string): Promise<number[] | null> {
  if (!isEmbeddingEnabled()) return null
  try {
    return await generateEmbedding(text)
  }
  catch {
    return null
  }
}

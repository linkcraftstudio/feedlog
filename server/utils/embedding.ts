import { eq, and } from 'drizzle-orm'
import { postEmbedding } from '#layers/feedlog/server/db/schemas'

const EMBEDDING_MODEL = 'text-embedding-3-large'
const EMBEDDING_DIMENSIONS = 768

export function isEmbeddingEnabled(): boolean {
  return !!process.env.OPENAI_API_KEY
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured')

  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`OpenAI API error: ${response.status} ${error}`)
  }

  const data = await response.json() as { data: { embedding: number[] }[] }
  return data.data[0].embedding
}

// Generate and store embedding for a post with optimistic lock on content_hash
export async function generatePostEmbedding(
  postId: string,
  orgId: string,
  title: string,
  content: string,
  contentHash: string,
): Promise<void> {
  if (!isEmbeddingEnabled()) return

  try {
    const text = stripMarkdown(title + '\n' + content)
    const embedding = await generateEmbedding(text)

    const db = useDB()

    // Check if content_hash still matches (optimistic lock)
    const [existing] = await db
      .select({ contentHash: postEmbedding.contentHash })
      .from(postEmbedding)
      .where(eq(postEmbedding.postId, postId))
      .limit(1)

    if (existing) {
      // Update only if content_hash matches or is the same post
      await db
        .update(postEmbedding)
        .set({
          embedding,
          model: EMBEDDING_MODEL,
          contentHash,
          createdAt: new Date(),
        })
        .where(and(
          eq(postEmbedding.postId, postId),
          eq(postEmbedding.contentHash, existing.contentHash),
        ))
    } else {
      // Insert new embedding
      await db
        .insert(postEmbedding)
        .values({
          postId,
          orgId,
          embedding,
          model: EMBEDDING_MODEL,
          contentHash,
        })
        .onConflictDoNothing()
    }
  } catch (error) {
    // Non-blocking: log error but don't fail the request
    console.error(`Failed to generate embedding for post ${postId}:`, error)
  }
}

import { z } from 'zod/v4'

const schema = z.object({
  title: z.string().trim().min(1),
  content: z.string().trim().optional(),
  limit: z.number().int().min(1).max(20).optional(),
})

// POST /api/posts/similar — Search similar posts by input text (for submit modal + merge dialog)
//
// Session optional, like every other read of this content: the submit modal
// searches while the reporter types, and a guest identity is only minted once
// they press submit — so this runs with nobody attached for the whole time the
// form is being filled in. It returns the same posts the public list already
// serves; the session only decides whether hasVoted can be filled in.
export default defineEventHandler(async (event) => {
  const session = await getUserSession(event)
  const orgId = event.context.orgId!
  const body = await readValidatedBody(event, schema.parse)

  const text = body.content
    ? body.title + '\n' + body.content
    : body.title

  const userId = session?.user.id
  const plainText = stripMarkdown(text)
  const limit = body.limit ?? 3

  if (isEmbeddingEnabled()) {
    try {
      const embedding = await generateEmbedding(plainText)
      const data = await searchSimilarByEmbedding(embedding, { orgId, limit, userId })
      return { data }
    } catch {
      // Embedding failed, fall through to trgm
    }
  }

  // Fallback to pg_trgm
  const data = await searchSimilarByTrgm(plainText, { orgId, limit, userId })
  return { data }
})

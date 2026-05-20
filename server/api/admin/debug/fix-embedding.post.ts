import { eq } from 'drizzle-orm'
import { post, postEmbedding, postSearch } from '#layers/feedlog/server/db/schemas'

// POST /api/admin/debug/fix-embedding — Backfill post_search and post_embedding
// Owner-only debug tool (gated on feedlog:moderate).
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })

  const body = await readBody(event) as { dryRun?: boolean } | null
  const dryRun = body?.dryRun ?? false

  const db = useDB()

  // Fetch all posts in this org
  const posts = await db
    .select({
      id: post.id,
      orgId: post.orgId,
      title: post.title,
      content: post.content,
      contentHash: post.contentHash,
    })
    .from(post)
    .where(eq(post.orgId, orgId))

  let searchUpdated = 0
  let embeddingUpdated = 0
  let embeddingSkipped = 0
  let embeddingFailed = 0

  for (const p of posts) {
    const hash = computeContentHash(p.title, p.content)
    const searchText = stripMarkdown(p.title + '\n' + p.content)

    if (!dryRun) {
      // Always upsert post_search
      await db
        .insert(postSearch)
        .values({ postId: p.id, orgId: p.orgId, searchText })
        .onConflictDoUpdate({
          target: postSearch.postId,
          set: { searchText },
        })

      // Update content_hash if missing or outdated
      if (p.contentHash !== hash) {
        await db
          .update(post)
          .set({ contentHash: hash })
          .where(eq(post.id, p.id))
      }
    }
    searchUpdated++

    // Embedding: check if needs update
    if (isEmbeddingEnabled()) {
      const [existing] = await db
        .select({ contentHash: postEmbedding.contentHash, model: postEmbedding.model })
        .from(postEmbedding)
        .where(eq(postEmbedding.postId, p.id))
        .limit(1)

      if (existing && existing.contentHash === hash && existing.model === 'text-embedding-3-large') {
        embeddingSkipped++
        continue
      }

      if (!dryRun) {
        try {
          await generatePostEmbedding(p.id, p.orgId, p.title, p.content, hash)
          embeddingUpdated++
        } catch (error) {
          embeddingFailed++
          console.error(`Failed to generate embedding for post ${p.id}:`, error)
        }
      } else {
        embeddingUpdated++
      }
    }
  }

  return {
    dryRun,
    total: posts.length,
    search: { updated: searchUpdated },
    embedding: {
      enabled: isEmbeddingEnabled(),
      updated: embeddingUpdated,
      skipped: embeddingSkipped,
      failed: embeddingFailed,
    },
  }
})

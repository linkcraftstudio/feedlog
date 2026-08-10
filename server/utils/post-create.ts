import { eq } from 'drizzle-orm'
import { useDB } from './db'
import { post, postSearch, postSubscription, user } from '../db/schemas'

// Shared post creation: slug, excerpt, search row, author subscription.
// Extracted so the widget's AI extraction path produces posts
// indistinguishable from ones submitted through POST /api/posts — two code
// paths writing posts differently is how search or notifications quietly start
// missing half the rows.

export interface CreatePostInput {
  orgId: string
  authorId: string
  title: string
  content: string
  boardId?: string | null
  // Admins don't subscribe to their own posts (see POST /api/posts).
  subscribeAuthor: boolean
}

export interface CreatedPost {
  id: string
  slug: string
  title: string
  content: string
  status: string
  boardId: string | null
  voteCount: number
  commentCount: number
  createdAt: Date
  updatedAt: Date
  contentHash: string
}

// tx folds these writes into a caller's transaction — the widget pairs the post
// with the chat message it came from. Slug lookup stays outside: it only reads,
// and a real collision is caught by idx_post_org_slug either way.
export async function createPostRecord(
  input: CreatePostInput,
  tx?: Pick<ReturnType<typeof useDB>, 'insert'>,
): Promise<CreatedPost> {
  const slug = await generateSlug(input.title)
  const excerpt = generateExcerpt(input.content)
  const contentHash = computeContentHash(input.title, input.content)

  const db = tx ?? useDB()
  const [created] = await db
    .insert(post)
    .values({
      orgId: input.orgId,
      title: input.title,
      content: input.content,
      excerpt,
      slug,
      contentHash,
      boardId: input.boardId || null,
      authorId: input.authorId,
    })
    .returning()

  if (!created) {
    throw createError({ statusCode: 500, message: 'Failed to create' })
  }

  const searchText = stripMarkdown(input.title + '\n' + input.content)
  await db.insert(postSearch).values({ postId: created.id, orgId: input.orgId, searchText })

  if (input.subscribeAuthor) {
    await db.insert(postSubscription)
      .values({ postId: created.id, userId: input.authorId })
      .onConflictDoNothing()
  }

  return { ...created, contentHash }
}

export async function fetchPostAuthor(authorId: string) {
  const [author] = await useDB()
    .select({ id: user.id, name: user.name, image: user.image })
    .from(user)
    .where(eq(user.id, authorId))
  return author ?? { id: authorId, name: null, image: null }
}

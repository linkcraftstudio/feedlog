import slugify from 'slugify'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { post, changelog } from '#layers/feedlog/server/db/schemas'

type SlugExistsCheck = (slug: string) => Promise<boolean>

// Core slug generator: slugified-title-{nanoid8}, falls back to pure nanoid for CJK-only titles
// Accepts a callback to check uniqueness against any table
async function generateSlugWith(title: string, exists: SlugExistsCheck, maxRetries = 3): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    const suffix = nanoid(8)
    const slugified = slugify(title, { lower: true, strict: true })
    const slug = slugified ? `${slugified}-${suffix}` : suffix

    if (!(await exists(slug))) return slug
  }

  throw createError({ statusCode: 500, message: 'Failed to generate slug' })
}

// Generate slug with uniqueness check against post table
export async function generateSlug(title: string, maxRetries = 3): Promise<string> {
  const db = useDB()
  return generateSlugWith(title, async (slug) => {
    const [existing] = await db.select({ id: post.id }).from(post).where(eq(post.slug, slug)).limit(1)
    return !!existing
  }, maxRetries)
}

// Generate slug with uniqueness check against changelog table
export async function generateChangelogSlug(title: string, maxRetries = 3): Promise<string> {
  const db = useDB()
  return generateSlugWith(title, async (slug) => {
    const [existing] = await db.select({ id: changelog.id }).from(changelog).where(eq(changelog.slug, slug)).limit(1)
    return !!existing
  }, maxRetries)
}

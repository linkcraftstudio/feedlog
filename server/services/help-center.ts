import { helpIndexError, helpIndexStatus } from '../lib/help-search/management'
import { helpVectorsEnabled } from '../lib/help-search/embedding'
import { kickHelpIndex } from '../lib/help-search/runtime'
import { queueHelpIndex, ensureHelpIndex, pauseHelpIndex, deleteHelpIndex } from '../lib/help-search/jobs'
import { cursorPage, literalSubstring, type CursorPageInput } from './query-pagination'
import { and, eq, ilike, or, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { helpArticle, helpCollection, organization } from '../db/schemas'
import { createHelpArticleSchema, createHelpCollectionSchema, updateHelpArticleSchema, updateHelpCollectionSchema } from '../../shared/schemas/help'
import { buildHelpTsv, withHelpShortId, generateHelpSlug } from '../utils/help'
import { resolvePortalModules } from '../../shared/utils/portal-modules'
import { contentError, requireModerator, type ContentReader, type ContentContext } from './content-context'

async function lockHelpContent(context: ContentContext) {
  // Collection deletion and article movement must acquire locks in the same order.
  await context.db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${context.orgId + ':help'}, 0))`)
}

export async function helpCollectionRecord(context: ContentReader, id: string) {
  const [record] = await context.db.select().from(helpCollection).where(and(eq(helpCollection.id, id), eq(helpCollection.orgId, context.orgId))).for('share')
  if (!record) throw contentError(404, 'Collection not found')
  return record
}
export async function createCollection(context: ContentContext, body: z.infer<typeof createHelpCollectionSchema>) {
  requireModerator(context)
  await lockHelpContent(context)
  const input = createHelpCollectionSchema.parse(body)
  const [last] = await context.db.select({ position: sql<number>`coalesce(max(${helpCollection.position}), -1)::int` }).from(helpCollection).where(eq(helpCollection.orgId, context.orgId))
  const [record] = await context.db.insert(helpCollection).values({ ...input, orgId: context.orgId, position: (last?.position ?? -1) + 1 }).returning()
  return { ...record!, articleCount: 0, articles: [] }
}
export async function updateCollection(context: ContentContext, id: string, body: z.infer<typeof updateHelpCollectionSchema>) {
  requireModerator(context)
  await lockHelpContent(context)
  const input = updateHelpCollectionSchema.parse(body)
  if (!Object.values(input).some(value => value !== undefined)) throw contentError(400, 'No fields to update')
  const [record] = await context.db.update(helpCollection).set(input).where(and(eq(helpCollection.id, id), eq(helpCollection.orgId, context.orgId))).returning()
  if (!record) throw contentError(404, 'Collection not found')
  const articles = await context.db.select({ id: helpArticle.id, title: helpArticle.title, status: helpArticle.status, shortId: helpArticle.shortId, slug: helpArticle.slug, position: helpArticle.position, aiEnabled: helpArticle.aiEnabled, indexError: helpIndexError(), indexStatus: helpIndexStatus(), updatedAt: helpArticle.updatedAt }).from(helpArticle).where(and(eq(helpArticle.collectionId, id), eq(helpArticle.orgId, context.orgId))).orderBy(helpArticle.position, helpArticle.id)
  return { ...record, articleCount: articles.length, articles }
}

export async function deleteCollection(context: ContentContext, id: string) {
  requireModerator(context)
  await lockHelpContent(context)
  const [deleted] = await context.db.delete(helpCollection).where(and(eq(helpCollection.id, id), eq(helpCollection.orgId, context.orgId))).returning()
  if (!deleted) throw contentError(404, 'Collection not found')
  const articles = await context.db.delete(helpArticle).where(and(eq(helpArticle.collectionId, id), eq(helpArticle.orgId, context.orgId))).returning({ id: helpArticle.id })
  for (const article of articles) await deleteHelpIndex(context.db, article.id)
}
export async function articleRecord(context: ContentReader, id: string, view: 'management' | 'public' = 'management', lock = false, by: 'id' | 'shortId' = 'id') {
  const query = context.db.select({ ...articleSummaryFields, content: helpArticle.content, ...(view === 'management' ? { indexError: helpIndexError(), indexStatus: helpIndexStatus() } : {}) }).from(helpArticle).where(and(eq(by === 'id' ? helpArticle.id : helpArticle.shortId, id), eq(helpArticle.orgId, context.orgId)))
  const [record] = await (lock ? query.for('update') : query)
  if (!record) throw contentError(404, 'Article not found')
  const collection = await helpCollectionRecord(context, record.collectionId)
  const [org] = await context.db.select({ metadata: organization.metadata }).from(organization).where(eq(organization.id, context.orgId))
  const visible = record.status === 'published' && collection.visible && resolvePortalModules(org?.metadata).helpCenter
  if (view === 'public' && !visible) throw contentError(404, 'Article is not publicly available')
  return { ...record, collection: { id: collection.id, name: collection.name, visible: collection.visible } }
}
async function articlePosition(context: ContentContext, collectionId: string) {
  const [last] = await context.db.select({ position: sql<number>`coalesce(max(${helpArticle.position}), -1)::int` }).from(helpArticle).where(and(eq(helpArticle.collectionId, collectionId), eq(helpArticle.orgId, context.orgId)))
  return (last?.position ?? -1) + 1
}
export async function createArticle(context: ContentContext, body: z.infer<typeof createHelpArticleSchema>) {
  requireModerator(context)
  await lockHelpContent(context)
  const input = createHelpArticleSchema.parse(body)
  await helpCollectionRecord(context, input.collectionId)
  const position = await articlePosition(context, input.collectionId)
  const record = await withHelpShortId(shortId => context.db.transaction(async savepoint => {
    const [created] = await savepoint.insert(helpArticle).values({
      orgId: context.orgId, collectionId: input.collectionId, shortId, slug: generateHelpSlug(input.title),
      status: input.publish ? 'published' : 'draft', title: input.title, description: input.description ?? null, content: input.content,
      aiEnabled: input.aiEnabled, tsv: buildHelpTsv(input.title, input.description ?? null, input.content),
      position, publishedAt: input.publish ? new Date() : null,
    }).returning()
    if (input.publish) await queueHelpIndex(savepoint, created!.id)
    return created!
  }))
  if (input.publish) context.afterCommit.push(() => kickHelpIndex(context.event, record.id))
  return articleRecord(context, record.id)
}
export async function updateArticle(context: ContentContext, id: string, body: z.infer<typeof updateHelpArticleSchema>) {
  requireModerator(context)
  await lockHelpContent(context)
  const input = updateHelpArticleSchema.parse(body)
  if (!Object.values(input).some(value => value !== undefined)) throw contentError(400, 'No fields to update')
  const existing = await articleRecord(context, id, 'management', true)
  const title = input.title ?? existing.title
  const content = input.content ?? existing.content
  const description = input.description === undefined ? existing.description : input.description
  const changed = title !== existing.title || content !== existing.content || description !== existing.description
  const updates: Omit<Partial<typeof helpArticle.$inferInsert>, 'tsv'> & { tsv?: ReturnType<typeof buildHelpTsv> } = { ...input, updatedAt: new Date() }
  if (input.collectionId && input.collectionId !== existing.collectionId) {
    await helpCollectionRecord(context, input.collectionId)
    updates.position = await articlePosition(context, input.collectionId)
  }
  if (changed) {
    updates.tsv = buildHelpTsv(title, description, content)
    if (title !== existing.title) updates.slug = generateHelpSlug(title)
  }
  const status = input.status ?? (existing.status === 'archived' && changed ? 'draft' : undefined)
  if (status === 'published') {
    if (!title.trim() || !content.trim()) throw contentError(400, 'Title and content are required to publish')
    updates.publishedAt = existing.publishedAt ?? new Date()
  }
  if (status === 'archived' && existing.status !== 'published') throw contentError(409, 'Only a published article can be unpublished')
  if (status) updates.status = status
  await context.db.update(helpArticle).set(updates).where(and(eq(helpArticle.id, id), eq(helpArticle.orgId, context.orgId)))
  const nextStatus = status ?? existing.status
  let queued = false
  if (nextStatus !== 'published') {
    // Retain the last completed snapshot, but fence any unfinished worker.
    await pauseHelpIndex(context.db, id)
  }
  else if (existing.status !== 'published') {
    await queueHelpIndex(context.db, id)
    queued = true
  }
  else if (changed) {
    await queueHelpIndex(context.db, id)
    queued = true
  }
  else if (helpVectorsEnabled() && [input.title, input.description, input.content].some(value => value !== undefined)) {
    // An unchanged published save starts missing jobs or retries failures.
    queued = await ensureHelpIndex(context.db, id)
  }
  if (queued) context.afterCommit.push(() => kickHelpIndex(context.event, id))
  return articleRecord(context, id)
}
export async function deleteArticle(context: ContentContext, id: string) {
  requireModerator(context)
  await lockHelpContent(context)
  const [record] = await context.db.delete(helpArticle).where(and(eq(helpArticle.id, id), eq(helpArticle.orgId, context.orgId))).returning({ id: helpArticle.id })
  if (!record) throw contentError(404, 'Article not found')
  await deleteHelpIndex(context.db, id)
  return { id, deleted: true }
}

export const collectionFields = {
  id: helpCollection.id, orgId: helpCollection.orgId, name: helpCollection.name,
  description: helpCollection.description, icon: helpCollection.icon, visible: helpCollection.visible, position: helpCollection.position,
}
export const articleSummaryFields = {
  id: helpArticle.id, orgId: helpArticle.orgId, collectionId: helpArticle.collectionId,
  shortId: helpArticle.shortId, slug: helpArticle.slug, status: helpArticle.status,
  title: helpArticle.title, description: helpArticle.description, aiEnabled: helpArticle.aiEnabled,
  position: helpArticle.position, publishedAt: helpArticle.publishedAt, createdAt: helpArticle.createdAt, updatedAt: helpArticle.updatedAt,
}
export function articleConditions(orgId: string, input: { status?: string; collectionId?: string; aiEnabled?: boolean; query?: string } = {}) {
  return [
    eq(helpArticle.orgId, orgId),
    input.status ? eq(helpArticle.status, input.status as 'draft' | 'published' | 'archived') : undefined,
    input.collectionId ? eq(helpArticle.collectionId, input.collectionId) : undefined,
    input.aiEnabled === undefined ? undefined : eq(helpArticle.aiEnabled, input.aiEnabled),
    input.query ? or(ilike(helpArticle.title, literalSubstring(input.query)), ilike(helpArticle.content, literalSubstring(input.query))) : undefined,
  ]
}
export async function listCollections(context: ContentReader, input: CursorPageInput & { visible?: boolean }) {
  const page = await cursorPage(input, { kind: 'collections', organizationId: context.orgId, filter: { visible: input.visible }, sort: 'position', ascending: true }, helpCollection.position, helpCollection.id, true, true)
  const rows = await context.db.select({ ...collectionFields, articleCount: sql<number>`count(${helpArticle.id})::int`, cursorKey: helpCollection.position })
    .from(helpCollection).leftJoin(helpArticle, and(eq(helpArticle.collectionId, helpCollection.id), eq(helpArticle.orgId, context.orgId)))
    .where(and(eq(helpCollection.orgId, context.orgId), input.visible === undefined ? undefined : eq(helpCollection.visible, input.visible), page.after))
    .groupBy(helpCollection.id).orderBy(...page.orderBy).limit(input.limit + 1)
  return page.finish(rows)
}
export async function listArticles(context: ContentReader, input: CursorPageInput & { query?: string; collectionId?: string; status?: string; aiEnabled?: boolean; sort?: 'created_desc' | 'created_asc' | 'updated_desc' }) {
  const filter = { query: input.query, collection_id: input.collectionId, status: input.status, ai_enabled: input.aiEnabled, sort: input.sort }
  const page = await cursorPage(input, { kind: 'articles', organizationId: context.orgId, filter, sort: input.sort === 'updated_desc' ? 'updated_at' : 'created_at', ascending: input.sort === 'created_asc' }, input.sort === 'updated_desc' ? helpArticle.updatedAt : helpArticle.createdAt, helpArticle.id, input.sort === 'created_asc')
  const rows = await context.db.select({ ...articleSummaryFields, cursorKey: page.cursorKey }).from(helpArticle)
    .where(and(...articleConditions(context.orgId, input), page.after)).orderBy(...page.orderBy).limit(input.limit + 1)
  return page.finish(rows)
}

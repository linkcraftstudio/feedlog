import { helpIndexError, helpIndexStatus } from '../lib/help-search/management'
import { articleRecord, articleConditions } from './help-center'
import { and, asc, eq, ilike, sql, inArray, ne } from 'drizzle-orm'
import { helpArticle, helpCollection } from '../db/schemas'
import type { ContentReader } from './content-context'
import { createError } from 'h3'

export async function listManagementArticles(context: ContentReader, input: { q?: string; page: number; pageSize: number }) {
  const { db, orgId } = context
  const { q, page, pageSize } = input
  const where = and(...articleConditions(orgId), q ? ilike(helpArticle.title, `%${q}%`) : undefined)

  const [countResult] = await db
    .select({ total: sql<number>`cast(count(*) as int)` })
    .from(helpArticle)
    .where(where)

  const rows = await db
    .select({
      id: helpArticle.id,
      shortId: helpArticle.shortId,
      slug: helpArticle.slug,
      title: helpArticle.title,
      status: helpArticle.status,
      aiEnabled: helpArticle.aiEnabled,
      indexError: helpIndexError(),
      indexStatus: helpIndexStatus(),
      position: helpArticle.position,
      updatedAt: helpArticle.updatedAt,
      collectionId: helpCollection.id,
      collectionName: helpCollection.name,
      collectionVisible: helpCollection.visible,
    })
    .from(helpArticle)
    .innerJoin(helpCollection, eq(helpArticle.collectionId, helpCollection.id))
    .where(where)
    .orderBy(asc(helpCollection.position), asc(helpArticle.position), asc(helpArticle.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)

  return {
    data: rows.map(({ collectionId, collectionName, collectionVisible, ...a }) => ({
      ...a,
      collection: { id: collectionId, name: collectionName, visible: collectionVisible },
    })),
    pagination: { page, pageSize, total: countResult?.total ?? 0 },
  }
}

export async function listManagementCollections(context: ContentReader, flat: boolean) {
  const { db, orgId } = context
  const fields = {
    id: helpCollection.id,
    name: helpCollection.name,
    description: helpCollection.description,
    icon: helpCollection.icon,
    visible: helpCollection.visible,
    position: helpCollection.position,
  }

  const collections = await db
    .select(fields)
    .from(helpCollection)
    .where(eq(helpCollection.orgId, orgId))
    .orderBy(asc(helpCollection.position), asc(helpCollection.id))

  if (flat) return { data: collections }

  const articles = collections.length
    ? await db
        .select({
          id: helpArticle.id,
          collectionId: helpArticle.collectionId,
          title: helpArticle.title,
          status: helpArticle.status,
          aiEnabled: helpArticle.aiEnabled,
          indexError: helpIndexError(),
          indexStatus: helpIndexStatus(),
          position: helpArticle.position,
          updatedAt: helpArticle.updatedAt,
        })
        .from(helpArticle)
        .where(and(eq(helpArticle.orgId, orgId), inArray(helpArticle.collectionId, collections.map(c => c.id))))
        .orderBy(asc(helpArticle.position), asc(helpArticle.id))
    : []

  return {
    data: collections.map((c) => {
      const own = articles.filter(a => a.collectionId === c.id)
      return {
        ...c,
        articleCount: own.length,
        articles: own.map(({ collectionId: _collectionId, ...a }) => a),
      }
    }),
  }
}

export async function getHelpStats(context: ContentReader) {
  const { db, orgId } = context
  const [collections] = await db
    .select({ total: sql<number>`cast(count(*) as int)` })
    .from(helpCollection)
    .where(eq(helpCollection.orgId, orgId))

  const [articles] = await db
    .select({ total: sql<number>`cast(count(*) as int)` })
    .from(helpArticle)
    .where(eq(helpArticle.orgId, orgId))

  return { collectionCount: collections?.total ?? 0, articleCount: articles?.total ?? 0 }
}

export async function listPublicCollections(context: ContentReader) {
  const { db, orgId } = context
  const data = await db
    .select({
      id: helpCollection.id,
      name: helpCollection.name,
      description: helpCollection.description,
      icon: helpCollection.icon,
      articleCount: sql<number>`cast(count(${helpArticle.id}) as int)`,
    })
    .from(helpCollection)
    .innerJoin(helpArticle, and(
      eq(helpArticle.collectionId, helpCollection.id),
      eq(helpArticle.status, 'published'),
    ))
    .where(and(eq(helpCollection.orgId, orgId), eq(helpCollection.visible, true)))
    .groupBy(helpCollection.id, helpCollection.position)
    .orderBy(asc(helpCollection.position), asc(helpCollection.id))

  return { data }
}

export async function getPublicCollection(context: ContentReader, id: string) {
  const { db, orgId } = context
  const [collection] = await db
    .select({
      id: helpCollection.id,
      name: helpCollection.name,
      description: helpCollection.description,
      icon: helpCollection.icon,
    })
    .from(helpCollection)
    .where(and(
      eq(helpCollection.id, id),
      eq(helpCollection.orgId, orgId),
      eq(helpCollection.visible, true),
    ))
    .limit(1)

  if (!collection) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const articles = await db
    .select({
      shortId: helpArticle.shortId,
      slug: helpArticle.slug,
      title: helpArticle.title,
      description: helpArticle.description,
      updatedAt: helpArticle.updatedAt,
    })
    .from(helpArticle)
    .where(and(eq(helpArticle.orgId, orgId), eq(helpArticle.collectionId, id), eq(helpArticle.status, 'published')))
    .orderBy(asc(helpArticle.position), asc(helpArticle.id))

  return { collection, articles }
}

export async function getPublicArticle(context: ContentReader, shortId: string) {
  const { db, orgId } = context
  const row = await articleRecord(context, shortId, 'public', false, 'shortId')

  const siblings = await db
    .select({
      shortId: helpArticle.shortId,
      slug: helpArticle.slug,
      title: helpArticle.title,
      description: helpArticle.description,
    })
    .from(helpArticle)
    .where(and(
      eq(helpArticle.orgId, orgId),
      eq(helpArticle.collectionId, row.collectionId),
      eq(helpArticle.status, 'published'),
      ne(helpArticle.id, row.id),
    ))
    .orderBy(asc(helpArticle.position), asc(helpArticle.id))

  return {
    shortId: row.shortId,
    canonicalSlug: row.slug,
    title: row.title,
    description: row.description,
    content: row.content,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    collection: { id: row.collectionId, name: row.collection.name },
    siblings,
  }
}

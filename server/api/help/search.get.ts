import { searchHelpVectors, fuseHelpResults } from '../../lib/help-search/vector-search'
import { withHelpPool } from '../../lib/help-search/runtime'
import { helpVectorsEnabled } from '../../lib/help-search/embedding'
import { buildBilingualHelpQuery } from '../../lib/help-search/query'
import { searchHelpProgressively } from '../../lib/help-search/progressive'
import { and, asc, eq, sql } from 'drizzle-orm'
import { helpArticle, helpCollection } from '#layers/feedlog/server/db/schemas'

const SEARCH_LIMIT = 6
// Keep weak semantic neighbors out of public article results. Keyword matches
// and Agent retrieval have separate relevance rules.
const MIN_SEMANTIC_SIMILARITY = 0.23
const RATE_LIMIT = { limit: 30, windowSeconds: 60 }

export default defineEventHandler(async (event) => {
  const orgId = await requireHelpCenterOrg(event)

  const params = getQuery(event)
  const input = params.q ?? ''
  if (params.translate !== undefined && params.translate !== '1') {
    throw createError({ statusCode: 400, message: 'Invalid translation retry' })
  }
  if (typeof input !== 'string' || input.trim().length > 200) {
    throw createError({ statusCode: 400, message: 'Search query must be at most 200 characters' })
  }
  const query = input.trim()
  const tokens = splitHelpQuery(query)
  const originalTsQuery = buildHelpTsQuery(tokens)
  if (!query) return { total: 0, data: [] }

  const ip = getRequestIP(event, { xForwardedFor: true }) || 'unknown'
  if (!await checkRateLimit(`help-search:${ip}`, RATE_LIMIT)) {
    throw createError({ statusCode: 429, message: 'Too many requests' })
  }

  const db = useDB()

  const search = async (phrases?: string[]) => {
    if (!originalTsQuery && !phrases?.length) return []
    const tsQuery = phrases?.length ? buildBilingualHelpQuery(query, phrases) : originalTsQuery
    return db
      .select({
        shortId: helpArticle.shortId,
        slug: helpArticle.slug,
        title: helpArticle.title,
        description: helpArticle.description,
        content: helpArticle.content,
        collectionId: helpCollection.id,
        collectionName: helpCollection.name,
        total: sql<number>`cast(count(*) over () as int)`,
      })
      .from(helpArticle)
      .innerJoin(helpCollection, eq(helpArticle.collectionId, helpCollection.id))
      .where(and(
        eq(helpArticle.orgId, orgId),
        eq(helpArticle.status, 'published'),
        eq(helpCollection.visible, true),
        eq(helpCollection.orgId, orgId),
        sql`${helpArticle.tsv} @@ (${tsQuery})`,
      ))
      // ts_rank_cd's weight array is ordered {D,C,B,A}, so {0,0,0,1} isolates A (title) and {0,0,1,0} isolates B (description).
      .orderBy(
        sql`(case when ts_rank_cd('{0,0,0,1}', ${helpArticle.tsv}, (${tsQuery})) > 0 then 2
                  when ts_rank_cd('{0,0,1,0}', ${helpArticle.tsv}, (${tsQuery})) > 0 then 1
                  else 0 end) desc`,
        sql`ts_rank_cd(${helpArticle.tsv}, (${tsQuery})) desc`,
        asc(helpArticle.id),
      )
      .limit(SEARCH_LIMIT)
  }
  const vectorPromise = helpVectorsEnabled()
    ? withHelpPool(event, pool => searchHelpVectors(pool, orgId, query, 'public')).catch(() => null)
    : Promise.resolve(null)
  const result = await searchHelpProgressively({ orgId, query, translate: params.translate === '1', search })
  const vectors = await vectorPromise
  const semantic = vectors?.filter(row => row.score >= MIN_SEMANTIC_SIMILARITY)
    .map(row => ({ ...row, total: 0 })) ?? []
  const rows = fuseHelpResults(result.rows, semantic, row => row.shortId, SEARCH_LIMIT)
  const highlightTokens = result.translatedQueries.length
    ? splitHelpQuery(result.translatedQueries.join(' ')) : tokens

  return {
    total: Math.max(result.rows[0]?.total ?? 0, rows.length),
    searchMode: semantic.length ? 'hybrid' : result.searchMode,
    canTranslate: !semantic.length && result.canTranslate,
    translatedQueries: result.translatedQueries,
    data: rows.map((row) => {
      const { excerpt, ranges } = buildHelpExcerpt(stripMarkdown(row.content), row.description, highlightTokens)
      return {
        shortId: row.shortId,
        slug: row.slug,
        title: row.title,
        titleRanges: helpHighlightRanges(row.title, highlightTokens),
        excerpt,
        excerptRanges: ranges,
        collection: { id: row.collectionId, name: row.collectionName },
      }
    }),
  }
})

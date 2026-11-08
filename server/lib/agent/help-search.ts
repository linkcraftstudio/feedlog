import { searchHelpVectors, fuseHelpResults } from '../help-search/vector-search'
import { PgDialect } from 'drizzle-orm/pg-core'
import { buildBilingualHelpQuery } from '../help-search/query'
import { searchHelpProgressively } from '../help-search/progressive'
import type { Pool } from 'pg'
import { z } from 'zod'
import { resolvePortalModules } from '../../../shared/utils/portal-modules'
import { stripMarkdown } from '../../../shared/utils/markdown'
import { buildHelpExcerpt, buildHelpTsQuery, splitHelpQuery } from '../../utils/help-search'

const RESULTS_PER_QUERY = 3

export const helpArticleSearchInput = z.object({
  queries: z.array(z.string().trim().min(1).max(100).describe(
    'A focused query in the customer’s language. Preserve product names and important constraints. For example, "report export" or "PDF format".',
  )).min(1).max(4).describe(
    'One to four short searches for the same customer question. Cover the core feature and important conditions with separate queries, or use alternative wording. For example, a question about downloading a report as PDF could use ["report export", "PDF format"]. Use one query when it is sufficient. Results from all queries are merged and deduplicated.',
  ),
}).strict()

export type HelpArticleSearchInput = z.infer<typeof helpArticleSearchInput>

export interface HelpArticleSearchResult {
  article_id: string
  slug: string
  customer_visible: boolean
  url: string | null
  title: string
  description: string | null
  excerpt: string
  matched_queries: string[]
}

export const helpArticleSearchDescription = 'Search AI-enabled knowledge articles, including internal articles. Use one to four focused queries in the customer’s language, preserving product names and important constraints. When semantic search is enabled, multilingual vector candidates are combined with full-text results. Without a ready semantic index, keyword search remains available; use a few specific subject words or alternative wording when it returns no results. Each query returns up to three articles; results are interleaved and deduplicated, with at most twelve articles. matched_queries lists the searches that returned each article. A generic title does not make a body-matching candidate irrelevant. Excerpts are candidate evidence, not verified answers: read full articles matching the named feature or requested condition before concluding the documentation has no answer, verify ALL original question constraints, and follow relevant internal links.'

export async function searchHelpArticles(pool: Pick<Pool, 'query'>, orgId: string, input: HelpArticleSearchInput, origin: string) {
  const parsed = helpArticleSearchInput.parse(input)
  const { rows: [org] } = await pool.query('SELECT metadata FROM organization WHERE id=$1', [orgId])
  const publicEnabled = resolvePortalModules(org?.metadata).helpCenter
  const queries: string[] = []
  const seen = new Set<string>()
  for (const query of parsed.queries) {
    const normalized = query.replace(/\s+/g, ' ')
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    queries.push(normalized)
  }

  const dialect = new PgDialect()
  const groups = await Promise.all(queries.map(async query => {
    type Row = {
      article_id: string
      title: string
      description: string | null
      content: string
      slug: string
      published: boolean
    }
    const run = async (english?: string[]) => {
      const compiled = english?.length
        ? dialect.sqlToQuery(buildBilingualHelpQuery(query, english))
        : /[\u3400-\u9fff]/.test(query)
          ? dialect.sqlToQuery(buildHelpTsQuery(splitHelpQuery(query))!)
          : { sql: "plainto_tsquery('english',$1)", params: [query] }
      // Offset only generated placeholders; query values remain parameters.
      const expression = compiled.sql.replace(/\$(\d+)/g, (_, index: string) => `$${Number(index) + 1}`)
      const limitIndex = compiled.params.length + 2
      const { rows } = await pool.query<Row>(`SELECT a.id AS article_id,a.title,a.description,a.content,a.short_id||'-'||a.slug AS slug,(a.status='published' AND c.visible) AS published
        FROM help_article a
        JOIN help_collection c ON c.id=a.collection_id AND c.org_id=a.org_id
        WHERE a.org_id=$1 AND a.ai_enabled
          AND a.tsv @@ (${expression})
        ORDER BY ts_rank_cd(a.tsv,(${expression})) DESC,a.id
        LIMIT $${limitIndex}`, [orgId, ...compiled.params, RESULTS_PER_QUERY])
      if (!rows.length && !english?.length && !/[\u3400-\u9fff]/.test(query)) {
        // A bounded candidate fallback for Agent full-text lookup, not public
        // search. Require multiple distinct lexemes; the Agent must read and
        // verify the original conditions before using a partial match.
        const relaxed = await pool.query<Row>(`WITH terms AS (
          SELECT t, plainto_tsquery('english',t) AS q
          FROM unnest(tsvector_to_array(to_tsvector('english',$2::text))) AS t
        )
        SELECT a.id AS article_id,a.title,a.description,a.content,a.short_id||'-'||a.slug AS slug,(a.status='published' AND c.visible) AS published
        FROM help_article a
        JOIN help_collection c ON c.id=a.collection_id AND c.org_id=a.org_id
        CROSS JOIN LATERAL (
          SELECT count(*) AS matched, sum(ts_rank_cd(a.tsv,terms.q)) AS rank
          FROM terms WHERE a.tsv @@ terms.q
        ) AS hits
        WHERE a.org_id=$1 AND a.ai_enabled
          AND a.tsv @@ (SELECT string_agg(q::text,' | ')::tsquery FROM terms)
          AND (SELECT count(*) FROM terms)>=3 AND hits.matched>=2
        ORDER BY hits.matched DESC,hits.rank DESC,a.id
        LIMIT $3`, [orgId, query, RESULTS_PER_QUERY])
        return relaxed.rows
      }
      return rows
    }
    const [vectors, result] = await Promise.all([
      searchHelpVectors(pool, orgId, query, 'agent'),
      searchHelpProgressively({ orgId, query, translate: true, search: run }),
    ])
    const semantic = vectors.map(row => ({ article_id: row.articleId, title: row.title, description: row.description, content: row.content, slug: `${row.shortId}-${row.slug}`, published: row.published }))
    // CJK lexical lookup uses broad OR bigrams; its first hit may match only a
    // generic word. Preserve an exact English full-text winner, not that hit.
    return { rows: fuseHelpResults(result.rows, semantic, row => row.article_id, RESULTS_PER_QUERY, !/[\u3400-\u9fff]/.test(query)), excerptTokens: splitHelpQuery([query, ...result.translatedQueries].join(' ')) }
  }))

  const articles = new Map<string, HelpArticleSearchResult>()
  // Interleave by rank so a broad query cannot occupy all leading positions.
  for (let rank = 0; rank < RESULTS_PER_QUERY; rank++) {
    for (const [index, group] of groups.entries()) {
      const row = group.rows[rank]
      if (!row) continue
      const query = queries[index]!
      const existing = articles.get(row.article_id)
      if (existing) {
        existing.matched_queries.push(query)
      } else {
        const { content, published, ...article } = row
        const { excerpt } = buildHelpExcerpt(stripMarkdown(content), row.description, group.excerptTokens, { bestMatch: true })
        articles.set(row.article_id, { ...article, excerpt, matched_queries: [query], customer_visible: publicEnabled && published, url: publicEnabled && published ? new URL(`/help/${article.slug}`, origin).href : null })
      }
    }
  }
  return { articles: [...articles.values()] }
}

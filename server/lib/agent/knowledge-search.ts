import type { Pool } from 'pg'
import { searchHelpArticles, helpArticleSearchInput, type KnowledgeSearchWarning } from './help-search'
import { searchWebPages } from '../web-source/search'
import { embedHelpTexts } from '../help-search/embedding'
import { generateExcerpt } from '../../../shared/utils/markdown'

// Reuse the existing multi-query validation without making the Agent-facing
// knowledge entry point depend on the Help Center's tool vocabulary.
export const knowledgeBaseSearchInput = helpArticleSearchInput

export async function searchKnowledgeBase(pool: Pick<Pool, 'query'>, orgId: string, input: { queries: string[] }, origin: string, embed = embedHelpTexts, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const parsed = knowledgeBaseSearchInput.parse(input)
  const queries = [...new Map(parsed.queries.map(q => { const normalized = q.replace(/\s+/g, ' '); return [normalized.toLowerCase(), normalized] })).values()]
  // A single query vector is shared by all providers in this tool call.
  const vectors = new Map<string, ReturnType<typeof embedHelpTexts>>()
  const sharedEmbed: typeof embedHelpTexts = (texts, timeout) => {
    const key = JSON.stringify(texts)
    if (!vectors.has(key)) vectors.set(key, embed(texts, timeout))
    return vectors.get(key)!
  }
  const warnings: KnowledgeSearchWarning[] = []
  const [helpResult, ...websiteResults] = await Promise.allSettled([
    searchHelpArticles(pool, orgId, { queries }, origin, sharedEmbed, signal),
    ...queries.map(query => searchWebPages(pool, orgId, query, sharedEmbed, { signal,
      onSemanticFailure: () => warnings.push({ sourceType: 'web_page', query, stage: 'semantic' }),
    })),
  ] as const)
  signal?.throwIfAborted()
  const help = helpResult.status === 'fulfilled' ? helpResult.value : { articles: [], warnings: [], failedQueries: queries }
  warnings.push(...help.warnings)
  if (helpResult.status === 'rejected') for (const query of queries) warnings.push({ sourceType: 'help_article', query, stage: 'provider' })
  const websites = websiteResults.map((result, index) => {
    if (result.status === 'fulfilled') return result.value
    warnings.push({ sourceType: 'web_page', query: queries[index]!, stage: 'provider' })
    return []
  })
  const unavailable = help.failedQueries.length === queries.length && websiteResults.every(result => result.status === 'rejected')
  type Result = { id: string; sourceType: 'help_article' | 'web_page'; title: string; url: string | null; excerpt: string; customerVisible: boolean; matchedQueries: string[]; priority: number; score: number }
  const candidates = new Map<string, Result>()
  for (const query of queries) {
    const lists = [help.articles.filter(a => a.matched_queries.includes(query)).sort((a, b) => a.query_ranks[query]! - b.query_ranks[query]!), websites[queries.indexOf(query)]!]
    for (const [provider, rows] of lists.entries()) for (const [rank, row] of rows.entries()) {
      const article = 'article_id' in row ? row : null
      const page = 'id' in row ? row : null
      const id = article?.article_id ?? page!.id
      const sourceType = provider === 0 ? 'help_article' as const : 'web_page' as const
      const key = `${sourceType}:${id}`, old = candidates.get(key)
      const score = 1 / (60 + rank + 1)
      if (old) { old.score += score; old.matchedQueries.push(query); continue }
      candidates.set(key, { id, sourceType, title: row.title, url: row.url, excerpt: article?.excerpt ?? generateExcerpt(page!.content), customerVisible: article?.customer_visible ?? true, matchedQueries: [query], priority: provider + 1, score })
    }
  }
  const results = [...candidates.values()].sort((a, b) => b.score - a.score || a.priority - b.priority || a.id.localeCompare(b.id)).slice(0, 12)
  return { results: results.map(({ score: _score, ...result }) => result), partial: warnings.length > 0, warnings, ...(unavailable ? { error: 'knowledge_search_unavailable' } : {}), conflictPolicy: 'Rank by relevance and read full sources. Combine complementary facts and distinguish different scopes. Only for contradictory facts about the same product and scope, Help Center takes precedence over website content. Within one source type, use reliable substantive content updates when known; crawl/index timestamps do not establish freshness. Unknown freshness must not be guessed.' }
}

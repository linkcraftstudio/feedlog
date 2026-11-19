import type { Pool } from 'pg'
import type { AgentPromptArticle } from './prompts/system'

// A prompt budget, not a claim that the first N articles are more useful.
export const HELP_CATALOG_PROMPT_BUDGET = 16000

export async function listHelpCatalog(pool: Pick<Pool, 'query'>, orgId: string, options: { offset?: number; limit?: number; budget?: number } = {}) {
  const offset = options.offset ?? 0
  const limit = options.limit ?? 100
  const scope = 'FROM help_article a JOIN help_collection c ON c.id=a.collection_id AND c.org_id=a.org_id WHERE a.org_id=$1 AND a.ai_enabled AND c.ai_enabled'
  const [count, page] = await Promise.all([
    pool.query<{ total: number }>(`SELECT count(*)::int AS total ${scope}`, [orgId]),
    pool.query<AgentPromptArticle>(`SELECT a.id,a.title,left(a.description,240) AS description,c.id AS "collectionId",c.name AS "collectionName"
      ${scope} ORDER BY c.position,c.id,a.position,a.id LIMIT $2 OFFSET $3`, [orgId, limit, offset]),
  ])
  const total = count.rows[0]!.total
  const articles: AgentPromptArticle[] = []
  let size = 2
  for (const article of page.rows) {
    const bytes = JSON.stringify(article).length + 1
    if (options.budget !== undefined && size + bytes > options.budget) break
    articles.push(article); size += bytes
  }
  const nextOffset = offset + articles.length < total ? offset + articles.length : null
  return { articles, total, complete: offset === 0 && nextOffset === null, nextOffset }
}

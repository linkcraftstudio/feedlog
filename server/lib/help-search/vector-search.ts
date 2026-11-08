import type { Pool } from 'pg'
import { embedHelpTexts, helpVectorsEnabled, HELP_EMBEDDING_MODEL, HELP_INDEX_VERSION } from './embedding'

export interface HelpVectorHit { articleId: string; shortId: string; slug: string; title: string; description: string | null; content: string; collectionId: string; collectionName: string; published: boolean; score: number }
export async function searchHelpVectors(pool: Pick<Pool, 'query'>, orgId: string, query: string, audience: 'public' | 'agent', limit = 12, embed = embedHelpTexts): Promise<HelpVectorHit[]> {
  if (!helpVectorsEnabled()) return []
  // No model request when this tenant has no eligible ready index (e.g. before backfill).
  const visibility = audience === 'public' ? "a.status='published' AND c.visible" : "a.status='published' AND a.ai_enabled"
  const scope = `FROM help_article_chunk k JOIN scheduled_task j ON j.ref_id=k.article_id AND j.id=k.generation_id AND j.kind='help_index' AND j.status='done' AND j.result='indexed'
    JOIN help_article a ON a.id=k.article_id AND a.org_id=k.org_id
    JOIN help_collection c ON c.id=a.collection_id AND c.org_id=a.org_id
    WHERE k.org_id=$1 AND k.model=$2 AND k.index_version=$3 AND ${visibility}`
  const ready = await pool.query(`SELECT 1 ${scope} LIMIT 1`, [orgId, HELP_EMBEDDING_MODEL, HELP_INDEX_VERSION])
  if (!ready.rows.length) return []
  const [vector] = await embed([query], 2500)
  const { rows } = await pool.query<HelpVectorHit>(`WITH candidates AS (
    SELECT a.id AS "articleId",a.short_id AS "shortId",a.slug,a.title,a.description,
      a.collection_id AS "collectionId",c.name AS "collectionName",(a.status='published' AND c.visible) AS published,
      k.body AS content,1-(k.embedding <=> $4::vector) AS score,
      row_number() OVER(PARTITION BY a.id ORDER BY k.embedding <=> $4::vector,k.ordinal) AS rn
    ${scope}
  ) SELECT * FROM candidates WHERE rn=1 ORDER BY score DESC,"articleId" LIMIT $5`, [orgId, HELP_EMBEDDING_MODEL, HELP_INDEX_VERSION, JSON.stringify(vector), limit])
  return rows
}

// Equal-weight reciprocal rank fusion combines ranks, not relevance scores.
export function fuseHelpResults<T>(lexical: T[], semantic: T[], key: (row: T) => string, limit: number, preserveLexicalFirst = false): T[] {
  const candidates = new Map<string, { row: T; score: number }>()
  for (const list of [lexical, semantic]) for (const [rank, row] of list.entries()) {
    const id = key(row), old = candidates.get(id)
    candidates.set(id, { row: old?.row ?? row, score: (old?.score ?? 0) + 1 / (60 + rank + 1) })
  }
  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score || key(a.row).localeCompare(key(b.row))).map(x => x.row)
  if (!preserveLexicalFirst || !lexical.length) return ranked.slice(0, limit)
  // The Agent must see the best full-text body match even when that article has
  // no ready vector and other articles receive a two-list RRF bonus.
  return [lexical[0]!, ...ranked.filter(row => key(row) !== key(lexical[0]!))].slice(0, limit)
}

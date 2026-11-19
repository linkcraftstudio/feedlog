import type { Pool } from 'pg'
import { embedHelpTexts, HELP_EMBEDDING_MODEL } from '../help-search/embedding'
import { WEB_SOURCE_INDEX_VERSION } from './prepare'
import { fuseHelpResults } from '../help-search/vector-search'
import { splitHelpQuery } from '../../utils/help-search'

export interface WebPageHit { id: string; title: string; url: string; description: string | null; content: string }
interface WebChunkHit extends WebPageHit { ordinal: number; websiteId: string; language: string | null; heading: string }

export async function searchWebPages(pool: Pick<Pool, 'query'>, orgId: string, query: string, embed = embedHelpTexts, options: { signal?: AbortSignal; onSemanticFailure?: () => void } = {}) {
  options.signal?.throwIfAborted()
  const eligible = `FROM content_chunk k JOIN ai_training_web_page d ON d.id=k.content_id AND d.org_id=k.org_id
    JOIN ai_training_website s ON s.id=d.website_id AND s.org_id=d.org_id
    WHERE k.org_id=$1 AND k.content_type='web_page' AND d.indexed_at IS NOT NULL AND s.ai_enabled`
  const fields = `d.id,coalesce(d.metadata->>'title',d.url) AS title,d.url,d.metadata->>'summary' AS description,k.body AS content,k.ordinal,
    d.website_id AS "websiteId",d.metadata->>'language' AS language,k.heading`
  // Compare complete blocks, including heading context, code and link targets.
  // Unknown-language legacy pages stay independent until their next sync.
  // Deduplicate before LIMIT so shared blocks cannot crowd out unique evidence.
  const duplicateScope = `d.website_id,coalesce(nullif(lower(d.metadata->>'language'),''),d.id::text),k.heading,k.body`
  const representative = `(d.url ~ '^https?://[^/?#]+/?$') DESC,d.id,k.ordinal`
  const tokens = splitHelpQuery(query).flatMap(token => token.kind === 'latin' ? [token.text] : Array.from({ length: Math.max(1, token.text.length - 1) }, (_, i) => token.text.slice(i, i + 2))).slice(0, 20)
  const matchText = `lower(coalesce(d.metadata->>'title','')||' '||coalesce(d.metadata->>'summary','')||' '||coalesce(d.metadata->>'keywords','')||' '||k.heading||' '||k.body)`
  const matches = `(SELECT count(*) FROM unnest($2::text[]) t WHERE strpos(${matchText},lower(t))>0)`
  const { rows: lexical } = await pool.query<WebChunkHit>(`WITH candidates AS (
    SELECT ${fields},${matches} AS matches,
      row_number() OVER(PARTITION BY ${duplicateScope} ORDER BY ${matches} DESC,${representative}) AS duplicate_rank
    ${eligible} AND EXISTS(SELECT 1 FROM unnest($2::text[]) t WHERE strpos(${matchText},lower(t))>0)
  ), page_candidates AS (
    SELECT *,row_number() OVER(PARTITION BY id ORDER BY matches DESC,ordinal) AS page_rank FROM candidates WHERE duplicate_rank=1
  ) SELECT * FROM page_candidates WHERE page_rank<=3 ORDER BY matches DESC,id,ordinal LIMIT 24`, [orgId, tokens])
  let semantic: WebChunkHit[] = []
  const ready = await pool.query(`SELECT 1 ${eligible} AND k.model=$2 AND k.index_version=$3 LIMIT 1`, [orgId, HELP_EMBEDDING_MODEL, WEB_SOURCE_INDEX_VERSION])
  if (ready.rows.length) {
    try {
      const [vector] = await embed([query], 2500)
      const result = await pool.query<WebChunkHit>(`WITH candidates AS (
        SELECT ${fields},k.embedding <=> $4::vector AS distance,
          row_number() OVER(PARTITION BY ${duplicateScope} ORDER BY k.embedding <=> $4::vector,${representative}) AS duplicate_rank
        ${eligible} AND k.model=$2 AND k.index_version=$3
      ), page_candidates AS (
        SELECT *,row_number() OVER(PARTITION BY id ORDER BY distance,ordinal) AS page_rank FROM candidates WHERE duplicate_rank=1
      ) SELECT * FROM page_candidates WHERE page_rank<=3 ORDER BY distance,id,ordinal LIMIT 24`, [orgId, HELP_EMBEDDING_MODEL, WEB_SOURCE_INDEX_VERSION, JSON.stringify(vector)])
      semantic = result.rows
    } catch {
      options.signal?.throwIfAborted()
      options.onSemanticFailure?.()
    }
  }
  options.signal?.throwIfAborted()
  const pages = new Map<string, WebPageHit>()
  const blockKey = (row: WebChunkHit) => JSON.stringify([row.websiteId, row.language?.toLowerCase() || row.id, row.heading, row.content])
  for (const hit of fuseHelpResults(lexical, semantic, blockKey, 48)) {
    if (!pages.has(hit.id)) pages.set(hit.id, { id: hit.id, title: hit.title, url: hit.url, description: hit.description, content: hit.content })
  }
  return [...pages.values()].slice(0, 5)
}

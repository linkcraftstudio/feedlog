import type { Pool } from 'pg'
import { chunkHelpArticle } from './chunks'
import { embedHelpTexts, HelpEmbeddingError, HELP_EMBEDDING_MODEL, HELP_INDEX_VERSION } from './embedding'

export const HELP_MAX_ATTEMPTS = 5
export const helpRetryDelay = (attempt: number) => Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1))

// The shared task ID identifies a content generation; attempts fences each lease.
// Claims commit before external calls. Immediate saves target their own article.
export async function indexNextHelpArticle(pool: Pool, embed = embedHelpTexts, onClaim?: () => Promise<unknown>, articleId?: string) {
  await pool.query(`UPDATE scheduled_task SET status='done',result='lease_exhausted',updated_at=clock_timestamp()
    WHERE kind='help_index' AND status='processing' AND schedule_at<=clock_timestamp() AND attempts >= $1`, [HELP_MAX_ATTEMPTS])
  const { rows: [job] } = await pool.query(`WITH candidate AS (
    SELECT id FROM scheduled_task WHERE kind='help_index' AND status IN ('pending','processing')
      AND schedule_at<=clock_timestamp() AND attempts<$1 AND ($2::uuid IS NULL OR ref_id=$2)
    ORDER BY schedule_at,id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE scheduled_task t SET status='processing',attempts=t.attempts+1,
      schedule_at=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp()
    FROM candidate c WHERE t.id=c.id RETURNING t.*`, [HELP_MAX_ATTEMPTS, articleId ?? null])
  if (!job) return { processed: false }
  try {
    await onClaim?.()
    const { rows: [article] } = await pool.query('SELECT title,description,content,org_id,status FROM help_article WHERE id=$1', [job.ref_id])
    if (!article || article.status !== 'published') {
      await pool.query("DELETE FROM scheduled_task WHERE id=$1 AND kind='help_index' AND attempts=$2", [job.id, job.attempts])
      return { processed: true, stale: true }
    }
    const chunks = chunkHelpArticle(article)
    const vectors = await embed(chunks.map(c => c.input))
    if (vectors.length !== chunks.length) throw new HelpEmbeddingError('invalid_response', true)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Match application article writes: lock the article before its task.
      const articleLock = await client.query("SELECT id FROM help_article WHERE id=$1 AND org_id=$2 AND status='published' FOR UPDATE", [job.ref_id, article.org_id])
      const owned = await client.query(`SELECT id FROM scheduled_task WHERE id=$1 AND kind='help_index' AND ref_id=$2
        AND attempts=$3 AND status='processing' AND schedule_at>clock_timestamp() FOR UPDATE`, [job.id, job.ref_id, job.attempts])
      if (!articleLock.rows.length || !owned.rows.length) { await client.query('ROLLBACK'); return { processed: true, stale: true } }
      await client.query('DELETE FROM help_article_chunk WHERE article_id=$1', [job.ref_id])
      for (const [i, chunk] of chunks.entries()) {
        await client.query(`INSERT INTO help_article_chunk(article_id,ordinal,org_id,generation_id,heading,body,model,index_version,embedding)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::vector)`, [job.ref_id, i, article.org_id, job.id, chunk.heading, chunk.body, HELP_EMBEDDING_MODEL, HELP_INDEX_VERSION, JSON.stringify(vectors[i])])
      }
      await client.query("UPDATE scheduled_task SET status='done',result='indexed',schedule_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [job.id])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    return { processed: true, ready: true }
  } catch (error) {
    const failure = error instanceof HelpEmbeddingError ? error : new HelpEmbeddingError('index_unavailable', true)
    const retry = failure.retryable && job.attempts < HELP_MAX_ATTEMPTS
    // Failed DB writes leave the lease for shared scheduler recovery. A content
    // edit/manual retry changes the task ID, so older attempts cannot reset it.
    await pool.query(`UPDATE scheduled_task SET status=$3,result=$4,
        schedule_at=clock_timestamp()+($5*interval '1 second'),updated_at=clock_timestamp()
      WHERE id=$1 AND kind='help_index' AND attempts=$2 AND status='processing'`,
    [job.id, job.attempts, retry ? 'pending' : 'done', failure.code, helpRetryDelay(job.attempts)])
    return { processed: true, retry, code: failure.code }
  }
}

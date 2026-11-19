import type { Pool } from 'pg'
import { chunkHelpArticle } from '../help-search/chunks'
import { embedHelpTexts, HelpEmbeddingError, HELP_EMBEDDING_MODEL } from '../help-search/embedding'
import { CrawlError, excludedWebSourcePath, fetchWebSourceUrl, withinWebSourceScope } from './fetch'
import { webSourceRobotsAllows, loadWebSourceRobots } from './robots'
import { blocksWebSourceIndexing } from './index-policy'
import { processWebSourcePage } from './page'
import { webSourceTransaction, settleWebSourceRun, startWebSourceRun } from './jobs'
import { prepareWebSourceContent, webSourceCleanupModel, WEB_SOURCE_PROCESSOR_VERSION, WEB_SOURCE_INDEX_VERSION } from './prepare'
import { logWebSourceFailure } from './failure'
import { webSourceConcurrency, WEB_SOURCE_CLAIM_LOCK } from './concurrency'

export interface WebSourceWorkerOptions { fetcher?: typeof fetchWebSourceUrl; embed?: typeof embedHelpTexts; prepare?: typeof prepareWebSourceContent; onClaim?: () => Promise<unknown> }
export async function runNextWebSourceTask(pool: Pool, options: WebSourceWorkerOptions = {}) {
  const fetcher = options.fetcher ?? fetchWebSourceUrl, embed = options.embed ?? embedHelpTexts, prepare = options.prepare ?? prepareWebSourceContent
  const job = await webSourceTransaction(pool, async client => {
    // Only serialize claiming, never HTTP/model work. Include live leases from
    // other processes so multiple queue deliveries cannot exceed the limit.
    await client.query('SELECT pg_advisory_xact_lock($1)', [WEB_SOURCE_CLAIM_LOCK])
    const { rows: [capacity] } = await client.query(`SELECT count(*)<$1::int AS available FROM scheduled_task
      WHERE kind='web_page' AND status='processing' AND schedule_at>clock_timestamp()`, [webSourceConcurrency()])
    const { rows: [next] } = await client.query(`WITH next AS (
      SELECT id FROM scheduled_task WHERE kind IN ('web_page','ai_training_website')
        AND status IN ('pending','processing') AND schedule_at<=clock_timestamp()
        AND (kind<>'web_page' OR $1::boolean)
      ORDER BY schedule_at,id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE scheduled_task t SET status='processing',attempts=t.attempts+1,
      schedule_at=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp()
      FROM next WHERE t.id=next.id RETURNING t.*`, [capacity.available])
    return next
  })
  if (!job) return { processed: false }
  let failureStage: 'fetch' | 'index' = 'fetch'
  try {
    await options.onClaim?.()
    if (job.kind === 'ai_training_website') {
      await webSourceTransaction(pool, async client => {
        const { rows: [source] } = await client.query('SELECT id,org_id,paused,frequency FROM ai_training_website WHERE id=$1 FOR UPDATE', [job.ref_id])
        if (!source || source.paused || source.frequency === 'manual') {
          await client.query('DELETE FROM scheduled_task WHERE id=$1', [job.id]); return
        }
        const owned = await client.query("SELECT id FROM scheduled_task WHERE id=$1 AND attempts=$2 AND status='processing' FOR UPDATE", [job.id, job.attempts])
        if (owned.rows.length) await startWebSourceRun(client, source.org_id, source.id, 'scheduled')
      })
      return { processed: true }
    }
    const { rows: [page] } = await pool.query(`SELECT d.*,s.url AS source_url,s.input_type,s.excludes FROM ai_training_web_page d
      JOIN ai_training_website s ON s.id=d.website_id AND s.org_id=d.org_id WHERE d.id=$1`, [job.ref_id])
    if (!page) { await pool.query('DELETE FROM scheduled_task WHERE id=$1', [job.id]); return { processed: true } }
    const { rows: [attempt] } = await pool.query(`UPDATE ai_training_web_page SET sync_status='processing',attempt_count=attempt_count+1 WHERE id=$1
      AND EXISTS(SELECT 1 FROM scheduled_task WHERE id=$2 AND attempts=$3 AND status='processing' AND schedule_at>clock_timestamp()) RETURNING attempt_count`, [page.id, job.id, job.attempts])
    if (!attempt) return { processed: true, superseded: true }
    if (attempt.attempt_count > 3) throw new CrawlError('retry_exhausted')
    if (excludedWebSourcePath(page.url, page.excludes)) throw new CrawlError('path_excluded')
    const robots = await loadWebSourceRobots(page.url, fetcher)
    if (!webSourceRobotsAllows(robots, page.url)) throw new CrawlError('robots_disallowed')
    const headers: Record<string, string> = {}
    const compatible = !!page.indexed_at && page.metadata.processorVersion === WEB_SOURCE_PROCESSOR_VERSION && page.metadata.cleanupModel === webSourceCleanupModel()
      && Number.isInteger(page.metadata.chunkCount) && page.metadata.chunkCount > 0 && typeof page.metadata.indexGeneration === 'string'
      && (await pool.query(`SELECT 1 FROM content_chunk WHERE content_type='web_page' AND content_id=$1 AND org_id=$2
        HAVING count(*)=$3::int AND min(ordinal)=0 AND max(ordinal)=$3::int-1
          AND bool_and(model=$4 AND index_version=$5 AND generation_id::text=$6)`,
      [page.id, page.org_id, page.metadata.chunkCount, HELP_EMBEDDING_MODEL, WEB_SOURCE_INDEX_VERSION, page.metadata.indexGeneration])).rows.length > 0
    const conditional = compatible && page.metadata.fetchMode !== 'browser' && !page.metadata.externalData
    if (conditional && page.metadata.etag) headers['If-None-Match'] = page.metadata.etag
    if (conditional && page.metadata.lastModified) headers['If-Modified-Since'] = page.metadata.lastModified
    const scope = (value: string) => withinWebSourceScope(value, page.source_url, page.input_type) && webSourceRobotsAllows(robots, value) && !excludedWebSourcePath(value, page.excludes)
    const response = await fetcher(page.url, headers, scope)
    if (response.status === 304 && !conditional) throw new CrawlError('invalid_not_modified', true)
    if (response.status !== 304 && response.status >= 400) throw new CrawlError(`http_${response.status}`, response.status >= 500 || response.status === 429)
    if (response.status !== 304 && !/text\/html|application\/xhtml\+xml/i.test(response.headers['content-type'] ?? 'text/html')) throw new CrawlError('unsupported_content_type')
    if (blocksWebSourceIndexing(response.headers['x-robots-tag'])) throw new CrawlError('page_noindex')
    const parsed = response.status === 304 ? null : await processWebSourcePage(response, { fetcher, collectData: true, dataAllows: value => webSourceRobotsAllows(robots, value) })
    const content = parsed?.content ?? null
    const unchanged = !!page.indexed_at && compatible && (!content || content.hash === page.metadata.contentHash)
    if (!content && !unchanged) throw new CrawlError('invalid_not_modified', true)
    failureStage = 'index'
    const prepared = unchanged ? null : await prepare(content!)
    const chunks = prepared ? chunkHelpArticle({ ...content!, content: prepared.content, description: prepared.summary }, { clean: false }) : []
    const vectors = chunks.length ? await embed(chunks.map(c => c.input)) : []
    if (vectors.length !== chunks.length) throw new HelpEmbeddingError('invalid_response', true)
    const published = await webSourceTransaction(pool, async client => {
      // Same lock order as settings/removal and other page completions.
      const source = await client.query('SELECT id FROM ai_training_website WHERE id=$1 AND org_id=$2 FOR UPDATE', [page.website_id, page.org_id])
      const current = await client.query('SELECT id FROM ai_training_web_page WHERE id=$1 AND run_id=$2 FOR UPDATE', [page.id, page.run_id])
      const owned = await client.query("SELECT id FROM scheduled_task WHERE id=$1 AND attempts=$2 AND status='processing' AND schedule_at>clock_timestamp() FOR UPDATE", [job.id, job.attempts])
      if (!source.rows.length || !current.rows.length || !owned.rows.length) return false
      if (!unchanged) {
        await client.query("DELETE FROM content_chunk WHERE content_type='web_page' AND content_id=$1 AND org_id=$2", [page.id, page.org_id])
        for (const [i, chunk] of chunks.entries()) await client.query(`INSERT INTO content_chunk(content_type,content_id,ordinal,org_id,generation_id,heading,body,model,index_version,embedding)
          VALUES('web_page',$1,$2,$3,$4,$5,$6,$7,$8,$9::vector)`, [page.id, i, page.org_id, job.id, chunk.heading, chunk.body, HELP_EMBEDDING_MODEL, WEB_SOURCE_INDEX_VERSION, JSON.stringify(vectors[i])])
        await client.query(`UPDATE ai_training_web_page SET metadata=(metadata-'error'-'errorStage')||$2::jsonb,
          indexed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`, [page.id, JSON.stringify({
          title: content!.title, language: content!.language, content: prepared!.content, summary: prepared!.summary, keywords: prepared!.keywords,
          contentHash: content!.hash, processorVersion: WEB_SOURCE_PROCESSOR_VERSION, cleanupModel: webSourceCleanupModel(),
          chunkCount: chunks.length, indexGeneration: job.id,
        })])
      }
      await client.query(`UPDATE ai_training_web_page SET sync_status='ready',last_synced_at=clock_timestamp(),
        metadata=(metadata-'error'-'errorStage')||jsonb_strip_nulls(jsonb_build_object('etag',$2::text,'lastModified',$3::text,'fetchMode',$4::text,'externalData',$5::boolean)) WHERE id=$1`,
      [page.id, response.headers.etag ?? null, response.headers['last-modified'] ?? null, parsed?.fetchMode ?? page.metadata.fetchMode ?? 'http', parsed?.dataBacked ?? page.metadata.externalData ?? false])
      await client.query("UPDATE scheduled_task SET status='done',result='indexed',updated_at=clock_timestamp() WHERE id=$1", [job.id])
      await settleWebSourceRun(client, page.website_id, page.run_id, unchanged ? 'unchanged' : page.indexed_at ? 'updated' : 'added')
      return true
    })
    return published ? { processed: true, ready: true } : { processed: true, superseded: true }
  } catch (error) {
    const failure = error instanceof CrawlError || error instanceof HelpEmbeddingError ? error : new CrawlError('sync_unavailable', true)
    logWebSourceFailure(error, { stage: job.kind === 'web_page' ? failureStage : 'source_sync', taskId: job.id, refId: job.ref_id, attempt: job.attempts })
    let retry = false
    await webSourceTransaction(pool, async client => {
      const { rows: [page] } = await client.query('SELECT * FROM ai_training_web_page WHERE id=$1', [job.ref_id])
      if (page) await client.query('SELECT id FROM ai_training_website WHERE id=$1 FOR UPDATE', [page.website_id])
      retry = failure.retryable && (page?.attempt_count ?? job.attempts) < 3
      const owned = await client.query(`UPDATE scheduled_task SET status=$3,result=$4,
        schedule_at=clock_timestamp()+($5*interval '1 second'),updated_at=clock_timestamp()
        WHERE id=$1 AND attempts=$2 AND status='processing' AND schedule_at>clock_timestamp() RETURNING id`, [job.id, job.attempts, retry ? 'pending' : 'done', failure.code, 30 * 2 ** Math.min(Math.max(0, (page?.attempt_count ?? job.attempts) - 1), 6)])
      if (page && owned.rows.length) {
        await client.query(`UPDATE ai_training_web_page SET sync_status=$2,metadata=metadata||jsonb_build_object('error',$3::text,'errorStage',$4::text) WHERE id=$1`, [page.id, retry ? 'pending' : 'failed', failure.code, failureStage])
        if (!retry) await settleWebSourceRun(client, page.website_id, page.run_id, 'failed')
      }
    })
    return { processed: true, retry, deferred: false, code: failure.code }
  }
}

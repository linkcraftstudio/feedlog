import type { Pool } from 'pg'
import { createError } from 'h3'
import { webSourceFailureCode, webSourceFailureStage, WEB_SOURCE_INDEX_FAILURE_PATTERN } from '../../shared/utils/web-source-failure'

// Website-specific configuration and runtime overview. Help Center keeps its own APIs.
export async function listAiTrainingWebsites(pool: Pick<Pool, 'query'>, orgId: string) {
  const { rows } = await pool.query(`SELECT s.id,coalesce(nullif(s.name,''),s.url) AS name,s.url,
    s.input_type AS "inputType",s.frequency,s.paused,s.excludes,
    s.ai_enabled AS "aiEnabled",s.next_run AS "nextRun",
    (SELECT max(last_synced_at) FROM ai_training_web_page WHERE website_id=s.id AND org_id=s.org_id) AS "lastSyncedAt",
    jsonb_build_object('total',p.total,'ready',p.ready,'indexed',p.indexed,'failed',p.failed,'pending',p.pending,'fetchFailed',p.fetch_failed,'indexFailed',p.failed-p.fetch_failed) AS pages,
    CASE WHEN active.id IS NOT NULL THEN 'syncing' WHEN p.failed>0 THEN 'attention' ELSE 'ready' END AS status,
    to_jsonb(active) AS "activeRun",to_jsonb(latest) AS "lastRun",to_jsonb(full_run) AS "lastFullRun",
    (SELECT max(finished_at) FROM ai_training_website_run WHERE website_id=s.id AND scope='full' AND status='done') AS "lastFullSuccess"
    FROM ai_training_website s
    CROSS JOIN LATERAL (SELECT count(*)::int AS total,count(*) FILTER(WHERE sync_status='ready')::int AS ready,count(*) FILTER(WHERE indexed_at IS NOT NULL)::int AS indexed,
      count(*) FILTER(WHERE sync_status='failed')::int AS failed,
      count(*) FILTER(WHERE sync_status='failed' AND coalesce(metadata->>'errorStage',CASE WHEN coalesce(metadata->>'error','') ~ $2::text THEN 'index' ELSE 'fetch' END)='fetch')::int AS fetch_failed,
      count(*) FILTER(WHERE sync_status IN ('pending','processing'))::int AS pending
      FROM ai_training_web_page WHERE website_id=s.id AND org_id=s.org_id) p
    LEFT JOIN LATERAL (SELECT id,scope,trigger,status,total,added,updated,failed,started_at AS "startedAt",finished_at AS "finishedAt",
      greatest(0,total-(SELECT count(*)::int FROM ai_training_web_page WHERE website_id=s.id AND run_id=r.id AND sync_status IN ('pending','processing'))) AS processed
      FROM ai_training_website_run r WHERE website_id=s.id AND status='running' ORDER BY started_at DESC,id DESC LIMIT 1) active ON true
    LEFT JOIN LATERAL (SELECT id,scope,trigger,status,total,added,updated,failed,started_at AS "startedAt",finished_at AS "finishedAt"
      FROM ai_training_website_run WHERE website_id=s.id ORDER BY started_at DESC,id DESC LIMIT 1) latest ON true
    LEFT JOIN LATERAL (SELECT id,scope,trigger,status,total,added,updated,failed,started_at AS "startedAt",finished_at AS "finishedAt"
      FROM ai_training_website_run WHERE website_id=s.id AND scope='full' ORDER BY started_at DESC,id DESC LIMIT 1) full_run ON true
    WHERE s.org_id=$1 ORDER BY s.created_at,s.id`, [orgId, WEB_SOURCE_INDEX_FAILURE_PATTERN])
  return { data: rows }
}

export async function listAiTrainingWebsitePages(pool: Pick<Pool, 'query'>, orgId: string, websiteId: string, input: { q?: string; status?: string; page: number; pageSize: number }) {
  const website = await pool.query('SELECT id FROM ai_training_website WHERE id=$1 AND org_id=$2', [websiteId, orgId])
  if (!website.rows.length) throw createError({ statusCode: 404, message: 'Website not found' })
  const where = `website_id=$1 AND org_id=$2 AND ($3='' OR coalesce(metadata->>'title','') ILIKE '%'||$3||'%' OR url ILIKE '%'||$3||'%')
    AND ($4='all' OR CASE WHEN sync_status='failed' THEN 'failed' WHEN sync_status IN ('pending','processing') THEN 'indexing' ELSE 'ready' END=$4)`
  const args = [websiteId, orgId, input.q || '', input.status || 'all']
  const [{ rows: [count] }, { rows }] = await Promise.all([
    pool.query(`SELECT count(*)::int AS total FROM ai_training_web_page WHERE ${where}`, args),
    pool.query(`SELECT id,website_id AS "websiteId",coalesce(metadata->>'title',url) AS title,url,sync_status AS "syncStatus",
      CASE WHEN sync_status='failed' THEN 'failed' WHEN sync_status IN ('pending','processing') THEN 'indexing' ELSE 'ready' END AS status,
      indexed_at AS "indexedAt",last_synced_at AS "lastSyncedAt",updated_at AS "updatedAt",metadata->>'error' AS "errorCode",metadata->>'errorStage' AS "errorStage"
      FROM ai_training_web_page WHERE ${where} ORDER BY url,id LIMIT $5 OFFSET $6`, [...args, input.pageSize, (input.page - 1) * input.pageSize]),
  ])
  return { data: rows.map(row => ({ ...row, errorCode: row.errorCode ? webSourceFailureCode(row.errorCode) : null, errorStage: row.errorCode ? webSourceFailureStage(row.errorCode, row.errorStage) : null })), pagination: { page: input.page, pageSize: input.pageSize, total: count?.total || 0 } }
}

export async function listAiTrainingWebsiteRuns(pool: Pick<Pool, 'query'>, orgId: string, websiteId: string) {
  const website = await pool.query('SELECT id FROM ai_training_website WHERE id=$1 AND org_id=$2', [websiteId, orgId])
  if (!website.rows.length) throw createError({ statusCode: 404, message: 'Website not found' })
  const { rows } = await pool.query(`SELECT id,scope,trigger,status AS result,total,added,updated,failed,started_at AS "startedAt",finished_at AS "finishedAt",
    extract(epoch FROM (coalesce(finished_at,clock_timestamp())-started_at))::int AS "durationSeconds"
    FROM ai_training_website_run WHERE website_id=$1 ORDER BY started_at DESC,id DESC LIMIT 20`, [websiteId])
  return { data: rows }
}

// One overview, with a distinct shape for each provider instead of a common row model.
export async function listAiTrainingSources(pool: Pick<Pool, 'query'>, orgId: string) {
  const [websites, help] = await Promise.all([
    listAiTrainingWebsites(pool, orgId),
    pool.query<{ articleCount: number; aiUsableCount: number; collectionCount: number }>(`SELECT count(*)::int AS "articleCount",
      count(*) FILTER(WHERE a.ai_enabled AND c.ai_enabled)::int AS "aiUsableCount",
      (SELECT count(*)::int FROM help_collection WHERE org_id=$1) AS "collectionCount"
      FROM help_article a JOIN help_collection c ON c.id=a.collection_id AND c.org_id=a.org_id WHERE a.org_id=$1`, [orgId]),
  ])
  const counts = help.rows[0] ?? { articleCount: 0, aiUsableCount: 0, collectionCount: 0 }
  return { sources: { help: { available: counts.articleCount > 0, ...counts }, websites: websites.data } }
}

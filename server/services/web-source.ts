import { webSourceInputTypeForUrl } from '../../shared/utils/web-source-pages'
import type { Pool, PoolClient } from 'pg'
import type { z } from 'zod'
import { uuidv7 } from 'uuidv7'
import { createError } from 'h3'
import type { webSourceInput, webSourceSettings, webSourceIndividualImport } from '../../shared/schemas/web-source'
import { normalizeWebSourceUrl, withinWebSourceScope, excludedWebSourcePath } from '../lib/web-source/fetch'
import { webSourceTransaction, scheduleWebSource, startWebSourceRun } from '../lib/web-source/jobs'

export async function createWebSource(pool: Pool, orgId: string, input: z.infer<typeof webSourceInput>) {
  const url = normalizeWebSourceUrl(input.url), id = uuidv7()
  const inputType = input.inputType ?? webSourceInputTypeForUrl(url)
  const pages = [...new Map(input.pages.map(page => {
    const pageUrl = normalizeWebSourceUrl(page.url)
    if (!withinWebSourceScope(pageUrl, url, inputType)) throw createError({ statusCode: 400, message: 'Page outside source scope' })
    return [pageUrl, { ...page, url: pageUrl }]
  })).values()]
  if (pages.length > input.pageLimit) throw createError({ statusCode: 400, message: 'Page limit exceeded' })
  return webSourceTransaction(pool, async client => {
    // Serialize quota checks for this organization with an existing row lock.
    const organization = await client.query('SELECT id FROM organization WHERE id=$1 FOR UPDATE', [orgId])
    if (!organization.rows.length) throw createError({ statusCode: 404, message: 'Organization not found' })
    const { rows: [count] } = await client.query('SELECT count(*)::int AS total FROM ai_training_website WHERE org_id=$1', [orgId])
    const configuredLimit = Number(process.env.WEB_SOURCE_MAX_SOURCES ?? 20)
    const limit = Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 20
    if (count.total >= limit) throw createError({ statusCode: 400, message: 'Source limit reached', data: { code: 'source_limit' } })
    const duplicate = await client.query('SELECT id FROM ai_training_website WHERE org_id=$1 AND url=$2', [orgId, url])
    if (duplicate.rows.length) throw createError({ statusCode: 409, message: 'This source already exists' })
    await client.query(`INSERT INTO ai_training_website(id,org_id,url,name,input_type,frequency,excludes,page_limit)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, orgId, url, input.name || new URL(url).hostname, inputType, input.frequency, input.excludes, input.pageLimit])
    for (const page of pages) await client.query(`INSERT INTO ai_training_web_page(id,org_id,website_id,url,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`, [uuidv7(), orgId, id, page.url, JSON.stringify({ title: page.title || new URL(page.url).pathname })])
    await startWebSourceRun(client, orgId, id, 'first')
    return { id }
  })
}
export async function updateWebSourceSettings(pool: Pool, orgId: string, id: string, input: z.input<typeof webSourceSettings>) {
  return webSourceTransaction(pool, async client => {
    const { rows: [source] } = await client.query('SELECT id,excludes FROM ai_training_website WHERE id=$1 AND org_id=$2 FOR UPDATE', [id, orgId])
    if (!source) throw createError({ statusCode: 404, message: 'Source not found' })
    if (source.excludes !== (input.excludes ?? '')) {
      const active = await client.query("SELECT 1 FROM ai_training_website_run WHERE website_id=$1 AND status='running'", [id])
      if (active.rows.length) throw createError({ statusCode: 409, message: 'Wait for the current sync before changing excluded paths', data: { code: 'sync_in_progress' } })
    }
    const found = await client.query(`UPDATE ai_training_website SET frequency=$3,paused=$4,excludes=$5,updated_at=clock_timestamp()
      WHERE id=$1 AND org_id=$2 RETURNING id`, [id, orgId, input.frequency ?? 'weekly', input.frequency !== 'manual' && !!input.paused, input.excludes ?? ''])
    if (!found.rows.length) throw createError({ statusCode: 404, message: 'Source not found' })
    await scheduleWebSource(client, id)
    return { saved: true }
  })
}
// Callers hold the source locks until related records are removed.
async function deleteWebSourcePages(client: PoolClient, orgId: string, ids: string[]) {
  if (!ids.length) return
  await client.query("DELETE FROM scheduled_task WHERE kind='web_page' AND ref_id=ANY($1::uuid[])", [ids])
  await client.query("DELETE FROM content_chunk WHERE content_type='web_page' AND org_id=$1 AND content_id=ANY($2::uuid[])", [orgId, ids])
  await client.query('DELETE FROM ai_training_web_page WHERE org_id=$1 AND id=ANY($2::uuid[])', [orgId, ids])
}
async function deleteWebSource(client: PoolClient, orgId: string, id: string) {
  const { rows: pages } = await client.query('SELECT id FROM ai_training_web_page WHERE website_id=$1 AND org_id=$2', [id, orgId])
  await deleteWebSourcePages(client, orgId, pages.map(page => page.id))
  await client.query("DELETE FROM scheduled_task WHERE kind='ai_training_website' AND ref_id=$1", [id])
  await client.query('DELETE FROM ai_training_website_run WHERE website_id=$1', [id])
  await client.query('DELETE FROM ai_training_website WHERE id=$1 AND org_id=$2', [id, orgId])
}
export async function removeWebSource(pool: Pool, orgId: string, id: string) {
  return webSourceTransaction(pool, async client => {
    const source = await client.query('SELECT id FROM ai_training_website WHERE id=$1 AND org_id=$2 FOR UPDATE', [id, orgId])
    if (!source.rows.length) throw createError({ statusCode: 404, message: 'Source not found' })
    await deleteWebSource(client, orgId, id)
    return { removed: true }
  })
}
export async function removeWebSourceOrganization(pool: Pool, orgId: string) {
  return webSourceTransaction(pool, async client => {
    const { rows: sources } = await client.query('SELECT id FROM ai_training_website WHERE org_id=$1 ORDER BY id FOR UPDATE', [orgId])
    for (const source of sources) await deleteWebSource(client, orgId, source.id)
  })
}
export async function syncWebSourcePage(pool: Pool, orgId: string, id: string) {
  return webSourceTransaction(pool, async client => {
    const { rows: [page] } = await client.query('SELECT website_id FROM ai_training_web_page WHERE id=$1 AND org_id=$2', [id, orgId])
    if (!page) throw createError({ statusCode: 404, message: 'Page not found' })
    return { runId: await startWebSourceRun(client, orgId, page.website_id, 'manual', [id]) }
  })
}
export async function removeWebSourcePage(pool: Pool, orgId: string, id: string) {
  return webSourceTransaction(pool, async client => {
    const { rows: [page] } = await client.query('SELECT website_id FROM ai_training_web_page WHERE id=$1 AND org_id=$2', [id, orgId])
    if (!page) throw createError({ statusCode: 404, message: 'Page not found' })
    const source = await client.query('SELECT id FROM ai_training_website WHERE id=$1 AND org_id=$2 FOR UPDATE', [page.website_id, orgId])
    if (!source.rows.length) throw createError({ statusCode: 404, message: 'Source not found' })
    const active = await client.query("SELECT 1 FROM ai_training_website_run WHERE website_id=$1 AND status='running'", [page.website_id])
    if (active.rows.length) throw createError({ statusCode: 409, message: 'Wait for the current sync', data: { code: 'sync_in_progress' } })
    await deleteWebSourcePages(client, orgId, [id])
    return { removed: true }
  })
}
export async function readWebSourcePage(pool: Pick<Pool, 'query'>, orgId: string, id: string, forAgent = false) {
  const { rows: [page] } = await pool.query(`SELECT d.id,coalesce(d.metadata->>'title',d.url) AS title,coalesce(d.metadata->>'content','') AS content,d.url,d.metadata->>'summary' AS description,coalesce(d.metadata->'keywords','[]'::jsonb) AS keywords,d.indexed_at AS "indexedAt",d.metadata->>'error' AS error
    FROM ai_training_web_page d JOIN ai_training_website s ON s.id=d.website_id AND s.org_id=d.org_id
    WHERE d.id=$1 AND d.org_id=$2 AND (NOT $3::boolean OR (d.indexed_at IS NOT NULL AND s.ai_enabled))`, [id, orgId, forAgent])
  if (!page) throw createError({ statusCode: 404, message: 'Page not found' })
  return page
}

async function lockWebSourcePages(client: PoolClient, orgId: string, ids: string[]) {
  const unique = [...new Set(ids)]
  const { rows: sources } = await client.query(`SELECT s.id FROM ai_training_website s WHERE s.org_id=$1 AND EXISTS(
    SELECT 1 FROM ai_training_web_page d WHERE d.website_id=s.id AND d.org_id=$1 AND d.id=ANY($2::uuid[]))
    ORDER BY s.id FOR UPDATE`, [orgId, unique])
  const { rows: pages } = await client.query<{ id: string; website_id: string }>(`SELECT id,website_id FROM ai_training_web_page
    WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY website_id,id`, [orgId, unique])
  if (!unique.length || pages.length !== unique.length || pages.some(page => !sources.some(source => source.id === page.website_id))) throw createError({ statusCode: 404, message: 'Page not found' })
  const active = await client.query("SELECT 1 FROM ai_training_website_run WHERE website_id=ANY($1::uuid[]) AND status='running' LIMIT 1", [sources.map(source => source.id)])
  if (active.rows.length) throw createError({ statusCode: 409, message: 'Wait for the current sync', data: { code: 'sync_in_progress' } })
  return { pages, sources }
}
export async function syncWebSourcePages(pool: Pool, orgId: string, ids: string[]) {
  return webSourceTransaction(pool, async client => {
    const { pages, sources } = await lockWebSourcePages(client, orgId, ids)
    const runs: { sourceId: string; runId: string }[] = []
    for (const source of sources) runs.push({ sourceId: source.id, runId: await startWebSourceRun(client, orgId, source.id, 'manual', pages.filter(page => page.website_id === source.id).map(page => page.id)) })
    return { affected: pages.length, runs }
  })
}
export async function removeWebSourcePages(pool: Pool, orgId: string, ids: string[]) {
  return webSourceTransaction(pool, async client => {
    const { pages } = await lockWebSourcePages(client, orgId, ids)
    const selected = pages.map(page => page.id)
    await deleteWebSourcePages(client, orgId, selected)
    return { affected: pages.length }
  })
}

// Explicit URLs are imported as pages, never used as discovery seeds.
export async function importIndividualWebSourcePages(pool: Pool, orgId: string, input: z.infer<typeof webSourceIndividualImport>) {
  const urls = [...new Set(input.urls.map(url => normalizeWebSourceUrl(url)))]
  return webSourceTransaction(pool, async client => {
    const organization = await client.query('SELECT id FROM organization WHERE id=$1 FOR UPDATE', [orgId])
    if (!organization.rows.length) throw createError({ statusCode: 404, message: 'Organization not found' })
    const { rows: existing } = await client.query('SELECT id,url,created_at,input_type,excludes,page_limit FROM ai_training_website WHERE org_id=$1 ORDER BY id FOR UPDATE', [orgId])
    // Lock by ID like batch operations, then retain creation-order matching.
    existing.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at) || a.id.localeCompare(b.id))
    const groups = new Map<string, { id: string; fresh: boolean; url: string; limit: number; urls: string[] }>()
    for (const url of urls) {
      const source = existing.find(s => withinWebSourceScope(url, s.url, s.input_type))
      if (source && excludedWebSourcePath(url, source.excludes)) throw createError({ statusCode: 400, message: 'Page is excluded by source settings', data: { code: 'path_excluded' } })
      const sourceUrl = source?.url ?? normalizeWebSourceUrl(new URL(url).origin)
      let group = groups.get(sourceUrl)
      if (!group) { group = { id: source?.id ?? uuidv7(), fresh: !source, url: sourceUrl, limit: source?.page_limit ?? 1000, urls: [] }; groups.set(sourceUrl, group) }
      group.urls.push(url)
    }
    const configuredLimit = Number(process.env.WEB_SOURCE_MAX_SOURCES ?? 20)
    const limit = Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 20
    if (existing.length + [...groups.values()].filter(g => g.fresh).length > limit) throw createError({ statusCode: 400, message: 'Source limit reached', data: { code: 'source_limit' } })
    let added = 0, skipped = input.urls.length - urls.length
    const sourceIds: string[] = []
    for (const group of groups.values()) {
      const { rows: current } = await client.query('SELECT url FROM ai_training_web_page WHERE website_id=$1 AND org_id=$2', [group.id, orgId])
      const known = new Set(current.map(row => row.url)), incoming = group.urls.filter(url => !known.has(url))
      skipped += group.urls.length - incoming.length
      if (!incoming.length) continue
      if (current.length + incoming.length > group.limit) throw createError({ statusCode: 400, message: 'Page limit exceeded' })
      if (group.fresh) {
        await client.query(`INSERT INTO ai_training_website(id,org_id,url,name,frequency,page_limit)
          VALUES($1,$2,$3,$4,$5,$6)`, [group.id, orgId, group.url, new URL(group.url).hostname, input.frequency, group.limit])
      }
      const ids: string[] = []
      for (const url of incoming) {
        const id = uuidv7(); ids.push(id)
        await client.query('INSERT INTO ai_training_web_page(id,org_id,website_id,url,metadata) VALUES($1,$2,$3,$4,$5::jsonb)', [id, orgId, group.id, url, JSON.stringify({ title: new URL(url).pathname })])
      }
      await startWebSourceRun(client, orgId, group.id, group.fresh ? 'first' : 'manual', group.fresh ? undefined : ids)
      sourceIds.push(group.id); added += ids.length
    }
    return { sourceIds, added, skipped }
  })
}

export async function updateWebsiteAiReference(pool: Pool, orgId: string, id: string, enabled: boolean) {
  const result = await pool.query('UPDATE ai_training_website SET ai_enabled=$3,updated_at=clock_timestamp() WHERE id=$1 AND org_id=$2 RETURNING id', [id, orgId, enabled])
  if (!result.rows.length) throw createError({ statusCode: 404, message: 'Website not found' })
  return { aiEnabled: enabled }
}

export async function retryFailedWebsitePages(pool: Pool, orgId: string, id: string) {
  return webSourceTransaction(pool, async client => {
    const website = await client.query('SELECT id FROM ai_training_website WHERE id=$1 AND org_id=$2 FOR UPDATE', [id, orgId])
    if (!website.rows.length) throw createError({ statusCode: 404, message: 'Website not found' })
    const { rows } = await client.query("SELECT id FROM ai_training_web_page WHERE website_id=$1 AND org_id=$2 AND sync_status='failed' ORDER BY id", [id, orgId])
    if (!rows.length) return { affected: 0, runId: null }
    const runId = await startWebSourceRun(client, orgId, id, 'manual', rows.map(row => row.id))
    return { affected: rows.length, runId }
  })
}

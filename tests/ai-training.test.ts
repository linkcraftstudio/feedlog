import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createWebSourceTestDatabase } from './fixtures/web-source-database'
import { createWebSource, readWebSourcePage } from '../server/services/web-source'
import { listAiTrainingWebsites } from '../server/services/ai-training'
import { updateAiTrainingReference } from './fixtures/ai-training-reference'
import { aiTrainingReference } from '../shared/schemas/ai-training'
import { webSourceInput } from '../shared/schemas/web-source'
import { runNextWebSourceTask } from '../server/lib/web-source/worker'
import { searchWebPages } from '../server/lib/web-source/search'
import { searchHelpArticles } from '../server/lib/agent/help-search'

test('AI Reference accepts only Collection and individual website settings', () => {
  assert.equal(aiTrainingReference.safeParse({ scope: 'collection', enabled: false }).success, false)
  assert.equal(aiTrainingReference.safeParse({ scope: 'help', enabled: false }).success, false)
  assert.equal(aiTrainingReference.safeParse({ scope: 'website', enabled: false }).success, false)
  assert.equal(aiTrainingReference.safeParse({ scope: 'article', enabled: false }).success, false)
})

test('individual website gates prevent AI reads/search without changing synchronization or stored content', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  const vector = () => [1, ...Array(767).fill(0)]
  let embeddings = 0
  const embed = async (inputs: string[]) => { embeddings++; return inputs.map(vector) }
  try {
    await db.exec(`CREATE TABLE help_article(id uuid PRIMARY KEY,org_id text,collection_id uuid,title text,content text,description text,short_id text,slug text,position int DEFAULT 0,status text,ai_enabled boolean,published_at timestamptz,updated_at timestamptz DEFAULT now())`)
    await pool.query('UPDATE organization SET metadata=$2 WHERE id=$1', [orgId, JSON.stringify({ untouched: 'keep', aiTraining: { help: false, website: false }, portalModules: { helpCenter: true } })])
    const { id } = await createWebSource(pool, orgId, webSourceInput.parse({ url: 'https://example.com', frequency: 'manual', pages: [{ title: '', url: 'https://example.com/guide' }] }))
    const pageId = (await pool.query('SELECT id FROM ai_training_web_page WHERE website_id=$1', [id])).rows[0].id
    const pageBefore = (await pool.query('SELECT metadata FROM ai_training_web_page WHERE id=$1', [pageId])).rows[0].metadata
    await pool.query("UPDATE ai_training_website SET updated_at='2000-01-01T00:00:00Z' WHERE id=$1", [id])
    await updateAiTrainingReference(pool, orgId, { scope: 'source', id, enabled: false })
    const website = (await pool.query('SELECT * FROM ai_training_website WHERE id=$1', [id])).rows[0]
    assert.equal(website.ai_enabled, false)
    assert.equal(website.frequency, 'manual')
    assert.equal(website.paused, false)
    assert.ok(+new Date(website.updated_at) > +new Date('2000-01-01T00:00:00Z'))
    assert.equal('metadata' in website, false)
    assert.deepEqual((await pool.query('SELECT metadata FROM ai_training_web_page WHERE id=$1', [pageId])).rows[0].metadata, pageBefore)
    assert.equal((await runNextWebSourceTask(pool, {
      fetcher: async url => ({ url, status: 200, headers: { 'content-type': 'text/html' }, body: url.endsWith('/robots.txt') ? '' : '<main><h1>Widget installation</h1><p>Install the widget and configure notifications to collect feedback.</p></main>' }),
      prepare: async page => ({ content: page.content, summary: 'Widget installation.', keywords: ['widget'], evidence: ['Install the widget'] }), embed,
    })).ready, true, 'disabled AI reference does not pause sync or delete the index')
    assert.ok((await readWebSourcePage(pool, orgId, pageId)).content.includes('widget'))
    await assert.rejects(readWebSourcePage(pool, orgId, pageId, true), /Page not found/)
    const before = embeddings
    assert.deepEqual(await searchWebPages(pool, orgId, 'widget', embed), [])
    assert.equal(embeddings, before, 'disabled content does not trigger vector retrieval')
    await updateAiTrainingReference(pool, orgId, { scope: 'source', id, enabled: true })
    assert.equal((await searchWebPages(pool, orgId, 'widget', embed)).length, 1)
    const other = await createWebSource(pool, orgId, webSourceInput.parse({ url: 'https://other.example.com', frequency: 'manual', pages: [{ title: 'Widget', url: 'https://other.example.com/guide' }] }))
    const otherPage = (await pool.query('SELECT id FROM ai_training_web_page WHERE website_id=$1', [other.id])).rows[0].id
    await pool.query("UPDATE ai_training_web_page SET metadata=metadata||jsonb_build_object('content','Widget guide'),indexed_at=clock_timestamp() WHERE id=$1", [otherPage])
    assert.ok((await readWebSourcePage(pool, orgId, otherPage, true)).content, 'retired organization-wide settings do not hide new sources')
    await updateAiTrainingReference(pool, orgId, { scope: 'source', id: other.id, enabled: false })
    assert.ok((await readWebSourcePage(pool, orgId, pageId, true)).content)
    await assert.rejects(readWebSourcePage(pool, orgId, otherPage, true), 'a disabled website stays hidden independently of its sibling')
    await pool.query('INSERT INTO organization(id) VALUES($1)', [orgId + '-foreign'])
    await assert.rejects(updateAiTrainingReference(pool, orgId + '-foreign', { scope: 'source', id, enabled: true }), /Website not found/)
    const data = await listAiTrainingWebsites(pool, orgId)
    assert.equal('training' in data, false)
    assert.equal(data.data.find(s => s.id === other.id)?.aiEnabled, false)
    assert.equal(JSON.parse((await pool.query('SELECT metadata FROM organization WHERE id=$1', [orgId])).rows[0].metadata).untouched, 'keep')
  } finally { await db.close() }
})

test('Collection gates preserve article publication and individual AI settings', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  const vectorsBefore = process.env.HELP_VECTOR_SEARCH
  process.env.HELP_VECTOR_SEARCH = 'false'
  try {
    await db.exec(`CREATE TABLE help_article(id uuid PRIMARY KEY,org_id text,collection_id uuid,title text,content text,description text,short_id text,slug text,position int DEFAULT 0,status text,ai_enabled boolean,tsv tsvector,published_at timestamptz,updated_at timestamptz DEFAULT now())`)
    const collectionId = randomUUID(), otherCollectionId = randomUUID(), articleId = randomUUID(), otherArticleId = randomUUID()
    await pool.query('INSERT INTO help_collection(id,org_id,name,position) VALUES($1,$3,\'Getting started\',0),($2,$3,\'Billing\',1)', [collectionId, otherCollectionId, orgId])
    for (const [id, collection] of [[articleId, collectionId], [otherArticleId, otherCollectionId]]) await pool.query(`INSERT INTO help_article(id,org_id,collection_id,title,content,short_id,slug,status,ai_enabled,tsv) VALUES($1,$2,$3,'Widget installation','Install the widget and configure feedback.',$4,'widget','published',true,to_tsvector('english','widget installation'))`, [id, orgId, collection, id.slice(0, 6)])
    const search = () => searchHelpArticles(pool, orgId, { queries: ['widget'] }, 'https://example.com')
    assert.equal((await search()).articles.length, 2)
    await updateAiTrainingReference(pool, orgId, { scope: 'collection', id: collectionId, enabled: false })
    assert.deepEqual((await search()).articles.map(a => a.article_id), [otherArticleId])
    await pool.query('UPDATE organization SET metadata=$2 WHERE id=$1', [orgId, JSON.stringify({ aiTraining: { help: false } })])
    assert.deepEqual((await search()).articles.map(a => a.article_id), [otherArticleId])
    const article = (await pool.query('SELECT status,ai_enabled FROM help_article WHERE id=$1', [articleId])).rows[0]
    assert.equal(article.status, 'published'); assert.equal(article.ai_enabled, true)
    assert.equal((await pool.query('SELECT visible FROM help_collection WHERE id=$1', [collectionId])).rows[0].visible, true, 'AI gates do not unpublish the Help Center')
    assert.equal((await pool.query('SELECT ai_enabled FROM help_collection WHERE id=$1', [collectionId])).rows[0].ai_enabled, false)
  } finally {
    if (vectorsBefore === undefined) Reflect.deleteProperty(process.env, 'HELP_VECTOR_SEARCH'); else process.env.HELP_VECTOR_SEARCH = vectorsBefore
    await db.close()
  }
})

test('website overview distinguishes partial runs from full success and paginates independently of Help Center', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  const { listAiTrainingWebsitePages } = await import('../server/services/ai-training')
  const { startWebSourceRun, webSourceTransaction } = await import('../server/lib/web-source/jobs')
  try {
    const pages = Array.from({ length: 12 }, (_, i) => ({ title: `Page ${i}`, url: `https://example.com/page-${String(i).padStart(2, '0')}` }))
    const { id } = await createWebSource(pool, orgId, webSourceInput.parse({ url: 'https://example.com', pages }))
    const initial = (await listAiTrainingWebsites(pool, orgId)).data[0]!
    assert.equal(initial.activeRun.scope, 'full')
    assert.equal(initial.activeRun.total, 12)
    assert.equal(initial.pages.pending, 12)
    assert.equal(initial.activeRun.processed, 0)
    assert.equal('frequency' in initial, true)
    assert.equal('kind' in initial, false, 'website API does not pretend Help Center is a website')
    const first = await listAiTrainingWebsitePages(pool, orgId, id, { page: 1, pageSize: 10 })
    const next = await listAiTrainingWebsitePages(pool, orgId, id, { page: 2, pageSize: 10 })
    assert.equal(first.data.length, 10); assert.equal(next.data.length, 2); assert.equal(next.pagination.total, 12)
    assert.equal('content' in first.data[0]!, false)
    await pool.query("UPDATE ai_training_web_page SET sync_status='ready',indexed_at=now(),last_synced_at=now() WHERE website_id=$1", [id])
    await pool.query("UPDATE ai_training_website_run SET status='failed',failed=1,finished_at=now() WHERE website_id=$1", [id])
    await pool.query("UPDATE ai_training_web_page SET sync_status='failed',metadata=metadata||'{\"error\":\"http_500\"}'::jsonb WHERE id=$1", [next.data[1]!.id])
    const partial = await webSourceTransaction(pool, client => startWebSourceRun(client, orgId, id, 'manual', [first.data[0]!.id]))
    await pool.query("UPDATE ai_training_web_page SET sync_status='ready' WHERE run_id=$1", [partial])
    await pool.query("UPDATE ai_training_website_run SET status='done',finished_at=now() WHERE id=$1", [partial])
    const after = (await listAiTrainingWebsites(pool, orgId)).data[0]!
    assert.equal(after.lastRun.scope, 'selected'); assert.equal(after.lastRun.total, 1)
    assert.equal(after.lastFullRun.status, 'failed'); assert.equal(after.lastFullSuccess, null)
    assert.equal(after.status, 'attention'); assert.equal(after.pages.failed, 1)
    assert.equal(after.pages.indexed, 12, 'failure does not discard an existing usable version')
    const failed = await listAiTrainingWebsitePages(pool, orgId, id, { status: 'failed', page: 1, pageSize: 10 })
    assert.equal(failed.pagination.total, 1); assert.ok(failed.data[0]!.indexedAt)
    assert.equal((await listAiTrainingWebsitePages(pool, orgId, id, { q: 'page-11', page: 1, pageSize: 10 })).pagination.total, 1)
    await assert.rejects(listAiTrainingWebsitePages(pool, orgId + '-foreign', id, { page: 1, pageSize: 10 }), /Website not found/)
    const { retryFailedWebsitePages } = await import('../server/services/web-source')
    const retry = await retryFailedWebsitePages(pool, orgId, id)
    assert.equal(retry.affected, 1, 'retry includes a failed page beyond the first list page')
    assert.equal((await listAiTrainingWebsites(pool, orgId)).data[0]!.activeRun.scope, 'selected')
  } finally { await db.close() }
})

test('one source overview keeps Help availability and website configuration in distinct shapes', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  const { listAiTrainingSources } = await import('../server/services/ai-training')
  try {
    await db.exec('CREATE TABLE help_article(id uuid PRIMARY KEY,org_id text,collection_id uuid,ai_enabled boolean DEFAULT true)')
    assert.deepEqual(await listAiTrainingSources(pool, orgId), { sources: { help: { available: false, collectionCount: 0, articleCount: 0, aiUsableCount: 0 }, websites: [] } })
    const collection = randomUUID()
    await pool.query("INSERT INTO help_collection(id,org_id,name,ai_enabled) VALUES($1,$2,'Guide',false)", [collection, orgId])
    await pool.query('INSERT INTO help_article(id,org_id,collection_id) VALUES($1,$2,$3)', [randomUUID(), orgId, collection])
    assert.equal((await listAiTrainingSources(pool, orgId)).sources.help.available, true, 'closed AI reference does not hide manageable Help content')
    assert.equal((await listAiTrainingSources(pool, orgId + '-foreign')).sources.help.available, false)
    const { id } = await createWebSource(pool, orgId, webSourceInput.parse({ url: 'https://example.com', pages: [{ title: 'Guide', url: 'https://example.com/guide' }] }))
    const overview = await listAiTrainingSources(pool, orgId)
    assert.equal(overview.sources.websites[0]!.id, id)
    assert.deepEqual(overview.sources.help, { available: true, collectionCount: 1, articleCount: 1, aiUsableCount: 0 })
    assert.equal('url' in overview.sources.help, false)
    await pool.query('UPDATE help_collection SET ai_enabled=true WHERE id=$1', [collection])
    assert.equal((await listAiTrainingSources(pool, orgId)).sources.help.aiUsableCount, 1)
  } finally { await db.close() }
})

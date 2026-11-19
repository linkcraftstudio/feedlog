import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createWebSourceTestDatabase } from './fixtures/web-source-database'
import { searchKnowledgeBase } from '../server/lib/agent/knowledge-search'
import { HELP_EMBEDDING_MODEL, HELP_INDEX_VERSION } from '../server/lib/help-search/embedding'
import { WEB_SOURCE_INDEX_VERSION } from '../server/lib/web-source/prepare'

test('one knowledge search ranks both providers, gives help tie precedence and shares the query embedding', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  const previous = process.env.HELP_VECTOR_SEARCH
  process.env.HELP_VECTOR_SEARCH = 'true'
  const vector = [1, ...Array(767).fill(0)]
  let requests = 0
  const embed = async (texts: string[]) => { requests++; return texts.map(() => vector) }
  try {
    await db.exec('CREATE TABLE help_article(id uuid PRIMARY KEY,org_id text,collection_id uuid,title text,description text,content text,short_id text,slug text,status text,ai_enabled boolean,tsv tsvector)')
    const collection = randomUUID(), help = randomUUID(), website = randomUUID(), page = randomUUID(), task = randomUUID()
    await pool.query("INSERT INTO help_collection(id,org_id,name) VALUES($1,$2,'Guide')", [collection, orgId])
    await pool.query("INSERT INTO help_article VALUES($1,$2,$3,'Widget limits','Widget limits','The widget supports five projects.','help123','limits','published',true,to_tsvector('english','widget limits projects'))", [help, orgId, collection])
    await pool.query("INSERT INTO scheduled_task(id,kind,ref_id,status,result,schedule_at) VALUES($1,'help_index',$2,'done','indexed',now())", [task, help])
    await pool.query("INSERT INTO ai_training_website(id,org_id,url) VALUES($1,$2,'https://example.com')", [website, orgId])
    await pool.query("INSERT INTO ai_training_web_page(id,org_id,website_id,url,metadata,sync_status,indexed_at) VALUES($1,$2,$3,'https://example.com/widget', $4::jsonb,'ready',now())", [page, orgId, website, JSON.stringify({ title: 'Widget limits', content: 'The widget supports ten projects.' })])
    for (const [type, id, version] of [['help_article', help, HELP_INDEX_VERSION], ['web_page', page, WEB_SOURCE_INDEX_VERSION]]) {
      await pool.query('INSERT INTO content_chunk(content_type,content_id,ordinal,org_id,generation_id,heading,body,model,index_version,embedding) VALUES($1,$2,0,$3,$4,\'Widget limits\',\'The widget supports projects.\',$5,$6,$7::vector)', [type, id, orgId, task, HELP_EMBEDDING_MODEL, version, JSON.stringify(vector)])
    }
    const result = await searchKnowledgeBase(pool, orgId, { queries: ['widget'] }, 'https://app.example.com', embed)
    assert.deepEqual(result.results.map(row => row.sourceType), ['help_article', 'web_page'])
    assert.equal(result.results[0]!.id, help)
    assert.equal(requests, 1, 'provider searches share the identical query embedding')
    assert.match(result.conflictPolicy, /Help Center takes precedence/)
    await pool.query('UPDATE ai_training_website SET ai_enabled=false WHERE id=$1', [website])
    assert.deepEqual((await searchKnowledgeBase(pool, orgId, { queries: ['widget'] }, 'https://app.example.com', embed)).results.map(row => row.id), [help])
    assert.deepEqual((await searchKnowledgeBase(pool, orgId + '-foreign', { queries: ['widget'] }, 'https://app.example.com', embed)).results, [])
    await pool.query('UPDATE ai_training_website SET ai_enabled=true WHERE id=$1', [website])
    await pool.query("DELETE FROM content_chunk WHERE content_type='help_article' AND content_id=$1", [help])
    await pool.query('DELETE FROM help_article WHERE id=$1', [help])
    const beforeWebsiteOnly = requests
    const websiteOnly = await searchKnowledgeBase(pool, orgId, { queries: ['widget'] }, 'https://app.example.com', embed)
    assert.deepEqual(websiteOnly.results.map(row => ({ id: row.id, sourceType: row.sourceType })), [{ id: page, sourceType: 'web_page' }])
    assert.equal(requests - beforeWebsiteOnly, 1, 'website-only knowledge still works with a single query embedding')
  } finally {
    if (previous === undefined) delete process.env.HELP_VECTOR_SEARCH; else process.env.HELP_VECTOR_SEARCH = previous
    await db.close()
  }
})

test('website retrieval deduplicates before limiting, keeps unique evidence and falls back when the home page is removed', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  const { searchWebPages } = await import('../server/lib/web-source/search')
  const website = randomUUID(), home = randomUUID(), detail = randomUUID()
  const vector = JSON.stringify([1, ...Array(767).fill(0)])
  const body = 'Widget billing can be managed from the workspace settings.'
  async function add(id: string, url: string, content: string, heading = 'Billing', language: string | undefined = 'en') {
    await pool.query(`INSERT INTO ai_training_web_page(id,org_id,website_id,url,metadata,sync_status,indexed_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'ready',now())`, [id, orgId, website, url, JSON.stringify({ title: 'Widget billing', language, content })])
    await pool.query(`INSERT INTO content_chunk(content_type,content_id,ordinal,org_id,generation_id,heading,body,model,index_version,embedding)
      VALUES('web_page',$1,0,$2,$3,$4,$5,$6,$7,$8::vector)`, [id, orgId, randomUUID(), heading, content, HELP_EMBEDDING_MODEL, WEB_SOURCE_INDEX_VERSION, vector])
  }
  const embed = async () => [JSON.parse(vector)]
  try {
    await pool.query("INSERT INTO ai_training_website(id,org_id,url) VALUES($1,$2,'https://example.com')", [website, orgId])
    await add(home, 'https://example.com', body)
    for (let i = 0; i < 30; i++) await add(randomUUID(), `https://example.com/copy-${i}`, body)
    await add(detail, 'https://example.com/refund', 'Widget billing refunds are available within seven days.')
    const result = await searchWebPages(pool, orgId, 'widget billing', embed)
    assert.deepEqual(new Set(result.map(row => row.id)), new Set([home, detail]))
    assert.equal((await pool.query("SELECT count(*)::int AS total FROM content_chunk WHERE org_id=$1", [orgId])).rows[0].total, 32, 'retrieval dedup does not delete stored evidence or vectors')
    for (let i = 1; i <= 30; i++) await pool.query(`INSERT INTO content_chunk(content_type,content_id,ordinal,org_id,generation_id,heading,body,model,index_version,embedding)
      VALUES('web_page',$1,$2,$3,$4,'Billing',$5,$6,$7,$8::vector)`, [home, i, orgId, randomUUID(), `Widget billing reference ${i}.`, HELP_EMBEDDING_MODEL, WEB_SOURCE_INDEX_VERSION, vector])
    assert.ok((await searchWebPages(pool, orgId, 'widget billing', embed)).some(row => row.id === detail), 'many unique blocks from one page cannot crowd out another page')
    await pool.query('DELETE FROM ai_training_web_page WHERE id=$1', [home])
    const fallback = await searchWebPages(pool, orgId, 'widget billing', embed)
    assert.equal(fallback.length, 2)
    assert.ok(fallback.some(row => row.id === detail))
    assert.ok(fallback.every(row => row.id !== home))
  } finally { await db.close() }
})

test('dedup keeps languages, headings, websites, code and link targets distinct, including unknown language', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  const { searchWebPages } = await import('../server/lib/web-source/search')
  const first = randomUUID(), second = randomUUID()
  const body = 'Widget costs $9. See [terms](https://example.com/terms).'
  const vector = JSON.stringify([1, ...Array(767).fill(0)])
  const fixtures: [string, string | undefined, string, string][] = [
    [first, 'en', 'Basic', body], [first, 'fr', 'Basic', body], [first, 'en', 'Pro', body], [second, 'en', 'Basic', body],
    [first, undefined, 'Basic', body], [first, undefined, 'Basic', body],
    [first, 'en', 'Basic', body.replace('/terms', '/other-terms')],
    [first, 'en', 'Basic', 'Widget command: `USER=Admin`'], [first, 'en', 'Basic', 'Widget command: `USER=admin`'],
  ]
  try {
    for (const id of [first, second]) await pool.query("INSERT INTO ai_training_website(id,org_id,url) VALUES($1,$2,$3)", [id, orgId, `https://${id}.example.com`])
    const pages: string[] = []
    for (const [i, [website, language, heading, content]] of fixtures.entries()) {
      const id = randomUUID(); pages.push(id)
      await pool.query(`INSERT INTO ai_training_web_page(id,org_id,website_id,url,metadata,indexed_at) VALUES($1,$2,$3,$4,$5::jsonb,now())`, [id, orgId, website, `https://example.com/${i}`, JSON.stringify({ title: 'Widget', content, language })])
      await pool.query(`INSERT INTO content_chunk(content_type,content_id,ordinal,org_id,generation_id,heading,body,model,index_version,embedding)
        VALUES('web_page',$1,0,$2,$3,$4,$5,$6,$7,$8::vector)`, [id, orgId, randomUUID(), heading, content, HELP_EMBEDDING_MODEL, WEB_SOURCE_INDEX_VERSION, vector])
    }
    // Isolate each pair so the public five-page result limit cannot hide a merge.
    for (let i = 1; i < fixtures.length; i++) {
      await pool.query('UPDATE ai_training_web_page SET indexed_at=CASE WHEN id=ANY($1::uuid[]) THEN now() ELSE NULL END', [[pages[0], pages[i]]])
      assert.equal((await searchWebPages(pool, orgId, 'widget', async () => [JSON.parse(vector)])).length, 2, `fixture ${i} remains distinct`)
    }
    await pool.query('UPDATE ai_training_web_page SET indexed_at=CASE WHEN id=ANY($1::uuid[]) THEN now() ELSE NULL END', [[pages[4], pages[5]]])
    assert.equal((await searchWebPages(pool, orgId, 'widget', async () => [JSON.parse(vector)])).length, 2, 'two unknown-language pages are independent')
    await pool.query('UPDATE ai_training_web_page SET indexed_at=CASE WHEN id=ANY($1::uuid[]) THEN now() ELSE NULL END', [[pages[7], pages[8]]])
    assert.equal((await searchWebPages(pool, orgId, 'widget', async () => [JSON.parse(vector)])).length, 2, 'code case remains significant')
  } finally { await db.close() }
})

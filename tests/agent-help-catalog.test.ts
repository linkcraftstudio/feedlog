import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { listHelpCatalog } from '../server/lib/agent/help-catalog'
import { renderAgentSystemPrompt } from '../server/lib/agent/prompts/system'

test('catalog remains complete within its budget and overflow has an explicit cursor without tenant or AI gate leaks', async () => {
  const db = new PGlite()
  const pool = { query: async (sql: string, args?: unknown[]) => db.query(sql, args) } as unknown as Pool
  try {
    await db.exec(`CREATE TABLE help_collection(id text,org_id text,name text,position int,ai_enabled bool);
      CREATE TABLE help_article(id text,org_id text,collection_id text,title text,description text,position int,ai_enabled bool);
      INSERT INTO help_collection VALUES('c','org','Billing',0,true),('foreign','other','Other',0,true);
      INSERT INTO help_article VALUES('hidden','org','c','Hidden','Not AI enabled',0,false),('foreign','other','foreign','Private tenant article','Never cross tenants',0,true);`)
    for (let i = 0; i < 75; i++) await pool.query("INSERT INTO help_article VALUES($1,'org','c',$2,$3,$4,true)", ['article-' + i, 'Credit packs ' + i, 'Description '.repeat(20), i])
    const small = await listHelpCatalog(pool, 'org', { budget: 16000 })
    assert.equal(small.total, 75)
    assert.equal(small.complete, false)
    assert.ok(small.articles.length > 0 && small.articles.length < 75)
    assert.equal(small.nextOffset, small.articles.length)
    const pages = [...small.articles]
    let offset = small.nextOffset
    while (offset !== null) {
      const next = await listHelpCatalog(pool, 'org', { offset, limit: 15 })
      pages.push(...next.articles); offset = next.nextOffset
    }
    assert.equal(new Set(pages.map(article => article.id)).size, 75)
    assert.ok(pages.every(article => article.collectionName === 'Billing'))
    assert.equal((await listHelpCatalog(pool, 'org')).complete, true, 'the full small catalog does not depend on an arbitrary 50 article cutoff')
    assert.deepEqual((await listHelpCatalog(pool, 'other')).articles.map(article => article.id), ['foreign'])
    await pool.query("UPDATE help_collection SET ai_enabled=false WHERE id='c'")
    assert.deepEqual(await listHelpCatalog(pool, 'org'), { articles: [], total: 0, complete: true, nextOffset: null })
  } finally { await db.close() }
})

test('prompt preserves complementary knowledge, scoped Help authority, unknown freshness and full-context clarification', () => {
  const prompt = renderAgentSystemPrompt({ productName: 'Example Product', boards: [], supportRules: [], knowledgeEnabled: true,
    articles: [{ id: 'id', title: 'Manage credit packs', description: 'Navigation only', collectionName: 'Billing' }], articleCatalog: { total: 300, complete: false, nextOffset: 1 },
    feedback: { create: false, vote: false, subscribe: false, commentScope: 'own' } })
  assert.match(prompt, /Article Catalog/)
  assert.match(prompt, /"complete":false/)
  assert.match(prompt, /list_help_articles/)
  assert.match(prompt, /Combine complementary facts/)
  assert.match(prompt, /Only when the same fact contradicts for the same product and scope, prefer Help Center/)
  assert.match(prompt, /Crawl, sync and index timestamps do not establish content freshness/)
  assert.match(prompt, /contradictory public page/)
  assert.match(prompt, /conversation, supplied page context and image observations/)
  assert.match(prompt, /later citation check cannot correct product facts/)
  assert.doesNotMatch(prompt, /For file-upload, OCR or format-support questions/)
})

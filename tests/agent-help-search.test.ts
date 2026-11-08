import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Pool } from 'pg'
import { uuidv7 } from 'uuidv7'
import { searchHelpArticles, type HelpArticleSearchInput } from '../server/lib/agent/help-search'

const origin = 'http://example.localhost:3000'

test('article search validates its bounded query list before querying the database', async () => {
  let calls = 0
  const pool = { query: async () => { calls++; return { rows: [] } } } as unknown as Pool
  for (const input of [
    { query: 'legacy input' },
    { queries: [] },
    { queries: ['   '] },
    { queries: ['a', 'b', 'c', 'd', 'e'] },
    { queries: ['x'.repeat(101)] },
  ]) {
    await assert.rejects(searchHelpArticles(pool, 'test', input as unknown as HelpArticleSearchInput, origin))
  }
  assert.equal(calls, 0)
})

test('article search preserves query order despite completion order and merges shared hits', async () => {
  const calls: string[] = []
  const article = (id: string) => ({
    article_id: id, title: id, description: null, slug: id, published: true,
    content: '# Reference\n\nThe **alpha topic** and beta term explain the behavior.',
  })
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      if (_sql.startsWith('SELECT metadata')) return { rows: [{ metadata: JSON.stringify({ portalModules: { helpCenter: true } }) }] }
      const query = params[1] as string
      calls.push(query)
      if (query === 'Alpha topic') {
        await new Promise(resolve => setTimeout(resolve, 20))
        return { rows: ['a', 'shared', 'c'].map(article) }
      }
      return { rows: ['b', 'shared', 'd'].map(article) }
    },
  } as unknown as Pool
  const result = await searchHelpArticles(pool, 'test', {
    queries: ['  Alpha   topic ', 'Beta term', 'alpha topic'],
  }, origin)
  assert.deepEqual(calls, ['Alpha topic', 'Beta term'])
  assert.deepEqual(result.articles.map(a => a.article_id), ['a', 'b', 'shared', 'c', 'd'])
  assert.deepEqual(result.articles.find(a => a.article_id === 'shared')?.matched_queries, ['Alpha topic', 'Beta term'])
  for (const article of result.articles) {
    assert.equal('content' in article, false)
    assert.ok(article.excerpt.includes('alpha topic'))
    assert.equal(article.excerpt.includes('**'), false)
  }
})

test('article search applies tenant and AI visibility filters before each top-three limit', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  const client = await pool.connect()
  await client.query('BEGIN')
  try {
    const orgId = 'help-search-' + uuidv7()
    const otherOrgId = 'help-search-' + uuidv7()
    const visibleCollection = uuidv7()
    const hiddenCollection = uuidv7()
    const otherCollection = uuidv7()
    for (const id of [orgId, otherOrgId]) {
      await client.query('INSERT INTO organization (id,name,slug) VALUES ($1,$1,$1)', [id])
    }
    for (const [id, org, visible] of [
      [visibleCollection, orgId, true],
      [hiddenCollection, orgId, false],
      [otherCollection, otherOrgId, true],
    ]) {
      await client.query('INSERT INTO help_collection (id,org_id,name,icon,visible,position) VALUES ($1,$2,$3,$4,$5,0)', [id, org, 'Search fixtures', 'book-open', visible])
    }
    let shortId = 0
    async function insert(org: string, collection: string, title: string, status = 'published', aiEnabled = true) {
      const id = uuidv7()
      await client.query(
        "INSERT INTO help_article (id,org_id,collection_id,short_id,slug,status,title,content,tsv,position,ai_enabled) VALUES ($1,$2,$3,$4,$7,$5,$6::text,$6::text,setweight(to_tsvector('english',$6::text),'A'),0,$8)",
        [id, org, collection, String(++shortId).padStart(6, '0'), status, title, id, aiEnabled],
      )
      return id
    }
    const queries = ['quartz', 'nebula', 'willow', 'tundra']
    const expected: string[][] = []
    for (const term of queries) {
      const ids = []
      for (let i = 0; i < 4; i++) ids.push(await insert(orgId, visibleCollection, term))
      expected.push(ids.sort().slice(0, 3))
    }
    const highRank = 'quartz '.repeat(25)
    await insert(orgId, hiddenCollection, highRank, 'published', false)
    await insert(orgId, visibleCollection, highRank, 'draft', false)
    await insert(otherOrgId, otherCollection, highRank)
    await insert(orgId, otherCollection, highRank)
    const result = await searchHelpArticles(client, orgId, { queries }, origin)
    const ordered = [0, 1, 2].flatMap(rank => expected.map(group => group[rank]))
    assert.deepEqual(result.articles.map(a => a.article_id), ordered)
    assert.equal(result.articles.length, 12)
    assert.deepEqual(await searchHelpArticles(client, orgId, { queries: ['missingterm', 'the and of', "' | ! :*"] }, origin), { articles: [] })
  } finally {
    await client.query('ROLLBACK')
    client.release()
    await pool.end()
  }
})

test('Chinese fallback retains AI scope and public visibility without rewriting English', async () => {
  const keys = ['HELP_SEARCH_BILINGUAL', 'OPENAI_API_KEY', 'OPENAI_TEXT_MODEL', 'OPENAI_BASE_URL'] as const
  const before = { ...process.env }
  const fetchBefore = globalThis.fetch
  let requests = 0
  Object.assign(process.env, { HELP_SEARCH_BILINGUAL: 'true', OPENAI_API_KEY: 'test', OPENAI_TEXT_MODEL: 'test', OPENAI_BASE_URL: 'https://example.invalid/v1' })
  globalThis.fetch = async () => {
    requests++
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"queries":["cancel subscription","stop renewal"]}' } }] }), { headers: { 'content-type': 'application/json' } })
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  const client = await pool.connect()
  await client.query('BEGIN')
  try {
    const org = 'bilingual-' + uuidv7()
    const other = 'bilingual-' + uuidv7()
    const visible = uuidv7(), hidden = uuidv7(), foreign = uuidv7()
    for (const id of [org, other]) await client.query('INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)', [id])
    await client.query('UPDATE organization SET metadata=$2 WHERE id=$1', [org, JSON.stringify({ portalModules: { helpCenter: true } })])
    for (const [id, tenant, shown] of [[visible, org, true], [hidden, org, false], [foreign, other, true]]) {
      await client.query("INSERT INTO help_collection(id,org_id,name,icon,visible,position) VALUES($1,$2,'Test','book-open',$3,0)", [id, tenant, shown])
    }
    const expected: string[] = []
    let publicId = ''
    for (const [tenant, collection, status, ai, eligible] of [
      [org, visible, 'published', true, true], [org, visible, 'draft', true, true],
      [org, hidden, 'published', true, true], [org, visible, 'published', false, false],
      [other, foreign, 'published', true, false], [org, foreign, 'published', true, false],
    ] as const) {
      const id = uuidv7()
      await client.query("INSERT INTO help_article(id,org_id,collection_id,short_id,slug,status,title,content,tsv,position,ai_enabled) VALUES($1,$2,$3,$4,$7,$5,'Cancel subscription','Cancel subscription stops renewal',to_tsvector('english','Cancel subscription stops renewal'),0,$6)", [id, tenant, collection, id.slice(-6), status, ai, id])
      if (eligible) expected.push(id)
      if (tenant === org && collection === visible && status === 'published' && ai) publicId = id
    }
    const chinese = await searchHelpArticles(client, org, { queries: ['关闭自动续费'] }, origin)
    assert.deepEqual(chinese.articles.map(a => a.article_id).sort(), expected.sort())
    assert.equal(requests, 1)
    for (const article of chinese.articles) {
      assert.equal(article.customer_visible, article.article_id === publicId)
      assert.equal(article.url !== null, article.article_id === publicId)
      assert.deepEqual(article.matched_queries, ['关闭自动续费'])
    }
    const english = await searchHelpArticles(client, org, { queries: ['disable auto renewal'] }, origin)
    assert.deepEqual(english.articles, [])
    assert.equal(requests, 1)
    const partial = await searchHelpArticles(client, org, { queries: ['cancel subscription missingterm'] }, origin)
    assert.deepEqual(partial.articles.map(a => a.article_id).sort(), expected.sort())
    assert.equal(requests, 1, 'partial English candidates must not call another model')
    assert.ok(partial.articles.every(a => a.customer_visible === (a.article_id === publicId)))
    assert.deepEqual((await searchHelpArticles(client, org, { queries: ['cancel missingterm'] }, origin)).articles, [], 'two-term questions must not degrade to one broad match')
    await searchHelpArticles(client, org, { queries: ['cancel subscription'] }, origin)
    assert.equal(requests, 1, 'successful English query must bypass model')
    await client.query('UPDATE organization SET metadata=$2 WHERE id=$1', [org, JSON.stringify({ portalModules: { helpCenter: false } })])
    const privateResult = await searchHelpArticles(client, org, { queries: ['关闭自动续费'] }, origin)
    assert.equal(requests, 1, 'cached translation must recheck visibility')
    assert.equal(privateResult.articles.length, 3)
    assert.ok(privateResult.articles.every(a => !a.customer_visible && a.url === null))
  } finally {
    await client.query('ROLLBACK')
    client.release()
    await pool.end()
    globalThis.fetch = fetchBefore
    for (const key of keys) {
      if (before[key] === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = before[key]
    }
  }
})

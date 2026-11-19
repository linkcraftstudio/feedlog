import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'
import { PgDialect } from 'drizzle-orm/pg-core'
import { createWebSourceTestDatabase } from './fixtures/web-source-database'
import { createWebSource, removeWebSourcePage } from '../server/services/web-source'
import { webSourceInput } from '../shared/schemas/web-source'
import { runNextWebSourceTask } from '../server/lib/web-source/worker'
import { searchWebPages } from '../server/lib/web-source/search'
import { loadCitationCandidates } from '../server/lib/agent/citation-evidence'
import { queueHelpIndex, deleteHelpIndex } from '../server/lib/help-search/jobs'
import { indexNextHelpArticle } from '../server/lib/help-search/indexer'
import { searchHelpVectors } from '../server/lib/help-search/vector-search'
import { HELP_EMBEDDING_MODEL, HELP_INDEX_VERSION } from '../server/lib/help-search/embedding'

const embedding = [1, ...Array(767).fill(0)]
const embed = async (inputs: string[]) => inputs.map(() => embedding)

test('evolution migration preserves existing help chunks, vectors and generations', async () => {
  const db = new PGlite({ extensions: { vector } })
  try {
    await db.exec('CREATE EXTENSION vector; CREATE TABLE help_collection(id uuid PRIMARY KEY)')
    await db.exec(await readFile(new URL('../server/db/migrations/0020_help_vector_index.sql', import.meta.url), 'utf8'))
    const id = randomUUID(), generation = randomUUID()
    await db.query(`INSERT INTO help_article_chunk(article_id,ordinal,org_id,generation_id,heading,body,model,index_version,embedding)
      VALUES($1,0,'existing-org',$2,'Setup','Existing answer',$3,$4,$5::vector)`, [id, generation, HELP_EMBEDDING_MODEL, HELP_INDEX_VERSION, JSON.stringify(embedding)])
    const previous = (await db.query('SELECT embedding::text AS embedding FROM help_article_chunk')).rows[0]
    await db.exec(await readFile(new URL('../server/db/migrations/0021_ai_training.sql', import.meta.url), 'utf8'))
    const { rows: [chunk] } = await db.query('SELECT *,embedding::text AS vector_text FROM content_chunk')
    assert.equal(chunk.content_id, id)
    assert.equal(chunk.content_type, 'help_article')
    assert.equal(chunk.body, 'Existing answer')
    assert.equal(chunk.generation_id, generation)
    assert.equal(chunk.vector_text, previous!.embedding)
    assert.equal((await db.query("SELECT to_regclass('help_article_chunk') AS old_table")).rows[0]!.old_table, null)
  } finally { await db.close() }
})

test('same content ID in help and website remains isolated through indexing, retrieval and deletion', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  const previous = process.env.HELP_VECTOR_SEARCH
  process.env.HELP_VECTOR_SEARCH = 'true'
  try {
    await db.exec(`CREATE TABLE help_article(id uuid PRIMARY KEY,org_id text,collection_id uuid,short_id text,slug text,title text,description text,content text,status text,ai_enabled boolean)`)
    const { id: sourceId } = await createWebSource(pool, orgId, webSourceInput.parse({ url: 'https://example.com', frequency: 'manual', pages: [{ title: '', url: 'https://example.com/guide' }] }))
    assert.equal((await runNextWebSourceTask(pool, {
      fetcher: async url => ({ url, status: 200, headers: { 'content-type': 'text/html' }, body: url.endsWith('/robots.txt') ? '' : '<main><h1>Website guide TitleOnlyBeacon</h1><p>Install the widget and configure notifications to collect customer feedback on the website.</p></main>' }),
      prepare: async page => ({ content: page.content, summary: 'Website widget guide SummaryOnlyBeacon', keywords: ['widget', 'KeywordOnlyBeacon'], evidence: ['Install the widget'] }), embed,
    })).ready, true)
    const id = (await pool.query('SELECT id FROM ai_training_web_page WHERE website_id=$1', [sourceId])).rows[0].id
    const lexicalOnly = async () => { throw new Error('No vector service') }
    for (const query of ['TitleOnlyBeacon', 'SummaryOnlyBeacon', 'KeywordOnlyBeacon', 'customer']) {
      assert.deepEqual((await searchWebPages(pool, orgId, query, lexicalOnly)).map(row => row.id), [id], 'JSON title, summary, keywords and body remain searchable without vectors')
    }
    const collection = randomUUID()
    await pool.query("INSERT INTO help_collection(id,org_id,name,position) VALUES($1,$2,'Setup',0)", [collection, orgId])
    await pool.query(`INSERT INTO help_article VALUES($1,$2,$3,'abc123','widget','Help guide','Help widget guide','Install the widget with the help-center settings.','published',true)`, [id, orgId, collection])
    const dialect = new PgDialect()
    const writer = { execute: async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
      const compiled = dialect.sqlToQuery(query)
      return (await pool.query(compiled.sql, compiled.params)).rows
    } } as Parameters<typeof queueHelpIndex>[0]
    const rebuildHelp = async () => {
      await queueHelpIndex(writer, id)
      assert.equal((await indexNextHelpArticle(pool, embed)).ready, true)
    }
    await rebuildHelp()
    const candidates = await loadCitationCandidates(pool, orgId, [id])
    assert.equal(candidates.length, 2)
    const webCandidate = candidates.find(candidate => candidate.title === 'Website guide TitleOnlyBeacon')!
    assert.ok(webCandidate.content.includes('Install the widget and configure notifications'))
    assert.ok(webCandidate.content.includes('\n\n[Original source](https://example.com/guide)'))
    assert.deepEqual(await loadCitationCandidates(pool, orgId + '-foreign', [id]), [])
    await pool.query("UPDATE help_article SET status='draft' WHERE id=$1", [id])
    assert.deepEqual((await loadCitationCandidates(pool, orgId, [id])).map(row => row.title), ['Website guide TitleOnlyBeacon'])
    await pool.query("UPDATE help_article SET status='published' WHERE id=$1", [id])
    await pool.query('UPDATE ai_training_website SET ai_enabled=false WHERE id=$1', [sourceId])
    assert.deepEqual((await loadCitationCandidates(pool, orgId, [id])).map(row => row.title), ['Help guide'])
    await pool.query('UPDATE ai_training_website SET ai_enabled=true WHERE id=$1', [sourceId])
    assert.equal((await pool.query('SELECT * FROM content_chunk WHERE content_id=$1', [id])).rows.length, 2)
    assert.deepEqual((await searchWebPages(pool, orgId, 'widget', embed)).map(row => row.title), ['Website guide TitleOnlyBeacon'])
    assert.deepEqual((await searchHelpVectors(pool, orgId, 'widget', 'agent', 12, embed)).map(row => row.title), ['Help guide'])
    await deleteHelpIndex(writer, id)
    assert.deepEqual((await pool.query('SELECT content_type FROM content_chunk WHERE content_id=$1', [id])).rows.map(row => row.content_type), ['web_page'])
    await rebuildHelp()
    await removeWebSourcePage(pool, orgId, id)
    assert.deepEqual((await pool.query('SELECT content_type FROM content_chunk WHERE content_id=$1', [id])).rows.map(row => row.content_type), ['help_article'])
    assert.equal((await searchHelpVectors(pool, orgId, 'widget', 'agent', 12, embed)).length, 1)
  } finally {
    if (previous === undefined) delete process.env.HELP_VECTOR_SEARCH
    else process.env.HELP_VECTOR_SEARCH = previous
    await db.close()
  }
})

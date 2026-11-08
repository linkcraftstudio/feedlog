import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { PgDialect } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { ensureHelpIndex, queueHelpIndex, pauseHelpIndex } from '../server/lib/help-search/jobs'
import { helpIndexStatus } from '../server/lib/help-search/management'
import { indexNextHelpArticle } from '../server/lib/help-search/indexer'
import { HELP_EMBEDDING_MODEL, HELP_INDEX_VERSION, HelpEmbeddingError } from '../server/lib/help-search/embedding'

// Fully isolated PostgreSQL engine: no .env, external service or real articles.
test('four states, unchanged saves and three reproducible indexing failures', async t => {
  const client = new PGlite()
  const dialect = new PgDialect()
  const db = { async execute(query: Parameters<PgDialect['sqlToQuery']>[0]) {
    const { sql: text, params } = dialect.sqlToQuery(query)
    return (await client.query(text, params)).rows
  } } as Parameters<typeof ensureHelpIndex>[0]
  const pool = { query: (text: string, params?: unknown[]) => client.query(text, params) } as unknown as Pool
  const oldFlag = process.env.HELP_VECTOR_SEARCH
  const oldKey = process.env.OPENAI_API_KEY
  process.env.HELP_VECTOR_SEARCH = 'true'
  process.env.OPENAI_API_KEY = 'local-test-placeholder'
  const status = async (id: string) => (await db.execute(sql`SELECT ${helpIndexStatus()} AS status FROM help_article WHERE id=${id}`))[0]?.status
  const task = async (id: string) => (await client.query<{ id: string; status: string; attempts: number; result: string | null; manual_retry: boolean }>('SELECT * FROM scheduled_task WHERE ref_id=$1', [id])).rows[0]!
  const article = async () => {
    const id = randomUUID()
    await client.query("INSERT INTO help_article(id,org_id,title,description,content,status) VALUES ($1,'fixture-org','Local indexing fixture',NULL,'A small local test article.','published')", [id])
    return id
  }
  try {
    await client.exec(`CREATE TABLE help_article(id uuid PRIMARY KEY,org_id text,title text,description text,content text,status text);
      CREATE TABLE scheduled_task(id uuid PRIMARY KEY,kind text,ref_id uuid,item_id text,schedule_at timestamptz,status text,attempts int,result text,manual_retry boolean DEFAULT false,updated_at timestamptz DEFAULT now());
      CREATE UNIQUE INDEX task_reference ON scheduled_task(kind,ref_id) WHERE item_id IS NULL;
      CREATE TABLE help_article_chunk(article_id uuid,generation_id uuid,model text,index_version text);`)
    await t.test('legacy article stays unindexed until an explicit save; repeated saves preserve the job', async () => {
      const id = await article()
      assert.equal(await status(id), 'not_indexed')
      assert.equal(await ensureHelpIndex(db, id), true)
      assert.equal(await status(id), 'indexing')
      const queued = await task(id)
      assert.equal(await ensureHelpIndex(db, id), false)
      assert.equal((await task(id)).id, queued.id)
      await client.query("UPDATE scheduled_task SET status='processing' WHERE ref_id=$1", [id])
      assert.equal(await status(id), 'indexing')
      assert.equal(await ensureHelpIndex(db, id), false)
      await client.query("UPDATE scheduled_task SET status='done',result='indexed' WHERE ref_id=$1", [id])
      assert.equal(await status(id), 'ready')
      assert.equal(await ensureHelpIndex(db, id), false)
      assert.equal((await task(id)).id, queued.id)
      await queueHelpIndex(db, id)
      assert.equal(await status(id), 'indexing')
      assert.notEqual((await task(id)).id, queued.id)
    })
    const cases = [
      { title: 'Provider rejects credentials (401)', code: 'provider_401', retryable: false, attempts: 0 },
      { title: 'Request times out until retries are exhausted', code: 'provider_unavailable', retryable: true, attempts: 4 },
      { title: 'Invalid embedding response exhausts retries', code: 'invalid_response', retryable: true, attempts: 4 },
    ]
    for (const example of cases) await t.test(example.title, async () => {
      const id = await article()
      await queueHelpIndex(db, id)
      assert.equal(await status(id), 'indexing', 'first save immediately queues indexing')
      await client.query('UPDATE scheduled_task SET attempts=$2 WHERE ref_id=$1', [id, example.attempts])
      await indexNextHelpArticle(pool, async () => { throw new HelpEmbeddingError(example.code, example.retryable) }, undefined, id)
      assert.equal(await status(id), 'failed')
      const failed = await task(id)
      assert.equal(failed.result, example.code)
      assert.equal(await ensureHelpIndex(db, id), true, 'unchanged save retries failure')
      const retried = await task(id)
      assert.notEqual(retried.id, failed.id)
      assert.equal(retried.attempts, 0)
      assert.equal(retried.result, null)
      assert.equal(retried.manual_retry, true)
      assert.equal(await status(id), 'indexing')
    })
    await t.test('transient failures remain indexing while automatic retry is pending', async () => {
      const id = await article()
      await queueHelpIndex(db, id)
      await indexNextHelpArticle(pool, async () => { throw new HelpEmbeddingError('provider_429', true) }, undefined, id)
      assert.equal((await task(id)).attempts, 1)
      assert.equal(await status(id), 'indexing')
      assert.equal(await ensureHelpIndex(db, id), false)
    })
    await t.test('draft and archived articles neither enqueue nor display a badge', async () => {
      const id = await article()
      for (const publication of ['draft', 'archived']) {
        await client.query('UPDATE help_article SET status=$2 WHERE id=$1', [id, publication])
        await queueHelpIndex(db, id)
        assert.equal(await ensureHelpIndex(db, id), false)
        assert.equal(await task(id), undefined)
        assert.equal(await status(id), null)
      }
    })
    await t.test('unpublish retains a completed snapshot; identical republish rebuilds it', async () => {
      const id = await article()
      await queueHelpIndex(db, id)
      const generation = (await task(id)).id
      await client.query("UPDATE scheduled_task SET status='done',result='indexed' WHERE ref_id=$1", [id])
      await client.query('INSERT INTO help_article_chunk VALUES($1,$2,$3,$4)', [id, generation, HELP_EMBEDDING_MODEL, HELP_INDEX_VERSION])
      await client.query("UPDATE help_article SET status='archived' WHERE id=$1", [id])
      await pauseHelpIndex(db, id)
      assert.equal(await status(id), null)
      assert.equal((await task(id)).id, generation)
      assert.equal((await client.query('SELECT * FROM help_article_chunk WHERE article_id=$1', [id])).rows.length, 1)
      await client.query("UPDATE help_article SET status='published' WHERE id=$1", [id])
      await queueHelpIndex(db, id)
      assert.equal(await status(id), 'indexing')
      assert.notEqual((await task(id)).id, generation)
      assert.equal((await client.query('SELECT * FROM help_article_chunk WHERE article_id=$1', [id])).rows.length, 0)
    })
    await t.test('unpublish revokes a running generation; republish starts a fresh one', async () => {
      const id = await article()
      await queueHelpIndex(db, id)
      const original = (await task(id)).id
      await client.query("UPDATE scheduled_task SET status='processing' WHERE ref_id=$1", [id])
      await client.query("UPDATE help_article SET status='archived' WHERE id=$1", [id])
      await pauseHelpIndex(db, id)
      assert.notEqual((await task(id)).id, original)
      assert.equal((await task(id)).result, 'paused')
      let embedded = false
      await indexNextHelpArticle(pool, async () => { embedded = true; return [] }, undefined, id)
      assert.equal(embedded, false)
      await client.query("UPDATE help_article SET status='published' WHERE id=$1", [id])
      await queueHelpIndex(db, id)
      assert.equal(await status(id), 'indexing')
    })
    await t.test('unconfigured AI hides all four badges', async () => {
      const ids = await Promise.all(Array.from({ length: 4 }, article))
      for (const id of ids.slice(1)) await queueHelpIndex(db, id)
      await client.query("UPDATE scheduled_task SET status='done',result='indexed' WHERE ref_id=$1", [ids[2]])
      await client.query("UPDATE scheduled_task SET status='done',result='provider_401' WHERE ref_id=$1", [ids[3]])
      for (const [flag, key] of [['false', 'placeholder'], ['true', ''], ['true', '  ']]) {
        process.env.HELP_VECTOR_SEARCH = flag
        process.env.OPENAI_API_KEY = key
        for (const id of ids) assert.equal(await status(id), null)
      }
    })
  }
  finally {
    await client.close()
    if (oldFlag === undefined) delete process.env.HELP_VECTOR_SEARCH
    else process.env.HELP_VECTOR_SEARCH = oldFlag
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = oldKey
  }
})

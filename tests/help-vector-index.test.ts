import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { randomUUID } from 'node:crypto'
import { chunkHelpArticle } from '../server/lib/help-search/chunks'
import { embedHelpTexts, HelpEmbeddingError } from '../server/lib/help-search/embedding'
import { indexNextHelpArticle } from '../server/lib/help-search/indexer'
import { searchHelpVectors, fuseHelpResults } from '../server/lib/help-search/vector-search'
import { queueHelpIndex, deleteHelpIndex, pauseHelpIndex } from '../server/lib/help-search/jobs'

const vector = () => [1, ...Array(767).fill(0)] as number[]
const embed = async (inputs: string[]) => inputs.map(vector)

test('heading chunks retain code, CJK tail and long section content without standalone heading chunks', () => {
  const content = '# Setup\n\n```sh\n# not a heading\ncurl /refund\n```\n\n## Limits\n' + '每日最多两次操作。'.repeat(700) + '\nTAIL_EVIDENCE'
  const chunks = chunkHelpArticle({ title: '产品', description: null, content })
  assert.ok(chunks.length > 2)
  assert.ok(chunks.some(c => c.body.includes('curl /refund')))
  assert.ok(chunks.at(-1)?.body.includes('TAIL_EVIDENCE'))
  assert.ok(chunks.every(c => !c.body.includes('\ufffd')))
  assert.ok(chunks.every(c => c.body.trim()))
  assert.throws(() => chunkHelpArticle({ title: 'a', description: null, content: 'a'.repeat(500001) }), /article_too_large/)
})

test('literal special-token text and multilingual prefixes do not break indexing', () => {
  const chunks = chunkHelpArticle({ title: 'Token <|endoftext|> guide', description: '中文说明'.repeat(100), content: 'Use the token name literally.' })
  assert.ok(chunks[0]?.input.includes('<|endoftext|>'))
  assert.ok(chunks.every(c => !c.input.includes('\ufffd')))
})

test('embedding boundary classifies rate limits, permanent errors and invalid vectors without leaking bodies', async () => {
  const original = globalThis.fetch, key = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'test-only'
  try {
    for (const [status, retry] of [[429, true], [503, true], [401, false], [400, false]] as const) {
      globalThis.fetch = async () => new Response('secret raw body', { status })
      await assert.rejects(embedHelpTexts(['test']), (e: unknown) => e instanceof HelpEmbeddingError && e.retryable === retry && !e.message.includes('secret'))
    }
    globalThis.fetch = async () => Response.json({ data: [{ index: 0, embedding: [1] }] })
    await assert.rejects(embedHelpTexts(['test']), /invalid_response/)
  } finally { globalThis.fetch = original; if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key }
})

test('rank fusion deduplicates while preserving exact lexical candidates', () => {
  const result = fuseHelpResults([{ id: 'exact' }, { id: 'shared' }], [{ id: 'shared' }, { id: 'semantic' }], r => r.id, 3)
  assert.deepEqual(result.map(r => r.id), ['shared', 'exact', 'semantic'])
})

test('Agent fusion keeps a body keyword winner ahead of articles boosted by ready vectors', () => {
  const lexical = [{ id: 'body-answer' }, { id: 'generic-export' }, { id: 'generic-history' }]
  const semantic = [{ id: 'generic-export' }, { id: 'generic-history' }, { id: 'other' }]
  const result = fuseHelpResults(lexical, semantic, row => row.id, 3, true)
  assert.deepEqual(result.map(row => row.id), ['body-answer', 'generic-export', 'generic-history'])
})

// Explicit opt-in dedicated DB: these tests intentionally exercise commits and races.
test('durable indexing lifecycle, concurrency and authorization filters', { skip: !process.env.HELP_INDEX_TEST_DATABASE_URL }, async t => {
  const url = new URL(process.env.HELP_INDEX_TEST_DATABASE_URL!)
  assert.ok(['localhost','127.0.0.1'].includes(url.hostname) && /^\/feedlog_help_vector_tasks_\d+$/.test(url.pathname))
  const pool = new Pool({ connectionString: url.toString(), max: 5 })
  const org = 'vector-test-' + randomUUID(), other = org + '-other', collection = randomUUID(), hidden = randomUUID()
  process.env.HELP_VECTOR_SEARCH = 'true'
  const write = async <T>(action: (client: Awaited<ReturnType<typeof pool.connect>>) => Promise<T>) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await action(client)
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  const create = async (options: { org?: string; collection?: string; ai?: boolean; status?: string } = {}) => {
    const id = randomUUID()
    await write(async client => {
      await client.query(`INSERT INTO help_article(id,org_id,collection_id,short_id,slug,title,content,tsv,position,status,ai_enabled)
        VALUES($1,$2,$3,$4,'test','Cancellation','Refunds take seven days',to_tsvector('english','Refunds take seven days'),0,$5,$6)`, [id, options.org ?? org, options.collection ?? collection, id.slice(0,6), options.status ?? 'published', options.ai ?? true])
      await queueHelpIndex(drizzle(client), id)
    })
    return id
  }
  const updateContent = async (id: string, content: string) => write(async client => {
    await client.query('UPDATE help_article SET content=$2 WHERE id=$1', [id, content])
    await queueHelpIndex(drizzle(client), id)
  })
  const deleteArticle = async (id: string) => write(async client => {
    await client.query('DELETE FROM help_article WHERE id=$1', [id])
    await deleteHelpIndex(drizzle(client), id)
  })
  const state = async (id: string) => (await pool.query(`SELECT *,CASE WHEN status='done' THEN CASE WHEN result='indexed' THEN 'ready' ELSE 'failed' END WHEN status='pending' AND attempts>0 THEN 'retry' ELSE status END AS status FROM scheduled_task WHERE kind='help_index' AND ref_id=$1`, [id])).rows[0]
  const remove = async () => {
    const ids = (await pool.query('SELECT id FROM help_article WHERE org_id IN ($1,$2)', [org,other])).rows.map(row => row.id as string)
    for (const id of ids) await deleteArticle(id)
  }
  try {
    await pool.query('INSERT INTO organization(id,name,slug) VALUES($1,$1,$1),($2,$2,$2)', [org,other])
    await pool.query("INSERT INTO help_collection(id,org_id,name,icon,visible,position) VALUES($1,$3,'Public','book-open',true,0),($2,$3,'Private','book-open',false,1)", [collection,hidden,org])
    await t.test('article rollback also rolls back enqueue', async () => {
      const client = await pool.connect(), id = randomUUID()
      try {
        await client.query('BEGIN')
        await client.query(`INSERT INTO help_article(id,org_id,collection_id,short_id,slug,title,content,tsv,position,status) VALUES($1,$2,$3,'rollbk','x','title','body',''::tsvector,0,'published')`, [id,org,collection])
        await queueHelpIndex(drizzle(client), id)
        assert.equal((await client.query("SELECT status FROM scheduled_task WHERE kind='help_index' AND ref_id=$1",[id])).rows[0].status,'pending')
        await client.query('ROLLBACK')
        assert.equal(await state(id),undefined)
      } finally { client.release() }
    })
    await t.test('new write queues, transient failure retries, ready index is atomic and content update invalidates it', async () => {
      const id = await create()
      assert.equal((await state(id)).status,'pending')
      await indexNextHelpArticle(pool, async () => { throw new HelpEmbeddingError('provider_429',true) })
      assert.equal((await state(id)).status,'retry')
      assert.equal((await state(id)).attempts,1)
      assert.equal((await indexNextHelpArticle(pool,embed)).processed,false)
      await pool.query("UPDATE scheduled_task SET schedule_at=now() WHERE kind='help_index' AND ref_id=$1",[id])
      await indexNextHelpArticle(pool,embed)
      assert.equal((await state(id)).status,'ready')
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM help_article_chunk WHERE article_id=$1',[id])).rows[0].n,1)
      await pool.query('UPDATE help_article SET position=5 WHERE id=$1',[id])
      assert.equal((await state(id)).status,'ready')
      const generation = (await state(id)).id
      await updateContent(id, 'Changed answer')
      assert.notEqual((await state(id)).id,generation)
      assert.equal((await state(id)).status,'pending')
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM help_article_chunk WHERE article_id=$1',[id])).rows[0].n,0)
      await remove()
    })
    await t.test('concurrent claim does not duplicate calls and stale result cannot overwrite updated article', async () => {
      const id = await create(); const generation = (await state(id)).id; let release!: () => void, entered!: () => void
      const waiting = new Promise<void>(r => { release=r }), started = new Promise<void>(r => { entered=r })
      const old = indexNextHelpArticle(pool, async inputs => { entered(); await waiting; return embed(inputs) })
      await started
      assert.equal((await indexNextHelpArticle(pool,embed)).processed,false)
      await updateContent(id, 'Latest generation')
      await indexNextHelpArticle(pool,embed)
      release();assert.equal((await old).stale,true)
      assert.notEqual((await state(id)).id,generation)
      assert.equal((await state(id)).status,'ready')
      assert.equal((await pool.query('SELECT body FROM help_article_chunk WHERE article_id=$1',[id])).rows[0].body,'Latest generation')
      await remove()
    })
    await t.test('expired worker is fenced, recovery works, exhausted leases stop', async () => {
      const id = await create()
      await pool.query("UPDATE scheduled_task SET status='processing',schedule_at=now()-interval '1 minute',attempts=1 WHERE kind='help_index' AND ref_id=$1",[id])
      await indexNextHelpArticle(pool,embed)
      assert.equal((await state(id)).status,'ready')
      await pool.query("UPDATE scheduled_task SET status='processing',schedule_at=now()-interval '1 minute',attempts=5 WHERE kind='help_index' AND ref_id=$1",[id])
      await indexNextHelpArticle(pool,embed)
      assert.equal((await state(id)).status,'failed')
      await remove()
    })
    await t.test('five transient failures stop and partial fragment writes roll back', async () => {
      const id = await create()
      for (let n=1;n<=5;n++) {
        await pool.query("UPDATE scheduled_task SET schedule_at=now() WHERE kind='help_index' AND ref_id=$1",[id])
        await indexNextHelpArticle(pool,async () => { throw new HelpEmbeddingError('provider_503',true) })
        assert.equal((await state(id)).attempts,n)
        assert.equal((await state(id)).status,n===5?'failed':'retry')
      }
      assert.equal((await indexNextHelpArticle(pool,embed)).processed,false)
      await updateContent(id, '# First\nfirst section\n# Second\nsecond section')
      await indexNextHelpArticle(pool,async () => [vector(),[1]])
      assert.equal((await state(id)).status,'retry')
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM help_article_chunk WHERE article_id=$1',[id])).rows[0].n,0)
      await remove()
    })
    await t.test('permanent provider error stops and deletion during a call cannot resurrect chunks', async () => {
      const id = await create()
      await indexNextHelpArticle(pool,async () => { throw new HelpEmbeddingError('provider_401',false) })
      assert.equal((await state(id)).status,'failed')
      await pool.query("UPDATE scheduled_task SET id=gen_random_uuid(),status='pending',attempts=0,result=NULL,schedule_at=now() WHERE kind='help_index' AND ref_id=$1",[id])
      await indexNextHelpArticle(pool,async inputs => { await deleteArticle(id);return embed(inputs) })
      assert.equal(await state(id),undefined)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM help_article_chunk WHERE article_id=$1',[id])).rows[0].n,0)
    })
    await t.test('immediate indexing targets the saved article rather than unrelated backlog', async () => {
      const backlog = await create(), current = await create()
      await indexNextHelpArticle(pool,embed,undefined,current)
      assert.equal((await state(current)).status,'ready')
      assert.equal((await state(backlog)).status,'pending')
      const task = await state(current)
      assert.equal((await pool.query('SELECT generation_id FROM help_article_chunk WHERE article_id=$1',[current])).rows[0].generation_id,task.id)
      await remove()
    })
    await t.test('lease takeover fences the old attempt even without a content edit', async () => {
      const id = await create(); let release!: () => void, entered!: () => void
      const waiting = new Promise<void>(r => { release=r }), started = new Promise<void>(r => { entered=r })
      const old = indexNextHelpArticle(pool,async inputs => { entered(); await waiting; return embed(inputs) })
      try {
        await started
        const original = await state(id)
        await pool.query("UPDATE scheduled_task SET schedule_at=now()-interval '1 second' WHERE kind='help_index' AND ref_id=$1",[id])
        await indexNextHelpArticle(pool,embed)
        const recovered = await state(id)
        assert.equal(recovered.id,original.id)
        assert.equal(recovered.attempts,2)
        assert.equal(recovered.status,'ready')
        release();assert.equal((await old).stale,true)
        assert.equal((await state(id)).status,'ready')
      } finally { release();await old;await remove() }
    })
    await t.test('unpublish during embedding fences the worker and blocks stale writeback', async () => {
      const id = await create()
      let release!: () => void, entered!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const started = new Promise<void>(resolve => { entered = resolve })
      const worker = indexNextHelpArticle(pool, async input => { entered(); await gate; return embed(input) }, undefined, id)
      await started
      try {
        await write(async client => {
          await client.query("UPDATE help_article SET status='archived' WHERE id=$1", [id])
          await pauseHelpIndex(drizzle(client), id)
        })
        const paused = await state(id)
        assert.equal(paused.result, 'paused')
        release()
        assert.equal((await worker).stale, true)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM help_article_chunk WHERE article_id=$1', [id])).rows[0].n, 0)
        assert.equal((await state(id)).id, paused.id)
      } finally { release(); await worker; await remove() }
    })
    await t.test('tenant, public visibility and ai_enabled filter BEFORE vector ranking; live unpublish applies immediately', async () => {
      const visible=await create(), privateId=await create({collection:hidden}), draft=await create({status:'draft'}), noAI=await create({ai:false}), foreign=await create({org:other})
      for(let i=0;i<5;i++)await indexNextHelpArticle(pool,embed)
      const publicRows=await searchHelpVectors(pool,org,'如何退款','public',12,embed)
      assert.deepEqual(new Set(publicRows.map(r=>r.articleId)),new Set([visible,noAI]))
      const agentRows=await searchHelpVectors(pool,org,'返金','agent',12,embed)
      assert.deepEqual(new Set(agentRows.map(r=>r.articleId)),new Set([visible,privateId]))
      assert.ok(!agentRows.some(r=>r.articleId===foreign || r.articleId===draft))
      await pool.query("UPDATE help_article SET status='archived' WHERE id=$1",[visible])
      assert.ok(!(await searchHelpVectors(pool,org,'refund','public',12,embed)).some(r=>r.articleId===visible))
      assert.ok(!(await searchHelpVectors(pool,org,'refund','agent',12,embed)).some(r=>r.articleId===visible))
      await remove()
      let calls=0
      await searchHelpVectors(pool,org,'refund','public',12,async x=>{calls++;return embed(x)})
      assert.equal(calls,0)
    })
  } finally {
    await remove();await pool.query('DELETE FROM help_collection WHERE org_id=$1',[org]);await pool.query('DELETE FROM organization WHERE id IN ($1,$2)',[org,other]);await pool.end();delete process.env.HELP_VECTOR_SEARCH
  }
})

import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { Pool, type PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import { importIndividualWebSourcePages, removeWebSource, syncWebSourcePages } from '../server/services/web-source'
import { startWebSourceRun, webSourceTransaction } from '../server/lib/web-source/jobs'
import { runNextWebSourceTask } from '../server/lib/web-source/worker'
import type { CrawlResponse } from '../server/lib/web-source/fetch'
import { scheduleInbox } from '../server/lib/inbox/scheduler'

// Real row locks and transaction rollback require an explicitly provisioned local DB.
const databaseUrl = process.env.WEB_SOURCE_TEST_DATABASE_URL
test('PostgreSQL website synchronization and concurrent management', { skip: !databaseUrl, timeout: 45000 }, async t => {
  const url = new URL(databaseUrl!)
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && /^\/feedlog_web_source_tasks_\d+$/.test(url.pathname))
  const pool = new Pool({ connectionString: url.href, max: 8 })
  const orgId = 'source-concurrency-' + uuidv7()
  await pool.query('INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)', [orgId])
  async function seed(context: TestContext, address: string, paths = ['/guide'], id = uuidv7()) {
    await pool.query("INSERT INTO ai_training_website(id,org_id,url,name,frequency) VALUES($1,$2,$3,'Docs','manual')", [id, orgId, address])
    context.after(async () => {
      if ((await pool.query('SELECT id FROM ai_training_website WHERE id=$1', [id])).rows.length) await removeWebSource(pool, orgId, id)
    })
    const pages = paths.map(path => ({ id: uuidv7(), url: new URL(path, address).href }))
    for (const page of pages) await pool.query('INSERT INTO ai_training_web_page(id,org_id,website_id,url,metadata) VALUES($1,$2,$3,$4,$5::jsonb)', [page.id, orgId, id, page.url, JSON.stringify({ title: 'Widget guide' })])
    return { id, pages }
  }
  const bindClient = (client: PoolClient) => ({
    query: client.query.bind(client), connect: async () => ({ query: client.query.bind(client), release() {} }),
  }) as unknown as Pool
  const settle = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  let version = 1
  const fetcher = async (value: string): Promise<CrawlResponse> => ({ url: value, status: 200, headers: { 'content-type': 'text/html', etag: 'v' + version },
    body: value.endsWith('/robots.txt') ? '' : `<main><h1>Widget guide</h1><h2>Install</h2><p>Install the widget and configure notifications. Version ${version}. Teams can collect feedback from customers.</p><h2>Configure</h2><p>Configure notifications in the dashboard and share the widget with your team.</p></main>` })
  const options = {
    fetcher,
    prepare: async (page: { content: string }) => ({ content: page.content, summary: 'Widget installation and configuration.', keywords: ['widget'], evidence: ['Install the widget'] }),
    embed: async (inputs: string[]) => inputs.map(() => [1, ...Array(767).fill(0)]),
  }
  try {
    await t.test('manual and scheduled starts share one running round', async context => {
      const source = await seed(context, 'https://race.example.com')
      await pool.query("UPDATE ai_training_website SET frequency='weekly' WHERE id=$1", [source.id])
      const outcomes = await Promise.all([
        settle(webSourceTransaction(pool, client => startWebSourceRun(client, orgId, source.id, 'manual'))),
        settle(webSourceTransaction(pool, client => startWebSourceRun(client, orgId, source.id, 'scheduled'))),
      ])
      const { rows } = await pool.query("SELECT id FROM ai_training_website_run WHERE website_id=$1 AND status='running'", [source.id])
      assert.equal(rows.length, 1)
      for (const result of outcomes) {
        if (result.error) assert.equal(result.error.statusCode, 409)
        else assert.equal(result.value, rows[0].id)
      }
    })

    await t.test('opposing creation and ID order cannot deadlock import against a batch', async context => {
      const ids = [uuidv7(), uuidv7()].sort()
      const first = await seed(context, 'https://first.example.com', ['/guide'], ids[0])
      const second = await seed(context, 'https://second.example.com', ['/guide'], ids[1])
      await pool.query("UPDATE ai_training_website SET created_at=CASE WHEN id=$1 THEN '2026-01-02'::timestamptz ELSE '2026-01-01'::timestamptz END WHERE id=ANY($2::uuid[])", [first.id, ids])
      const importer = await pool.connect(), batch = await pool.connect()
      try {
        await importer.query('SET statement_timeout=5000')
        await batch.query('SET statement_timeout=5000')
        const importerPid = (await importer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        const batchPid = (await batch.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        await batch.query('BEGIN')
        // Pause the batch after its first source lock, before requesting the rest.
        await batch.query('SELECT id FROM ai_training_website WHERE id=$1 FOR UPDATE', [first.id])
        const importing = settle(importIndividualWebSourcePages(bindClient(importer), orgId, { urls: ['https://first.example.com/new'], frequency: 'manual' }))
        let blocked = false
        for (let attempt = 0; attempt < 100; attempt++) {
          blocked = (await pool.query('SELECT $2::int=ANY(pg_blocking_pids($1)) AS blocked', [importerPid, batchPid])).rows[0].blocked
          if (blocked) break
          await pause(10)
        }
        if (!blocked) {
          await batch.query('ROLLBACK')
          await importing
          assert.fail('Import did not reach the source lock')
        }
        const bulk = settle(syncWebSourcePages(bindClient(batch), orgId, [first.pages[0]!.id, second.pages[0]!.id]))
        const [importResult, batchResult] = await Promise.all([importing, bulk])
        assert.equal(batchResult.error, undefined)
        assert.equal(batchResult.value?.affected, 2)
        assert.equal(importResult.error?.statusCode, 409, 'the import loses to an active sync, not to a deadlock')
        assert.equal((await pool.query('SELECT count(*)::int AS total FROM ai_training_web_page WHERE website_id=ANY($1::uuid[])', [ids])).rows[0].total, 2, 'the rejected import rolls back its new page')
      } finally {
        await importer.query('ROLLBACK'); await batch.query('ROLLBACK')
        importer.release(); batch.release()
      }
    })

    await t.test('locking by ID preserves oldest-created matching source precedence', async context => {
      const ids = [uuidv7(), uuidv7()].sort()
      const broad = await seed(context, 'https://overlap.example.com', ['/guide'], ids[0])
      const nested = await seed(context, 'https://overlap.example.com/docs', ['/docs/guide'], ids[1])
      await pool.query("UPDATE ai_training_website SET created_at=CASE WHEN id=$1 THEN '2026-01-02'::timestamptz ELSE '2026-01-01'::timestamptz END WHERE id=ANY($2::uuid[])", [broad.id, ids])
      const result = await importIndividualWebSourcePages(pool, orgId, { urls: ['https://overlap.example.com/docs/new'], frequency: 'manual' })
      assert.deepEqual(result.sourceIds, [nested.id])
    })

    for (const outcome of ['success', 'failure']) await t.test('capacity waiting preserves a former retry after peer ' + outcome, async context => {
      const previous = process.env.WEB_SOURCE_CONCURRENCY
      process.env.WEB_SOURCE_CONCURRENCY = '1'
      context.after(() => { if (previous === undefined) delete process.env.WEB_SOURCE_CONCURRENCY; else process.env.WEB_SOURCE_CONCURRENCY = previous })
      const source = await seed(context, 'https://wait-' + outcome + '.example.com', ['/a', '/b', '/c'])
      const [active, waiting, backingOff] = source.pages
      await webSourceTransaction(pool, client => startWebSourceRun(client, orgId, source.id, 'manual'))
      await pool.query("UPDATE scheduled_task SET schedule_at=clock_timestamp()-CASE WHEN ref_id=$1 THEN interval '2 seconds' ELSE interval '1 second' END WHERE kind='web_page' AND ref_id=ANY($2::uuid[])", [active!.id, [active!.id, waiting!.id]])
      await pool.query("UPDATE scheduled_task SET result='http_503',attempts=1 WHERE kind='web_page' AND ref_id=$1", [waiting!.id])
      await pool.query("UPDATE ai_training_web_page SET attempt_count=1,metadata=metadata||jsonb_build_object('error','http_503') WHERE id=$1", [waiting!.id])
      const { rows: [backoff] } = await pool.query("UPDATE scheduled_task SET result='http_500',attempts=1,schedule_at=clock_timestamp()+interval '30 seconds' WHERE kind='web_page' AND ref_id=$1 RETURNING schedule_at", [backingOff!.id])
      await pool.query("UPDATE ai_training_web_page SET attempt_count=1,metadata=metadata||jsonb_build_object('error','http_500') WHERE id=$1", [backingOff!.id])
      let release!: () => void, entered!: () => void
      const hold = new Promise<void>(resolve => release = resolve), claimed = new Promise<void>(resolve => entered = resolve)
      const first = runNextWebSourceTask(pool, { ...options,
        fetcher: async value => outcome === 'failure' && !value.endsWith('/robots.txt') ? { url: value, status: 503, headers: {}, body: '' } : fetcher(value),
        onClaim: async () => { entered(); await hold },
      })
      await claimed
      let deferred, during
      try {
        deferred = await runNextWebSourceTask(pool, options)
        during = (await pool.query(`SELECT t.result,extract(epoch FROM(t.schedule_at-clock_timestamp()))::float AS seconds,d.attempt_count
          FROM scheduled_task t JOIN ai_training_web_page d ON d.id=t.ref_id WHERE t.kind='web_page' AND t.ref_id=$1`, [waiting!.id])).rows[0]
      } finally { release() }
      const completed = await first
      assert.equal(deferred?.processed, false)
      assert.equal(during.result, 'http_503', 'capacity waiting does not overwrite the prior failure')
      assert.ok(during.seconds <= 0, 'the queued page is left due rather than assigned the peer lease deadline')
      assert.equal(during.attempt_count, 1, 'waiting does not consume a processing attempt')
      assert.equal(outcome === 'success' ? completed.ready : completed.retry, true)
      const { rows: [pending] } = await pool.query("SELECT extract(epoch FROM(schedule_at-clock_timestamp()))::float AS seconds FROM scheduled_task WHERE kind='web_page' AND ref_id=$1", [waiting!.id])
      assert.ok(pending.seconds <= 1)
      assert.deepEqual((await pool.query("SELECT schedule_at FROM scheduled_task WHERE kind='web_page' AND ref_id=$1", [backingOff!.id])).rows[0].schedule_at, backoff.schedule_at, 'a real failure keeps its own backoff')
      await pool.query("UPDATE scheduled_task SET schedule_at=clock_timestamp() WHERE kind='web_page' AND ref_id=$1", [waiting!.id])
      assert.equal((await runNextWebSourceTask(pool, options)).ready, true)
    })

    for (const concurrency of [4, 8]) await t.test(`pages overlap within a database-wide cap of ${concurrency} and wake when capacity returns`, async context => {
      const previous = process.env.WEB_SOURCE_CONCURRENCY
      process.env.WEB_SOURCE_CONCURRENCY = String(concurrency)
      context.after(() => { if (previous === undefined) delete process.env.WEB_SOURCE_CONCURRENCY; else process.env.WEB_SOURCE_CONCURRENCY = previous })
      const source = await seed(context, 'https://parallel.example.com', Array.from({ length: concurrency + 1 }, (_, index) => `/page-${index}`))
      const other = await seed(context, 'https://other-parallel.example.com')
      const runId = await webSourceTransaction(pool, client => startWebSourceRun(client, orgId, source.id, 'manual'))
      await webSourceTransaction(pool, client => startWebSourceRun(client, orgId, other.id, 'manual'))
      let release!: () => void, entered!: () => void, inFlight = 0
      const gate = new Promise<void>(resolve => release = resolve), fourEntered = new Promise<void>(resolve => entered = resolve)
      const tasks = Array.from({ length: concurrency + 2 }, () => settle(runNextWebSourceTask(pool, { ...options,
        prepare: async page => { inFlight++; if (inFlight === concurrency) entered(); await gate; return options.prepare(page) },
      })))
      const deliveries: number[] = []
      const transport = { maxDelaySeconds: 600, wakeResolutionMs: 1000, async send(_message: unknown, seconds: number) { deliveries.push(seconds) } }
      try {
        await Promise.race([fourEntered, pause(5000).then(() => { throw new Error('Configured pages did not reach preparation concurrently') })])
        assert.equal(inFlight, concurrency)
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM scheduled_task WHERE kind='web_page' AND status='processing' AND schedule_at>clock_timestamp()" )).rows[0].n, concurrency)
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM scheduled_task WHERE kind='web_page' AND status='pending' AND attempts=0")).rows[0].n, 2)
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM ai_training_web_page WHERE website_id=$1 AND sync_status='processing'", [source.id])).rows[0].n, concurrency)
        await assert.rejects(webSourceTransaction(pool, client => startWebSourceRun(client, orgId, source.id, 'manual')), /already running/)
        await scheduleInbox({ pool }, transport)
        assert.ok(deliveries[0]! > 0 && deliveries[0]! <= 7, 'full capacity schedules a short recovery wake without an immediate queue loop')
      } finally { release() }
      const outcomes = await Promise.all(tasks)
      assert.equal(outcomes.filter(row => row.value?.ready).length, concurrency)
      assert.equal(outcomes.filter(row => row.value?.processed === false).length, 2)
      assert.ok(outcomes.every(row => !row.error))
      const { rows: [run] } = await pool.query('SELECT status,total,added,failed FROM ai_training_website_run WHERE id=$1', [runId])
      assert.deepEqual(run, { status: 'running', total: concurrency + 1, added: concurrency, failed: 0 })
      await scheduleInbox({ pool }, transport)
      assert.equal(deliveries.at(-1), 0, 'completion advances the wake instead of waiting for the old lease')
      assert.ok((await Promise.all([runNextWebSourceTask(pool, options), runNextWebSourceTask(pool, options)])).every(row => row.ready))
      assert.deepEqual((await pool.query('SELECT status,total,added,failed FROM ai_training_website_run WHERE id=$1', [runId])).rows[0], { status: 'done', total: concurrency + 1, added: concurrency + 1, failed: 0 })
      const chunks = await pool.query("SELECT content_id,count(*)::int AS n FROM content_chunk WHERE content_type='web_page' AND content_id=ANY($1::uuid[]) GROUP BY content_id", [source.pages.map(page => page.id)])
      assert.equal(chunks.rows.length, concurrency + 1)
      await pool.query('DELETE FROM delay_message')
    })

    await t.test('removing a source during parallel preparation fences all late publishers', async context => {
      const source = await seed(context, 'https://parallel-remove.example.com', ['/a', '/b'])
      await webSourceTransaction(pool, client => startWebSourceRun(client, orgId, source.id, 'manual'))
      let release!: () => void, entered!: () => void, preparing = 0
      const gate = new Promise<void>(resolve => release = resolve), bothEntered = new Promise<void>(resolve => entered = resolve)
      const tasks = Array.from({ length: 2 }, () => settle(runNextWebSourceTask(pool, { ...options,
        prepare: async page => { if (++preparing === 2) entered(); await gate; return options.prepare(page) },
      })))
      try {
        await Promise.race([bothEntered, pause(5000).then(() => { throw new Error('Both pages did not enter preparation') })])
        await removeWebSource(pool, orgId, source.id)
      } finally { release() }
      const results = await Promise.all(tasks)
      assert.ok(results.every(row => row.value?.superseded && !row.error))
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM content_chunk WHERE content_type='web_page' AND content_id=ANY($1::uuid[])", [source.pages.map(page => page.id)])).rows[0].n, 0)
    })

    await t.test('a failed chunk insert rolls back the manifest and complete published generation', async context => {
      const source = await seed(context, 'https://rollback.example.com')
      const pageId = source.pages[0]!.id
      const start = () => webSourceTransaction(pool, client => startWebSourceRun(client, orgId, source.id, 'manual'))
      await start()
      assert.equal((await runNextWebSourceTask(pool, options)).ready, true)
      const { rows: [before] } = await pool.query('SELECT metadata,indexed_at FROM ai_training_web_page WHERE id=$1', [pageId])
      const { rows: chunks } = await pool.query("SELECT ordinal,generation_id FROM content_chunk WHERE content_type='web_page' AND content_id=$1 ORDER BY ordinal", [pageId])
      assert.ok(chunks.length >= 2)
      await pool.query("CREATE FUNCTION fail_website_chunk() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture chunk insert failure'; END $$")
      try {
        await pool.query(`CREATE TRIGGER fail_website_chunk BEFORE INSERT ON content_chunk FOR EACH ROW
          WHEN (NEW.content_type='web_page' AND NEW.content_id='${pageId}'::uuid AND NEW.ordinal=1) EXECUTE FUNCTION fail_website_chunk()`)
        version++
        await start()
        assert.equal((await runNextWebSourceTask(pool, options)).retry, true)
        const { rows: [after] } = await pool.query('SELECT metadata,indexed_at FROM ai_training_web_page WHERE id=$1', [pageId])
        assert.equal(after.metadata.content, before.metadata.content)
        assert.equal(after.metadata.chunkCount, before.metadata.chunkCount)
        assert.equal(after.metadata.indexGeneration, before.metadata.indexGeneration)
        assert.deepEqual(after.indexed_at, before.indexed_at)
        assert.deepEqual((await pool.query("SELECT ordinal,generation_id FROM content_chunk WHERE content_type='web_page' AND content_id=$1 ORDER BY ordinal", [pageId])).rows, chunks)
      } finally {
        await pool.query('DROP TRIGGER IF EXISTS fail_website_chunk ON content_chunk')
        await pool.query('DROP FUNCTION fail_website_chunk()')
      }
      await pool.query("UPDATE scheduled_task SET schedule_at=clock_timestamp() WHERE kind='web_page' AND ref_id=$1", [pageId])
      assert.equal((await runNextWebSourceTask(pool, options)).ready, true)
      const { rows: [rebuilt] } = await pool.query('SELECT metadata FROM ai_training_web_page WHERE id=$1', [pageId])
      assert.notEqual(rebuilt.metadata.indexGeneration, before.metadata.indexGeneration)
      assert.equal(rebuilt.metadata.chunkCount, chunks.length)
    })
  } finally {
    await pool.query('DELETE FROM organization WHERE id=$1', [orgId])
    await pool.end()
  }
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Pool } from 'pg'

const target = process.env.BOARD_TEST_URL

test('public board status filters apply before pagination, counts and search limits', { skip: !target, timeout: 120_000 }, async (t) => {
  const origin = new URL(target!).origin
  const database = new URL(process.env.BOARD_TEST_DATABASE_URL ?? process.env.DATABASE_URL!)
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
  assert.ok(['localhost', '127.0.0.1'].includes(database.hostname))
  assert.match(database.pathname, /test|review/, 'Use an isolated test database')
  const port = Number(process.env.BOARD_TEST_EMBEDDING_PORT)
  assert.ok(Number.isSafeInteger(port) && port > 0, 'Configure the application to use this local embedding stub')
  const pool = new Pool({ connectionString: database.href })
  const orgId = process.env.BOARD_TEST_ORG_ID ?? 'default-org'
  const prefix = `board-test-${randomUUID()}`
  const authorId = prefix
  const otherOrg = `${prefix}-other`
  const boardId = randomUUID()
  const emptyBoardId = randomUUID()
  const feedbackIds: string[] = []
  const vector = (x: number, y = 0) => [x, y, ...Array<number>(766).fill(0)]
  let semantic = true
  let embeddingRequests = 0
  const embedding = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the request before replying. */ }
    embeddingRequests++
    response.setHeader('content-type', 'application/json')
    response.writeHead(semantic ? 200 : 503)
    response.end(JSON.stringify(semantic ? { data: [{ embedding: vector(1) }] } : { error: 'Test fallback' }))
  })
  await new Promise<void>(resolve => embedding.listen(port, '127.0.0.1', resolve))
  async function get(path: string) {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(20_000) })
    assert.equal(response.status, 200, await response.clone().text())
    return response.json()
  }
  async function insert(status: string, title: string, options: { org?: string; board?: string; mergedTo?: string; embedding?: number[] } = {}) {
    const id = randomUUID()
    await pool.query('INSERT INTO post (id,org_id,title,slug,content,status,board_id,author_id,merged_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, options.org ?? orgId, title, id, title, status, options.board ?? boardId, authorId, options.mergedTo ?? null])
    feedbackIds.push(id)
    await pool.query('INSERT INTO post_search (post_id,org_id,search_text) VALUES ($1,$2,$3)', [id, options.org ?? orgId, title])
    if (options.embedding) await pool.query('INSERT INTO post_embedding (post_id,org_id,embedding,model,content_hash) VALUES ($1,$2,$3,$4,$5)',
      [id, options.org ?? orgId, JSON.stringify(options.embedding), 'test', id])
    return id
  }
  try {
    await pool.query('INSERT INTO "user" (id,name,email) VALUES ($1,$1,$2)', [authorId, `${prefix}@example.invalid`])
    await pool.query('INSERT INTO organization (id,name,slug) VALUES ($1,$1,$1)', [otherOrg])
    for (const id of [boardId, emptyBoardId]) {
      await pool.query('INSERT INTO board (id,org_id,name,position) VALUES ($1,$2,$3,1000)', [id, orgId, id === boardId ? prefix : `${prefix}-empty`])
    }
    const live: string[] = []
    for (const status of ['open', 'planned', 'in_progress', 'done']) {
      const id = await insert(status, `${prefix} ${status}`)
      if (status !== 'done') live.push(id)
    }
    const needle = `${prefix} search regression`
    for (let i = 0; i < 30; i++) await insert('done', needle, { embedding: vector(1) })
    const wanted = await insert('open', `${needle} pending change`, { embedding: vector(0.8, 0.2) })
    live.push(wanted)
    const merged = await insert('open', needle, { mergedTo: wanted, embedding: vector(1) })
    const foreign = await insert('open', needle, { org: otherOrg, embedding: vector(1) })

    await t.test('list pagination and sidebar counts share status and merged-post rules', async () => {
      const seen: string[] = []
      let cursor: string | undefined
      do {
        const params = new URLSearchParams({ boardId, status: 'open,planned,in_progress', pageSize: '2' })
        if (cursor) params.set('cursor', cursor)
        const page = await get(`/api/posts?${params}`)
        seen.push(...page.data.map((post: { id: string }) => post.id))
        cursor = page.pagination.nextCursor
      } while (cursor)
      assert.deepEqual(seen.sort(), live.sort())
      const overview = await get('/api/boards?status=open,planned,in_progress')
      assert.equal(overview.data.find((board: { id: string }) => board.id === boardId).postCount, live.length)
      assert.equal(overview.data.find((board: { id: string }) => board.id === emptyBoardId).postCount, 0)
      const all = await get('/api/boards')
      assert.equal(all.data.find((board: { id: string }) => board.id === boardId).postCount, 35)
      const invalid = await get('/api/boards?status=invalid')
      assert.equal(invalid.data.find((board: { id: string }) => board.id === boardId).postCount, 35)
    })

    for (const mode of ['semantic', 'trigram']) {
      await t.test(`${mode} search filters before the top-30 limit and preserves tenant boundaries`, async () => {
        semantic = mode === 'semantic'
        const before = embeddingRequests
        const query = new URLSearchParams({ q: needle, status: 'open,planned,in_progress' })
        const result = await get(`/api/posts/search?${query}`)
        assert.ok(result.data.some((post: { id: string }) => post.id === wanted))
        assert.ok(result.data.every((post: { status: string }) => post.status !== 'done'))
        assert.ok(result.data.every((post: { id: string }) => post.id !== merged && post.id !== foreign))
        assert.ok(embeddingRequests > before, 'Exercise the configured embedding path before fallback')
        for (const status of ['done', 'invalid', '']) {
          const search = new URLSearchParams({ q: needle })
          if (status) search.set('status', status)
          const page = await get(`/api/posts/search?${search}`)
          assert.equal(page.data.length, 30)
          assert.ok(page.data.every((post: { status: string }) => post.status === 'done'))
        }
      })
    }
  } finally {
    await pool.query('DELETE FROM post WHERE id=ANY($1::uuid[])', [feedbackIds])
    await pool.query('DELETE FROM board WHERE id=ANY($1::uuid[])', [[boardId, emptyBoardId]])
    await pool.query('DELETE FROM organization WHERE id=$1', [otherOrg])
    await pool.query('DELETE FROM "user" WHERE id=$1', [authorId])
    await pool.end()
    await new Promise<void>((resolve, reject) => embedding.close(error => error ? reject(error) : resolve()))
  }
})

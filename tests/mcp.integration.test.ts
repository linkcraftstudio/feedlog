import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { test } from 'node:test'
import { request as httpRequest } from 'node:http'
import { Pool } from 'pg'
import { decodeJwt, SignJWT, generateKeyPair, exportJWK } from 'jose'
import { uuidv7 } from 'uuidv7'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

interface ToolData { id: string; items: { id: string; parent_id?: string; [key: string]: unknown }[]; organizations: { id: string }[]; error?: { code: string }; next_cursor: string | null; [key: string]: unknown }

const target = process.env.MCP_TEST_URL
test('MCP: OAuth, multi-organization access and all business tools', { skip: !target, timeout: 180_000 }, async t => {
  const origin = new URL(target!).origin
  const tenantHost = process.env.MCP_TEST_TENANT_HOST
  if (tenantHost) assert.match(tenantHost, /^[a-z0-9-]+\.localhost:\d+$/)
  const database = new URL(process.env.MCP_TEST_DATABASE_URL!)
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
  assert.ok(['localhost', '127.0.0.1'].includes(database.hostname))
  assert.match(database.pathname, /mcp/, 'An isolated MCP database is required')
  const pool = new Pool({ connectionString: database.href })
  const prefix = 'mcp-' + randomBytes(6).toString('hex')
  const password = randomBytes(24).toString('base64url')
  const resource = origin + '/api/mcp'
  const redirectUri = 'http://127.0.0.1:8765/callback'
  const org = tenantHost?.split('.')[0] ?? 'default-org'
  const otherOrg = prefix + '-other'
  const inaccessibleOrg = prefix + '-inaccessible'
  const userIds: string[] = []
  const clientIds: string[] = []
  const contentIds = { feedback: [] as string[], boards: [] as string[], articles: [] as string[], collections: [] as string[], changelogs: [] as string[] }
  const seen = new Set<string>()
  let cookie = ''
  let userId = ''
  let sdk: Client | undefined

  async function request(path: string, body?: unknown, headers: Record<string, string> = {}, method?: string) {
    const tenant = tenantHost && !path.startsWith('/api/auth/') && !path.startsWith('/.well-known/') && (!path.startsWith('/api/mcp') || path.startsWith('/api/mcp/connections'))
    if (tenant) return new Promise<Response>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = httpRequest(new URL(path, origin), {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { ...headers, ...(headers.origin === origin ? { origin: 'http://' + tenantHost } : {}), Host: tenantHost, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
        timeout: 15_000,
      }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const responseHeaders = new Headers()
          for (const [key, value] of Object.entries(response.headers)) for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) responseHeaders.append(key, entry)
          resolve(new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), { status: response.statusCode, headers: responseHeaders }))
        })
      })
      req.on('timeout', () => req.destroy(new Error('Tenant request timed out')))
      req.on('error', reject)
      req.end(payload)
    })
    return fetch(origin + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) })
  }
  async function ok(response: Response, status = 200) {
    const body = await response.json().catch(() => null)
    assert.equal(response.status, status, response.status === status ? undefined : JSON.stringify(body))
    return body
  }
  async function signup(name: string) {
    const response = await request('/api/auth/sign-up/email', { name, email: name + '@example.invalid', password }, { origin })
    const data = await ok(response)
    userIds.push(data.user.id)
    assert.equal((await pool.query('SELECT id FROM "user" WHERE id=$1', [data.user.id])).rowCount, 1, 'Server and test must use the same isolated database')
    return { userId: data.user.id as string, cookie: response.headers.getSetCookie().map(v => v.split(';')[0]).join('; '), token: data.token as string }
  }
  async function register() {
    const client = await ok(await request('/api/auth/oauth2/register', {
      client_name: 'Claude Code ' + prefix, redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'mcp:access offline_access',
    }), 201)
    clientIds.push(client.client_id)
    return client as { client_id: string }
  }
  async function begin(clientId: string, loginCookie = cookie, scope = 'mcp:access offline_access') {
    const verifier = randomBytes(32).toString('base64url')
    const params = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri, resource, scope,
      state: randomBytes(16).toString('hex'), code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') })
    const response = await ok(await request('/api/auth/oauth2/authorize?' + params, undefined, { cookie: loginCookie }))
    const page = new URL(response.url, origin)
    assert.equal(page.pathname, '/mcp/consent', 'Every authorization must show organization selection')
    const oauthQuery = page.search.slice(1)
    const context = await ok(await request('/api/mcp/consent-context?' + new URLSearchParams({ oauth_query: oauthQuery }), undefined, { cookie: loginCookie }))
    return { verifier, context, oauthQuery, state: params.get('state') }
  }
  async function consent(pending: Awaited<ReturnType<typeof begin>>, organizations: string[], accept = true, loginCookie = cookie) {
    const response = await ok(await request('/api/mcp/consent', {
      authorizationRequestId: pending.context.authorizationRequestId, expectedUserId: pending.context.user.id, accept, organizationIds: organizations,
    }, { origin, cookie: loginCookie }))
    const url = new URL(response.redirectUrl)
    assert.equal(url.searchParams.get('state'), pending.state)
    return { code: url.searchParams.get('code')!, verifier: pending.verifier, error: url.searchParams.get('error') }
  }
  async function token(values: Record<string, string>, headers: Record<string, string> = {}) {
    return fetch(origin + '/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(values) })
  }
  const exchange = (clientId: string, grant: { code: string; verifier: string }) => token({ grant_type: 'authorization_code', client_id: clientId, code: grant.code, code_verifier: grant.verifier, redirect_uri: redirectUri, resource })
  async function connect(accessToken: string, version: '2026-07-28' | '2025-06-18' = '2026-07-28') {
    const client = new Client({ name: 'feedlog-integration', version: '1.0.0' }, { versionNegotiation: { mode: version === '2026-07-28' ? { pin: version } : 'legacy' } })
    await client.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: 'Bearer ' + accessToken } } }))
    return client
  }
  async function call(name: string, args: Record<string, unknown> = {}, errorCode?: string) {
    seen.add(name)
    const response = await sdk!.callTool({ name, arguments: name === 'list_organizations' ? args : { organization_id: org, ...args } })
    const data = response.structuredContent as ToolData
    if (errorCode) { assert.equal(response.isError, true, name); assert.equal(data?.error?.code, errorCode, JSON.stringify(response)); return data }
    assert.equal(response.isError, undefined, name + ': ' + JSON.stringify(response))
    assert.deepEqual(JSON.parse((response.content as { text: string }[])[0]!.text), data)
    return data
  }
  try {
    const owner = await signup(prefix + '-owner')
    userId = owner.userId; cookie = owner.cookie
    await pool.query('INSERT INTO organization(id,name,slug,metadata) VALUES($1,$1,$1,$2) ON CONFLICT(id) DO NOTHING', [org, JSON.stringify({ portalModules: { helpCenter: true } })])
    await pool.query('UPDATE organization SET metadata=$1 WHERE id=$2', [JSON.stringify({ portalModules: { helpCenter: true } }), org])
    for (const id of [otherOrg, inaccessibleOrg]) await pool.query('INSERT INTO organization(id,name,slug) VALUES($1,$1,$1)', [id])
    for (const id of [org, otherOrg]) await pool.query('INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,$4)', [uuidv7(), id, userId, 'owner'])
    const other = await signup(prefix + '-member')
    await pool.query('INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,$4)', [uuidv7(), org, other.userId, 'contributor'])
    await pool.query('INSERT INTO verification(id,identifier,value,expires_at) VALUES($1,$1,$2,now()+interval \'10 minutes\')', [prefix + '-plain-verification', 'not-json'])

    await t.test('existing organization permissions and invitation flow', async () => {
      const permissions = await ok(await request('/api/auth/organization/has-permission', { organizationId: org, permissions: { feedlog: ['moderate'] } }, { cookie, origin }))
      assert.equal(permissions.success, true)
      const invitation = await ok(await request('/api/auth/organization/invite-member', { organizationId: org, email: prefix + '-invite@example.invalid', role: 'contributor' }, { cookie, origin }))
      await ok(await request('/api/auth/organization/cancel-invitation', { invitationId: invitation.id }, { cookie, origin }))
      await pool.query('DELETE FROM invitation WHERE id=$1', [invitation.id])
    })

    await t.test('discovery, session rejection and Origin validation', async () => {
      const metadata = await ok(await request('/.well-known/oauth-protected-resource/api/mcp'))
      assert.equal(metadata.resource, resource)
      assert.deepEqual(metadata.authorization_servers, [origin + '/api/auth'])
      assert.deepEqual(metadata.scopes_supported, ['mcp:access'])
      for (const headers of [{ cookie }, { authorization: 'Bearer ' + owner.token }, { authorization: 'Bearer invalid' }]) {
        const response = await request('/api/mcp', {}, headers)
        assert.equal(response.status, 401, await response.text())
        assert.match(response.headers.get('www-authenticate')!, /resource_metadata=/)
        assert.match(response.headers.get('www-authenticate')!, /scope="mcp:access offline_access"/)
      }
      assert.equal((await request('/api/mcp', {}, { origin: 'https://untrusted.invalid' })).status, 403)
      assert.equal((await request('/api/mcp')).status, 405)
      assert.equal((await request('/api/auth/oauth2/register', { redirect_uris: [redirectUri], scope: 'admin:all' })).status, 400)
    })
    const registered = await register()
    await t.test('signed context, denial, direct plugin bypass and account binding', async () => {
      const pending = await begin(registered.client_id)
      assert.deepEqual(pending.context.selectedOrganizationIds, [])
      assert.equal(pending.context.client.type, 'claude-code')
      const forged = new URLSearchParams(pending.oauthQuery); forged.set('client_id', 'forged')
      assert.equal((await request('/api/mcp/consent-context?' + new URLSearchParams({ oauth_query: forged.toString() }), undefined, { cookie })).status, 400)
      assert.equal((await request('/api/auth/oauth2/consent', { accept: true, oauth_query: pending.oauthQuery }, { cookie, origin })).status, 403)
      assert.equal((await request('/api/mcp/consent', { authorizationRequestId: pending.context.authorizationRequestId, expectedUserId: other.userId, accept: true, organizationIds: [org] }, { cookie, origin })).status, 409)
      const denied = await consent(pending, [], false)
      assert.equal(denied.error, 'access_denied')
      assert.equal((await request('/api/mcp/consent', { authorizationRequestId: pending.context.authorizationRequestId, expectedUserId: userId, accept: true, organizationIds: [org] }, { cookie, origin })).status, 400)
    })
    const grant = await consent(await begin(registered.client_id), [org, otherOrg])
    const tokens = await ok(await exchange(registered.client_id, grant))
    const claims = decodeJwt(tokens.access_token)
    const consentId = claims.mcp_consent_id as string
    assert.ok(consentId); assert.equal(claims.sub, userId); assert.equal(claims.aud, resource)
    assert.ok(claims.exp! - claims.iat! <= 900)
    sdk = await connect(tokens.access_token)
    const tools = (await sdk.listTools()).tools
    assert.equal(tools.length, 36)
    const legacy = await connect(tokens.access_token, '2025-06-18')
    assert.equal((await legacy.listTools()).tools.length, 36)
    await legacy.close()
    await t.test('authorized organizations, complete compact list and membership isolation', async () => {
      assert.deepEqual((await call('list_organizations')).organizations.map((x: { id: string }) => x.id).sort(), [org, otherOrg].sort())
      await call('list_boards', { organization_id: inaccessibleOrg }, 'FORBIDDEN')
      const listing = await ok(await request('/api/mcp/connections', undefined, { cookie }))
      assert.equal(listing.items[0].id, consentId)
      assert.equal(listing.items[0].isOwn, true)
      assert.equal(listing.items[0].actions.manageOrganizations, true)
      assert.equal(listing.items[0].organizationIds, undefined)
      assert.equal(listing.items[0].lastUsedAt, null)
    })
    let first = '', second = '', third = '', boardId = ''
    await t.test('boards, feedback CRUD, microsecond cursor and cross-organization validation', async () => {
      boardId = (await call('create_board', { name: prefix + ' Board', description: 'Integration board' })).id
      contentIds.boards.push(boardId)
      await call('update_board', { board_id: boardId, name: prefix + ' Updated' })
      assert.ok((await call('list_boards')).items.some((x: { id: string }) => x.id === boardId))
      for (const title of ['First', 'Second', 'Third']) {
        const record = await call('create_feedback', { title: prefix + ' ' + title, content: 'Markdown **feedback** for integration testing.', board_id: boardId })
        contentIds.feedback.push(record.id)
      }
      ;[first, second, third] = contentIds.feedback
      await pool.query('UPDATE post SET created_at=$1 WHERE id=$2', ['2099-01-01T00:00:00.000456Z', first])
      await pool.query('UPDATE post SET created_at=$1 WHERE id=$2', ['2099-01-01T00:00:00.000123Z', second])
      const page = await call('list_feedback', { limit: 1, query: prefix })
      assert.equal(page.items[0].id, first)
      const legacyFingerprint = createHash('sha256').update(JSON.stringify({ kind: 'feedback', organizationId: org, filter: { query: prefix, include_merged: false, sort: 'created_desc' }, sort: 'created_at', ascending: false })).digest('hex')
      const legacyCursor = btoa(JSON.stringify({ v: 1, filter: legacyFingerprint, key: '2099-01-01T00:00:00.000456Z', id: first }))
      assert.equal((await call('list_feedback', { limit: 1, query: prefix, cursor: legacyCursor })).items[0]!.id, second)
      const next = await call('list_feedback', { limit: 1, query: prefix, cursor: page.next_cursor })
      assert.equal(next.items[0].id, second)
      await call('list_feedback', { limit: 1, query: 'different', cursor: page.next_cursor }, 'INVALID_CURSOR')
      await call('update_feedback', { feedback_id: first, status: 'planned', title: prefix + ' Revised' })
      assert.equal((await call('get_feedback', { feedback_id: first })).status, 'planned')
      await call('get_feedback', { organization_id: otherOrg, feedback_id: first }, 'NOT_FOUND')
      await call('create_feedback', { organization_id: otherOrg, title: 'Invalid board', content: 'Must not persist', board_id: boardId }, 'NOT_FOUND')
      const webBoards = await ok(await request('/api/boards', undefined, { cookie }))
      assert.equal(webBoards.data.find((item: { id: string }) => item.id === boardId).postCount, 3)
      const webFeedback = await ok(await request('/api/admin/posts?boardId=' + boardId, undefined, { cookie }))
      assert.equal(webFeedback.pagination.total, 3)
      assert.deepEqual(webFeedback.data.map((item: { id: string }) => item.id).sort(), [first, second, third].sort())
      const detail = await call('get_feedback', { feedback_id: first })
      const webDetail = await ok(await request('/api/posts/' + detail.slug, undefined, { cookie }))
      assert.equal(webDetail.content, detail.content)
      assert.equal(webDetail.status, detail.status)
      assert.deepEqual(Object.keys(webDetail).sort(), ['id', 'sourceConversationId', 'sourceConversationTitle', 'slug', 'title', 'content', 'status', 'boardId', 'voteCount', 'commentCount', 'mergedTo', 'mergedCount', 'hasVoted', 'subscribed', 'author', 'createdAt', 'updatedAt'].sort())
      const publicPage = await ok(await request('/api/posts?pageSize=1', undefined, { cookie }))
      assert.equal(publicPage.data[0].id, first)
      assert.ok(publicPage.pagination.nextCursor)
      const secondWebPage = await ok(await request('/api/posts?pageSize=1&cursor=' + encodeURIComponent(publicPage.pagination.nextCursor), undefined, { cookie }))
      assert.equal(secondWebPage.data[0].id, second)
      const webBoard = await ok(await request('/api/admin/boards', { name: prefix + ' Web board' }, { cookie, origin }), 201)
      contentIds.boards.push(webBoard.id)
      assert.ok((await call('list_boards')).items.some(item => item.id === webBoard.id))
      await call('find_similar_feedback', { feedback_id: first })
      await call('find_similar_feedback', { title: prefix, content: 'Markdown feedback', limit: 3 })
      await call('find_similar_feedback', { organization_id: otherOrg, feedback_id: first }, 'NOT_FOUND')
      await call('update_feedback', { feedback_id: first }, 'INVALID_ARGUMENT')
      await call('create_feedback_comment', { feedback_id: first, content: ' ' }, 'INVALID_ARGUMENT')
    })
    await t.test('comments, author-only editing, replies and counter cleanup', async () => {
      const parent = await call('create_feedback_comment', { feedback_id: first, content: 'A public reply.', notify_voters: false })
      const reply = await call('create_feedback_comment', { feedback_id: first, content: 'A nested reply.', parent_id: parent.id })
      await call('update_feedback_comment', { comment_id: parent.id, content: 'Updated public reply.' })
      const comments = await call('list_feedback_comments', { feedback_id: first })
      assert.equal(comments.items.length, 2)
      await pool.query('UPDATE "user" SET image=$1 WHERE id=$2', ['/api/files/avatar.png', userId])
      const latest = await call('get_feedback', { feedback_id: first })
      const latestComments = latest.comments as { id: string; author: { image: string } }[]
      assert.deepEqual(latestComments.map(item => item.id), [reply.id, parent.id])
      assert.ok(latestComments[0]!.author.image.startsWith('http://'))
      const ascending = await call('list_feedback_comments', { feedback_id: first, sort: 'created_asc' })
      assert.deepEqual(ascending.items.map(item => item.id), [parent.id, reply.id])
      await pool.query('UPDATE "user" SET image=NULL WHERE id=$1', [userId])
      assert.equal((comments.items[0] as Record<string, unknown>).feedback_id, first)
      assert.equal((comments.items[0] as Record<string, unknown>).post_id, undefined)
      assert.equal(comments.items.find((x: { id: string }) => x.id === reply.id).parent_id, parent.id)
      const webComments = await ok(await request('/api/posts/' + first + '/comments?withChildren=true&sort=newest', undefined, { cookie }))
      assert.equal(webComments.data[0].id, parent.id)
      assert.equal(webComments.data[0].children[0].id, reply.id)
      assert.equal(webComments.data[0].content, 'Updated public reply.')
      const likes = await Promise.all([1, 2].map(() => request('/api/comments/' + parent.id + '/like', {}, { cookie: other.cookie, origin })))
      for (const response of likes) assert.equal((await ok(response)).likeCount, 1)
      const anotherPerson = await ok(await request('/api/posts/' + first + '/comments', { content: 'Another person wrote this.' }, { cookie: other.cookie, origin }), 201)
      await call('update_feedback_comment', { comment_id: anotherPerson.id, content: 'Must not rewrite another author' }, 'FORBIDDEN')
      await call('delete_feedback_comment', { comment_id: anotherPerson.id })
      await call('create_feedback_comment', { feedback_id: second, parent_id: parent.id, content: 'Wrong thread' }, 'NOT_FOUND')
      const [, racingLike] = await Promise.all([
        call('delete_feedback_comment', { comment_id: parent.id }),
        request('/api/comments/' + parent.id + '/like', {}, { cookie: other.cookie, origin }),
      ])
      assert.ok([200, 404].includes(racingLike.status))
      assert.equal((await pool.query('SELECT * FROM comment_like WHERE comment_id=$1', [parent.id])).rowCount, 0)
      assert.equal((await call('get_feedback', { feedback_id: first })).comment_count, 0)
    })
    await t.test('merge, reparent and nested unmerge keep vote and comment counts correct', async () => {
      const votes = await Promise.all([1, 2].map(() => request('/api/posts/' + first + '/vote', {}, { cookie, origin })))
      for (const response of votes) assert.equal((await ok(response)).voteCount, 1)
      for (const [id, voter] of [[first, userId], [second, userId], [second, other.userId], [third, other.userId]]) await pool.query('INSERT INTO vote(post_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, voter])
      await call('merge_feedback', { source_feedback_id: second, target_feedback_id: first })
      assert.equal((await call('get_feedback', { feedback_id: first })).vote_count, 2)
      await call('merge_feedback', { source_feedback_id: second, target_feedback_id: third })
      assert.equal((await call('get_feedback', { feedback_id: first })).vote_count, 1)
      assert.equal((await call('get_feedback', { feedback_id: first })).comment_count, 0)
      await call('merge_feedback', { source_feedback_id: third, target_feedback_id: first })
      const boardCounts = await ok(await request('/api/boards', undefined, { cookie }))
      assert.equal(boardCounts.data.find((item: { id: string }) => item.id === boardId).postCount, 1)
      assert.equal(boardCounts.totalPostCount, 1)
      const roadmap = await ok(await request('/api/roadmap', undefined, { cookie }))
      assert.equal(roadmap.planned.total, 1)
      await call('unmerge_feedback', { feedback_id: second })
      assert.equal((await call('get_feedback', { feedback_id: first })).vote_count, 2)
      await call('delete_feedback', { feedback_id: first }, 'INVALID_ARGUMENT')
      await call('unmerge_feedback', { feedback_id: third })
      await call('delete_board', { board_id: boardId })
      assert.equal((await call('get_feedback', { feedback_id: first })).board_id, null)
    })
    await t.test('merged comment previews cannot read another organization through metadata', async () => {
      const foreign = await call('create_feedback', { organization_id: otherOrg, title: 'Separate organization feedback', content: 'Separate organization body.' })
      contentIds.feedback.push(foreign.id)
      await call('create_feedback_comment', { organization_id: otherOrg, feedback_id: foreign.id, content: 'Separate organization reply.' })
      const recordId = uuidv7()
      await pool.query('INSERT INTO comment(id,post_id,author_id,content,type,metadata) VALUES($1,$2,$3,$4,$5,$6)', [recordId, first, userId, '', 'mergedPost', JSON.stringify({ merged_post_id: foreign.id })])
      try {
        const result = await ok(await request('/api/posts/' + first + '/comments?withChildren=true&sort=newest', undefined, { cookie }))
        const preview = result.data.find((item: { id: string }) => item.id === recordId)
        assert.equal(preview.mergedPost.post, null)
        assert.deepEqual(preview.mergedPost.comments.data, [])
      } finally { await pool.query('DELETE FROM comment WHERE id=$1', [recordId]) }
    })
    await t.test('help collection and article lifecycle, public visibility and AI Usage', async () => {
      const previousSettings = await call('get_portal_settings')
      assert.equal(previousSettings.help_center_enabled, true)
      assert.equal((await call('get_portal_settings', { organization_id: otherOrg })).help_center_enabled, false)
      await call('get_portal_settings', { organization_id: inaccessibleOrg }, 'FORBIDDEN')
      await call('update_portal_settings', { organization_id: otherOrg, help_center_enabled: true }, 'INVALID_ARGUMENT')
      const collection = await call('create_help_collection', { name: prefix + ' Docs', icon: 'book-open' })
      contentIds.collections.push(collection.id)
      const [{ metadata: previousMetadata }] = (await pool.query('SELECT metadata FROM organization WHERE id=$1', [org])).rows
      assert.equal((await call('update_portal_settings', { help_center_enabled: false })).help_center_enabled, false)
      assert.equal((await call('get_portal_settings')).help_center_enabled, false)
      await call('update_portal_settings', { help_center_enabled: true })
      const [{ metadata: restoredMetadata }] = (await pool.query('SELECT metadata FROM organization WHERE id=$1', [org])).rows
      assert.deepEqual(JSON.parse(restoredMetadata), JSON.parse(previousMetadata))
      await call('update_help_collection', { collection_id: collection.id, description: 'Integration documentation' })
      assert.ok((await call('list_help_collections')).items.some((x: { id: string }) => x.id === collection.id))
      const article = await call('create_help_article', { collection_id: collection.id, title: 'Integration guide', content: '# Setup\nOriginal body', ai_enabled: false })
      contentIds.articles.push(article.id)
      if (process.env.MCP_TEST_HELP_INDEX === 'true') {
        // MCP and Web must share the same committed indexing wake, not only the DB trigger.
        let attempts = 0
        for (let i = 0; i < 25 && attempts === 0; i++) {
          const { rows: [job] } = await pool.query("SELECT t.attempts FROM scheduled_task t JOIN help_article a ON a.id=t.ref_id WHERE t.kind='help_index' AND a.id=$1 AND a.org_id=$2", [article.id, org])
          assert.ok(job, 'MCP article creates its durable index job in the same transaction')
          attempts = job.attempts
          if (!attempts) await new Promise(resolve => setTimeout(resolve, 200))
        }
        assert.ok(attempts > 0, 'MCP afterCommit starts indexing without a periodic scan')
      }
      assert.equal(article.status, 'draft'); assert.equal(article.ai_enabled, false)
      const webCollections = await ok(await request('/api/admin/help/collections', undefined, { cookie }))
      assert.equal(webCollections.data.find((item: { id: string }) => item.id === collection.id).articleCount, 1)
      const webArticles = await ok(await request('/api/admin/help/articles', undefined, { cookie }))
      assert.equal(webArticles.data[0].id, article.id)
      assert.equal((await ok(await request('/api/admin/help/articles/' + article.id, undefined, { cookie }))).content, '# Setup\nOriginal body')
      assert.equal((await request('/api/help/articles/' + article.short_id)).status, 404)
      await call('get_help_article', { article_id: article.id, view: 'public' }, 'NOT_FOUND')
      await call('update_help_article', { article_id: article.id, content: '# Setup\nUpdated body' })
      assert.equal((await call('list_help_articles', { query: 'Updated body' })).items[0].id, article.id)
      await call('update_portal_settings', { help_center_enabled: false })
      const published = await call('publish_help_article', { article_id: article.id })
      assert.equal(published.status, 'published')
      assert.equal('publicly_visible' in published, false)
      assert.deepEqual(published.warnings, [{ code: 'HELP_CENTER_DISABLED', message: 'The article is published, but Help Center is disabled. Readers cannot access it.' }])
      assert.equal((await call('get_portal_settings')).help_center_enabled, false)
      const managementArticle = await call('get_help_article', { article_id: article.id })
      assert.equal(managementArticle.status, 'published')
      assert.equal('publicly_visible' in managementArticle, false)
      await call('get_help_article', { article_id: article.id, view: 'public' }, 'NOT_FOUND')
      await call('update_portal_settings', { help_center_enabled: true })
      assert.deepEqual((await call('publish_help_article', { article_id: article.id })).warnings, [])
      const webPublished = await ok(await request('/api/help/articles/' + article.short_id))
      assert.equal(webPublished.content, '# Setup\nUpdated body')
      assert.equal((await ok(await request('/api/help/collections'))).data[0].articleCount, 1)
      assert.equal((await ok(await request('/api/help/collections/' + collection.id))).articles[0].shortId, article.short_id)
      const publicArticle = await call('get_help_article', { article_id: article.id, view: 'public' })
      assert.equal(publicArticle.id, article.id)
      assert.equal('publicly_visible' in publicArticle, false)
      await call('update_help_collection', { collection_id: collection.id, visible: false })
      await call('get_help_article', { article_id: article.id, view: 'public' }, 'NOT_FOUND')
      assert.equal((await call('get_help_article', { article_id: article.id })).status, 'published')
      await call('unpublish_help_article', { article_id: article.id })
      assert.equal((await call('get_help_article', { article_id: article.id })).status, 'archived')
      await call('delete_help_article', { article_id: article.id })
      const containedArticle = await call('create_help_article', { collection_id: collection.id, title: 'Collection cleanup', content: 'Delete this article together with its collection.' })
      contentIds.articles.push(containedArticle.id)
      await call('delete_help_collection', { organization_id: otherOrg, collection_id: collection.id }, 'NOT_FOUND')
      const deleted = await call('delete_help_collection', { collection_id: collection.id })
      assert.equal(deleted.id, collection.id)
      assert.equal(deleted.deleted, true)
      await call('get_help_article', { article_id: containedArticle.id }, 'NOT_FOUND')
      assert.ok(!(await call('list_help_collections')).items.some((item: { id: string }) => item.id === collection.id))
    })
    await t.test('changelog drafts and published snapshots, scoped deletion', async () => {
      const changelog = await call('create_changelog', { title: prefix + ' Release', content: 'Original release notes.', categories: ['new'] })
      contentIds.changelogs.push(changelog.id)
      await call('publish_changelog', { changelog_id: changelog.id })
      await call('update_changelog', { changelog_id: changelog.id, content: 'Edited release notes.' })
      const edited = await call('get_changelog', { changelog_id: changelog.id })
      assert.equal(edited.status, 'needs_update'); assert.equal(edited.published_content, 'Original release notes.')
      assert.equal((await call('list_changelogs', { query: prefix })).items[0].id, changelog.id)
      const webList = await ok(await request('/api/admin/changelogs', undefined, { cookie }))
      assert.equal(webList.data[0].id, changelog.id)
      assert.equal((await ok(await request('/api/admin/changelogs/' + changelog.id, undefined, { cookie }))).content, 'Edited release notes.')
      assert.equal((await ok(await request('/api/changelogs/' + changelog.slug))).content, 'Original release notes.')
      assert.equal((await ok(await request('/api/changelogs'))).data[0].content, 'Original release notes.')
      await pool.query('INSERT INTO changelog_reaction(changelog_id,user_id,emoji) VALUES($1,$2,$3)', [changelog.id, userId, 'like'])
      await call('delete_changelog', { organization_id: otherOrg, changelog_id: changelog.id }, 'NOT_FOUND')
      assert.equal((await pool.query('SELECT * FROM changelog_reaction WHERE changelog_id=$1', [changelog.id])).rowCount, 1)
      await call('delete_changelog', { changelog_id: changelog.id })
    })
    await t.test('Web writes and MCP reads share business rules and response contracts', async () => {
      const web = (path: string, body?: unknown, method?: string) => request(path, body, { cookie, origin }, method)
      await pool.query('UPDATE member SET role=$1 WHERE user_id=$2 AND organization_id=$3', ['manager', userId, org])
      const board = await ok(await web('/api/admin/boards', { name: prefix + ' Web lifecycle' }), 201)
      contentIds.boards.push(board.id)
      await ok(await web('/api/admin/boards/' + board.id, { description: 'Updated on the Web' }, 'PATCH'))
      assert.equal((await call('list_boards')).items.find(item => item.id === board.id)!.description, 'Updated on the Web')
      const feedback = await ok(await web('/api/posts', { title: prefix + ' Web feedback', content: 'Original Web content.', boardId: board.id }), 201)
      contentIds.feedback.push(feedback.id)
      await ok(await web('/api/admin/posts/' + feedback.id, { status: 'done', content: 'Edited on the Web.' }, 'PATCH'))
      const detail = await call('get_feedback', { feedback_id: feedback.id })
      assert.equal(detail.content, 'Edited on the Web.')
      assert.equal(detail.status, 'done')
      assert.equal('content_hash' in detail, false)
      assert.equal('source_conversation_id' in detail, false)
      const comment = await ok(await web('/api/posts/' + feedback.id + '/comments', { content: 'Web reply.' }), 201)
      await ok(await web('/api/comments/' + comment.id, { content: 'Edited reply.' }, 'PATCH'))
      assert.equal((await call('list_feedback_comments', { feedback_id: feedback.id })).items[0]!.content, 'Edited reply.')
      await ok(await web('/api/comments/' + comment.id, undefined, 'DELETE'), 204)
      assert.equal((await call('get_feedback', { feedback_id: feedback.id })).comment_count, 0)
      await web('/api/admin/boards/' + board.id, undefined, 'DELETE').then(response => assert.equal(response.status, 204))
      assert.equal((await call('get_feedback', { feedback_id: feedback.id })).board_id, null)
      assert.ok((await call('list_feedback', { board_id: null })).items.some(item => item.id === feedback.id))
      const unassigned = await ok(await web('/api/admin/posts?boardId=none'))
      assert.ok(unassigned.data.some((item: { id: string }) => item.id === feedback.id))
      await web('/api/admin/posts/' + feedback.id, undefined, 'DELETE').then(response => assert.equal(response.status, 204))
      await call('get_feedback', { feedback_id: feedback.id }, 'NOT_FOUND')

      const collection = await ok(await web('/api/admin/help/collections', { name: prefix + ' Web docs', icon: 'book-open' }), 201)
      contentIds.collections.push(collection.id)
      const articles = []
      for (let index = 0; index < 3; index++) {
        const article = await ok(await web('/api/admin/help/articles', { collectionId: collection.id, title: prefix + ' Article ' + index, content: 'Article body.' }), 201)
        contentIds.articles.push(article.id); articles.push(article)
        await pool.query('UPDATE help_article SET created_at=$1,updated_at=$2 WHERE id=$3', ['2099-01-01T00:00:00.000' + (120 + index) + 'Z', '2099-01-02T00:00:00.000' + (123 - index) + 'Z', article.id])
      }
      await ok(await web('/api/admin/help/articles/' + articles[0].id, { status: 'published' }, 'PATCH'))
      assert.equal((await call('get_help_article', { article_id: articles[0].id })).status, 'published')
      for (const sort of ['created_asc', 'created_desc', 'updated_desc']) {
        const items: string[] = []; let cursor: string | null = null
        do {
          const page = await call('list_help_articles', { collection_id: collection.id, sort, limit: 1, ...(cursor ? { cursor } : {}) })
          items.push(...page.items.map(item => item.id)); cursor = page.next_cursor
        } while (cursor)
        assert.equal(new Set(items).size, 3)
        assert.deepEqual(items, (sort === 'created_asc' ? articles : sort === 'created_desc' ? [...articles].reverse() : [articles[1], articles[2], articles[0]]).map(item => item.id))
      }
      const listArticle = (await call('list_help_articles', { collection_id: collection.id })).items[0]!
      const getArticle = await call('get_help_article', { article_id: listArticle.id })
      assert.equal(listArticle.created_at, getArticle.created_at)
      assert.match(String(listArticle.created_at), /Z$/)
      assert.equal('tsv' in listArticle, false)
      assert.equal('content' in listArticle, false)
      const listPage = await call('list_help_articles', { collection_id: collection.id, sort: 'created_asc', limit: 1 })
      await call('list_help_articles', { collection_id: collection.id, sort: 'created_desc', limit: 1, cursor: listPage.next_cursor }, 'INVALID_CURSOR')
      await ok(await web('/api/admin/help/collections/' + collection.id, { visible: false }, 'PATCH'))
      await call('get_help_article', { article_id: articles[0].id, view: 'public' }, 'NOT_FOUND')
      assert.equal((await request('/api/help/articles/' + articles[0].shortId)).status, 404)
      await web('/api/admin/help/collections/' + collection.id, undefined, 'DELETE').then(response => assert.equal(response.status, 204))
      for (const article of articles) await call('get_help_article', { article_id: article.id }, 'NOT_FOUND')

      const release = await ok(await web('/api/admin/changelogs', { title: prefix + ' Web release', content: 'Public snapshot.', categories: ['new'] }), 201)
      contentIds.changelogs.push(release.id)
      await ok(await web('/api/admin/changelogs/' + release.id + '/publish', {}))
      await ok(await web('/api/admin/changelogs/' + release.id, { content: 'Pending edit.' }, 'PATCH'))
      const changelog = await call('get_changelog', { changelog_id: release.id })
      assert.equal(changelog.published_content, 'Public snapshot.')
      assert.equal(changelog.content, 'Pending edit.')
      const listed = (await call('list_changelogs')).items.find(item => item.id === release.id)!
      assert.equal(listed.updated_at, changelog.updated_at)
      assert.match(String(listed.updated_at), /Z$/)
      assert.equal('published_content' in listed, false)
      assert.equal((await ok(await request('/api/changelogs/' + release.slug))).content, 'Public snapshot.')
      await web('/api/admin/changelogs/' + release.id, undefined, 'DELETE').then(response => assert.equal(response.status, 204))
      await call('get_changelog', { changelog_id: release.id }, 'NOT_FOUND')
      await pool.query('UPDATE member SET role=$1 WHERE user_id=$2 AND organization_id=$3', ['owner', userId, org])
    })
    await t.test('live role changes and consent audit records', async () => {
      await pool.query('UPDATE member SET role=$1 WHERE user_id=$2 AND organization_id=$3', ['contributor', userId, org])
      await call('update_feedback', { feedback_id: first, title: prefix + ' Author edit' })
      await call('update_feedback', { feedback_id: first, status: 'done' }, 'FORBIDDEN')
      await call('create_board', { name: 'Not allowed' }, 'FORBIDDEN')
      assert.equal((await request('/api/admin/boards', { name: 'Not allowed' }, { cookie, origin })).status, 403)
      assert.equal((await request('/api/admin/posts', undefined, { cookie })).status, 200)
      assert.equal((await call('get_portal_settings')).help_center_enabled, true)
      await call('update_portal_settings', { help_center_enabled: false }, 'FORBIDDEN')
      await call('delete_help_collection', { collection_id: contentIds.collections[0] }, 'FORBIDDEN')
      await pool.query('UPDATE member SET role=$1 WHERE user_id=$2 AND organization_id=$3', ['owner', userId, org])
      for (const id of [first, second, third]) await call('delete_feedback', { feedback_id: id })
      const audit = await pool.query('SELECT operation,status,details FROM mcp_audit_log WHERE consent_id=$1', [consentId])
      assert.ok(audit.rows.some(row => row.operation === 'create_feedback' && row.status === 'success'))
      assert.ok(audit.rows.some(row => row.operation === 'create_board' && row.status === 'failure'))
      const listing = await ok(await request('/api/mcp/connections', undefined, { cookie }))
      assert.ok(listing.items.find((x: { id: string }) => x.id === consentId).lastUsedAt)
      assert.equal(seen.size, 36, 'Exercise every tool')
    })
    await t.test('a failed success audit preserves the committed business write and response', async () => {
      await pool.query("ALTER TABLE mcp_audit_log ADD CONSTRAINT mcp_test_rollback CHECK (operation <> 'create_board' OR status <> 'success') NOT VALID")
      try {
        const created = await call('create_board', { name: prefix + '-audit-failure' })
        contentIds.boards.push(created.id)
        assert.equal((await pool.query('SELECT id FROM board WHERE name=$1', [prefix + '-audit-failure'])).rowCount, 1)
        assert.equal((await pool.query("SELECT id FROM mcp_audit_log WHERE target_id=$1 AND status='failure'", [created.id])).rowCount, 0)
        assert.ok((await call('list_boards')).items.some(item => item.id === created.id))
      } finally { await pool.query('ALTER TABLE mcp_audit_log DROP CONSTRAINT mcp_test_rollback') }
    })
    await t.test('DPoP binding and proof replay are enforced with provider keys', async () => {
      const key = await generateKeyPair('ES256')
      const jwk = await exportJWK(key.publicKey)
      const proof = (url: string, accessToken?: string) => new SignJWT({ htu: url, htm: 'POST', jti: randomBytes(16).toString('hex'), ...(accessToken ? { ath: createHash('sha256').update(accessToken).digest('base64url') } : {}) })
        .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk }).setIssuedAt().sign(key.privateKey)
      const pending = await consent(await begin(registered.client_id), [org, otherOrg])
      const issued = await ok(await token({ grant_type: 'authorization_code', client_id: registered.client_id, code: pending.code, code_verifier: pending.verifier, redirect_uri: redirectUri, resource }, { DPoP: await proof(origin + '/api/auth/oauth2/token') }))
      assert.ok(decodeJwt(issued.access_token).cnf)
      assert.equal((await request('/api/mcp', {}, { authorization: 'Bearer ' + issued.access_token })).status, 401)
      const headers = { authorization: 'DPoP ' + issued.access_token, DPoP: await proof(resource, issued.access_token), accept: 'application/json, text/event-stream' }
      const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dpop-test', version: '1.0' } } }
      assert.equal((await request('/api/mcp', initialize, headers)).status, 200)
      assert.equal((await request('/api/mcp', initialize, headers)).status, 401)
    })
    await t.test('removing membership while adding its organization cannot leave a usable grant', async () => {
      const membershipId = uuidv7()
      await pool.query('INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,$4)', [membershipId, userId, inaccessibleOrg, 'contributor'])
      const connection = await pool.connect()
      try {
        await connection.query('BEGIN')
        await connection.query('DELETE FROM member WHERE id=$1', [membershipId])
        const change = request('/api/mcp/connections/' + consentId + '/organizations', { addOrganizationIds: [inaccessibleOrg], removeOrganizationIds: [otherOrg] }, { cookie, origin }, 'PATCH')
        for (let attempt = 0; attempt < 40; attempt++) {
          const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%member%'")
          if (waiting.rowCount) break
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        await connection.query('COMMIT')
        assert.equal((await change).status, 403)
        assert.equal((await pool.query('SELECT * FROM mcp_consent_organization WHERE member_id=$1', [membershipId])).rowCount, 0)
        assert.ok((await call('list_organizations')).organizations.some(item => item.id === otherOrg), 'A failed delta must not partially remove another organization')
      } finally { await connection.query('ROLLBACK'); connection.release() }
    })
    await t.test('organization deltas, administrator revocation, refresh and stale credentials', async () => {
      const otherGrant = await consent(await begin(registered.client_id, other.cookie), [org], true, other.cookie)
      const otherTokens = await ok(await exchange(registered.client_id, otherGrant))
      const otherConsentId = decodeJwt(otherTokens.access_token).mcp_consent_id as string
      assert.equal((await request('/api/mcp/connections/' + consentId + '/organizations', undefined, { cookie: other.cookie })).status, 403)
      const revoked = await ok(await request('/api/mcp/connections/' + otherConsentId + '/organizations/' + org, undefined, { cookie, origin }, 'DELETE'))
      assert.equal(revoked.disconnected, true)
      assert.equal((await request('/api/mcp', {}, { authorization: 'Bearer ' + otherTokens.access_token })).status, 401)
      const reconnectedOther = await ok(await exchange(registered.client_id, await consent(await begin(registered.client_id, other.cookie), [org], true, other.cookie)))
      const otherMembership = (await pool.query('SELECT id FROM member WHERE user_id=$1 AND organization_id=$2', [other.userId, org])).rows[0]
      await ok(await request('/api/auth/organization/remove-member', { organizationId: org, memberIdOrEmail: otherMembership.id }, { cookie, origin }))
      const removedConsent = decodeJwt(reconnectedOther.access_token).mcp_consent_id
      assert.equal((await pool.query('SELECT id FROM oauth_consent WHERE id=$1', [removedConsent])).rowCount, 0)
      assert.equal((await pool.query('SELECT * FROM mcp_consent_organization WHERE consent_id=$1', [removedConsent])).rowCount, 0)
      await pool.query('INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,$4)', [uuidv7(), other.userId, org, 'contributor'])
      assert.equal((await request('/api/mcp', {}, { authorization: 'Bearer ' + reconnectedOther.access_token })).status, 401)
      const pending = await begin(registered.client_id)
      assert.deepEqual([...pending.context.selectedOrganizationIds].sort(), [org, otherOrg].sort())
      await ok(await request('/api/mcp/connections/' + consentId + '/organizations', { removeOrganizationIds: [otherOrg] }, { cookie, origin }, 'PATCH'))
      assert.equal((await request('/api/mcp/consent', { authorizationRequestId: pending.context.authorizationRequestId, expectedUserId: userId, accept: true, organizationIds: [org, otherOrg] }, { cookie, origin })).status, 409)
      await call('list_boards', { organization_id: otherOrg }, 'FORBIDDEN')
      await ok(await request('/api/mcp/connections/' + consentId + '/organizations', { addOrganizationIds: [otherOrg] }, { cookie, origin }, 'PATCH'))
      const refresh = await ok(await token({ grant_type: 'refresh_token', client_id: registered.client_id, refresh_token: tokens.refresh_token, resource }))
      assert.ok(refresh.refresh_token)
      const staleCode = await consent(await begin(registered.client_id), [org, otherOrg])
      assert.equal((await request('/api/mcp/connections/' + consentId, undefined, { cookie, origin }, 'DELETE')).status, 204)
      assert.equal((await request('/api/mcp', {}, { authorization: 'Bearer ' + tokens.access_token })).status, 401)
      assert.notEqual((await token({ grant_type: 'refresh_token', client_id: registered.client_id, refresh_token: tokens.refresh_token, resource })).status, 200)
      const renewed = await ok(await exchange(registered.client_id, await consent(await begin(registered.client_id), [org])))
      assert.notEqual(decodeJwt(renewed.access_token).mcp_consent_id, consentId)
      assert.notEqual((await exchange(registered.client_id, staleCode)).status, 200)
      assert.equal((await request('/api/mcp', {}, { authorization: 'Bearer ' + refresh.access_token })).status, 401)
      const membership = (await pool.query('SELECT id FROM member WHERE user_id=$1 AND organization_id=$2', [userId, org])).rows[0]
      await pool.query('DELETE FROM member WHERE id=$1', [membership.id])
      await pool.query('INSERT INTO member(id,user_id,organization_id,role) VALUES($1,$2,$3,$4)', [uuidv7(), userId, org, 'owner'])
      assert.equal((await request('/api/mcp', {}, { authorization: 'Bearer ' + renewed.access_token })).status, 401, 'Rejoining must not restore old access')
      const expiredConnection = decodeJwt(renewed.access_token).mcp_consent_id as string
      assert.equal((await request('/api/mcp/connections/' + expiredConnection + '/organizations', { addOrganizationIds: [org] }, { cookie, origin }, 'PATCH')).status, 404, 'Adding organizations cannot revive a connection with no valid memberships')
    })
    await t.test('401 scopes guide refresh authorization without making offline access a tool permission', async () => {
      const challenge = await request('/api/mcp', {})
      assert.equal(challenge.status, 401)
      const scope = /\bscope="([^"]+)"/.exec(challenge.headers.get('www-authenticate')!)?.[1]
      assert.ok(scope)
      assert.equal(scope, 'mcp:access offline_access')

      const accessOnlyClient = await register()
      const accessOnlyGrant = await consent(await begin(accessOnlyClient.client_id, cookie, 'mcp:access'), [org])
      const accessOnly = await ok(await exchange(accessOnlyClient.client_id, accessOnlyGrant))
      assert.equal(accessOnly.refresh_token, undefined)
      const accessOnlySdk = await connect(accessOnly.access_token)
      try {
        const result = await accessOnlySdk.callTool({ name: 'list_organizations', arguments: {} })
        assert.equal(result.isError, undefined)
        assert.deepEqual((result.structuredContent as ToolData).organizations.map(item => item.id), [org])
      } finally { await accessOnlySdk.close() }

      const refreshClient = await register()
      const refreshGrant = await consent(await begin(refreshClient.client_id, cookie, scope), [org])
      const policy = (await pool.query('SELECT access_token_ttl FROM oauth_resource WHERE identifier=$1', [resource])).rows[0]
      assert.ok(policy)
      let expiring: { access_token: string; refresh_token: string }
      try {
        await pool.query('UPDATE oauth_resource SET access_token_ttl=1 WHERE identifier=$1', [resource])
        expiring = await ok(await exchange(refreshClient.client_id, refreshGrant))
      } finally {
        await pool.query('UPDATE oauth_resource SET access_token_ttl=$1 WHERE identifier=$2', [policy.access_token_ttl, resource])
      }
      assert.ok(expiring.refresh_token)
      const claims = decodeJwt(expiring.access_token)
      assert.equal(claims.exp! - claims.iat!, 1)
      await new Promise(resolve => setTimeout(resolve, 1500))
      const expired = await request('/api/mcp', {}, { authorization: 'Bearer ' + expiring.access_token })
      assert.equal(expired.status, 401)
      assert.match(expired.headers.get('www-authenticate')!, /scope="mcp:access offline_access"/)
      const renewed = await ok(await token({ grant_type: 'refresh_token', client_id: refreshClient.client_id, refresh_token: expiring.refresh_token, resource }))
      assert.ok(renewed.refresh_token)
      assert.notEqual(renewed.refresh_token, expiring.refresh_token)
      const refreshedSdk = await connect(renewed.access_token)
      try {
        const result = await refreshedSdk.callTool({ name: 'list_organizations', arguments: {} })
        assert.equal(result.isError, undefined)
        assert.deepEqual((result.structuredContent as ToolData).organizations.map(item => item.id), [org])
      } finally { await refreshedSdk.close() }
    })
    await t.test('SSO and anonymous users cannot authorize MCP', async () => {
      const secret = randomBytes(32).toString('hex')
      await pool.query('INSERT INTO organization_sso(id,org_id,secret,label) VALUES($1,$2,$3,$4)', [prefix, org, secret, prefix])
      const jwt = await new SignJWT({ email: prefix + '-owner@example.invalid', name: prefix + '-owner' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(secret))
      const response = await request('/api/sso/jwt?' + new URLSearchParams({ jwt, return_to: '/' }))
      const ssoCookie = response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ')
      assert.equal((await request('/api/auth/oauth2/authorize', undefined, { cookie: ssoCookie })).status, 403)
      assert.equal((await request('/api/mcp/connections', undefined, { cookie: ssoCookie })).status, 403)
      await pool.query('DELETE FROM organization_sso WHERE id=$1', [prefix])
      const anonymous = await request('/api/auth/sign-in/anonymous', {}, { origin })
      const guest = await ok(anonymous)
      userIds.push(guest.user.id)
      const guestCookie = anonymous.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      assert.equal((await request('/api/auth/oauth2/authorize', undefined, { cookie: guestCookie })).status, 403)
      assert.equal((await request('/api/mcp/connections', undefined, { cookie: guestCookie })).status, 403)
    })
    await t.test('deleting an account cleans grants and retains attributed audit history', async () => {
      const issued = await ok(await exchange(registered.client_id, await consent(await begin(registered.client_id, other.cookie), [org], true, other.cookie)))
      const removed = decodeJwt(issued.access_token).mcp_consent_id as string
      await pool.query('UPDATE "user" SET role=$1 WHERE id=$2', ['admin', userId])
      const login = await request('/api/auth/sign-in/email', { email: prefix + '-owner@example.invalid', password }, { origin })
      await ok(login)
      cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      await ok(await request('/api/auth/admin/remove-user', { userId: other.userId }, { cookie, origin }))
      assert.equal((await pool.query('SELECT * FROM mcp_consent_organization WHERE consent_id=$1', [removed])).rowCount, 0)
      assert.equal((await request('/api/mcp', {}, { authorization: 'Bearer ' + issued.access_token })).status, 401)
      const audit = await pool.query("SELECT actor_user_id FROM mcp_audit_log WHERE consent_id=$1 AND operation='authorization.revoke'", [removed])
      assert.equal(audit.rows[0]?.actor_user_id, userId)
    })
  } finally {
    await sdk?.close().catch(() => {})
    await pool.query('DELETE FROM mcp_audit_log WHERE actor_user_id = ANY($1::text[])', [userIds])
    await pool.query('DELETE FROM verification WHERE identifier=$1', [prefix + '-plain-verification'])
    await pool.query('DELETE FROM mcp_consent_organization WHERE consent_id IN (SELECT id FROM oauth_consent WHERE user_id = ANY($1::text[]))', [userIds])
    await pool.query('DELETE FROM oauth_client WHERE client_id = ANY($1::text[])', [clientIds])
    for (const id of contentIds.feedback) {
      await pool.query('DELETE FROM comment_like WHERE comment_id IN (SELECT id FROM comment WHERE post_id=$1)', [id])
      for (const table of ['comment', 'vote', 'post_subscription', 'post_unread']) await pool.query('DELETE FROM ' + table + ' WHERE post_id=$1', [id])
      await pool.query('DELETE FROM post WHERE id=$1', [id])
    }
    await pool.query('DELETE FROM changelog_reaction WHERE changelog_id = ANY($1::uuid[])', [contentIds.changelogs])
    for (const [table, ids] of [['changelog', contentIds.changelogs], ['help_article', contentIds.articles], ['help_collection', contentIds.collections], ['board', contentIds.boards]] as const) await pool.query('DELETE FROM ' + table + ' WHERE id = ANY($1::uuid[])', [ids])
    await pool.query('DELETE FROM verification WHERE identifier LIKE $1 AND value::jsonb->>\'userId\' = ANY($2::text[])', ['mcp-request:%', userIds])
    await pool.query('DELETE FROM organization_sso WHERE id=$1', [prefix])
    await pool.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [userIds])
    await pool.query('DELETE FROM organization WHERE id = ANY($1::text[])', [[otherOrg, inaccessibleOrg, ...(tenantHost ? [org] : [])]])
    await pool.end()
  }
})

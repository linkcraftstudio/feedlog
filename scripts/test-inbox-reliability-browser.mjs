import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { Pool } from 'pg'

const base = process.env.INBOX_TEST_BASE || 'http://127.0.0.1:3168'
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname))
assert.match(process.env.DATABASE_URL || '', /@(?:localhost|127\.0\.0\.1):\d+\/feedlog_inbox_mvp$/)
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH })
const context = await browser.newContext()
const page = await context.newPage()
const failures = []
page.on('pageerror', error => failures.push(error.message))
const credentials = { email: `contributor-${Date.now()}@example.invalid`, password: 'LocalTestPassword123!' }
let userId
try {
  const signup = await context.request.post(`${base}/api/auth/sign-up/email`, { data: { ...credentials, name: 'Inbox contributor' }, headers: { origin: base } })
  assert.equal(signup.status(), 200)
  userId = (await signup.json()).user.id
  await pool.query("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ($1,'default-org',$1,'contributor',now())", [userId])
  await context.request.post(`${base}/api/auth/sign-out`, { headers: { origin: base } })
  const signin = await context.request.post(`${base}/api/auth/sign-in/email`, { data: credentials, headers: { origin: base } })
  assert.equal(signin.status(), 200)
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForURL(/\/dashboard\/inbox$/, { timeout: 120000 })
  await page.waitForFunction(() => !!document.querySelector('#__nuxt')?.__vue_app__)
  assert.equal((await context.request.get(`${base}/api/admin/inbox/summary`)).status(), 200)
  assert.equal((await context.request.get(`${base}/api/admin/widget`)).status(), 403)
  console.log('PASS contributor Inbox entry and API permission isolation')
  const widgetLink = page.locator('a[href$="/dashboard/settings/widget"]').filter({ visible: true }).first()
  await widgetLink.click({ force: true })
  assert.match(page.url(), /\/dashboard\/inbox$/)
  await page.locator('[data-sonner-toast]').filter({ hasText: /permission|access|权限/i }).first().waitFor()
  await page.locator('[data-sonner-toast]').first().evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)))
  await page.screenshot({ path: '/tmp/inbox-fix-permission-toast.png' })
  console.log('PASS forbidden navigation stays on the current page and shows the existing toast UI')
  await page.goto(`${base}/dashboard/settings/widget`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  assert.match(page.url(), /\/dashboard\/inbox$/)
  console.log('PASS forbidden direct URL redirects to the first accessible page')
  const upload = await context.request.post(`${base}/api/upload`, { multipart: { file: {
    name: 'original.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
  } } })
  assert.equal(upload.status(), 200)
  const uploadedKey = (await upload.json()).key
  const rejectedId = crypto.randomUUID()
  const rejected = await context.request.post(`${base}/api/widget/conversations/${rejectedId}/chat`, {
    data: { action: 'send', idempotency_key: crypto.randomUUID(), message: { id: crypto.randomUUID(), content: { parts: [{ type: 'image', storage_key: uploadedKey }] }, context: null } },
  })
  assert.equal(rejected.status(), 422)
  assert.equal((await rejected.json()).data.code, 'image_unsupported')
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_run WHERE conversation_id=$1', [rejectedId])).rows[0].n, 0)
  console.log('PASS raw SVG bypass is rejected before a message or AI run is saved')
  const conversationId = crypto.randomUUID()
  const sent = await context.request.post(`${base}/api/widget/conversations/${conversationId}/chat`, {
    data: { action: 'send', idempotency_key: crypto.randomUUID(), message: { id: crypto.randomUUID(), content: { parts: [{ type: 'text', text: 'Local unavailable-AI test' }] }, context: null } },
  })
  assert.equal(sent.status(), 200)
  const events = await sent.text()
  assert.match(events, /event: handoff/)
  assert.match(events, /"reason":"ai_error"/)
  const history = await (await context.request.get(`${base}/api/widget/conversations/${conversationId}/items`)).json()
  assert.equal(history.conversation.handling, 'human')
  assert.equal(history.items.some(item => item.authorType === 'agent'), false)
  assert.equal(history.items.some(item => item.notice || item.authorType === 'system'), false)
  console.log('PASS unavailable AI saves the message, silently transfers to human support and produces no AI reply')
  assert.equal((await context.request.get(`${base}/api/admin/inbox/conversations/${conversationId}`)).status(), 200)
  assert.equal((await context.request.get(`${base}/api/admin/posts?sourceConversationId=${conversationId}`)).status(), 200)
  const staffReply = await context.request.post(`${base}/api/admin/inbox/conversations/${conversationId}/replies`, {
    data: { requestId: crypto.randomUUID(), expectedLastSeq: history.conversation.lastSeq,
      content: { parts: [{ type: 'text', text: 'Local contributor reply' }] }, notifyByEmail: false },
  })
  assert.equal(staffReply.status(), 201)
  console.log('PASS contributor can open Inbox details, read linked feedback and reply')


  const imageResults = await page.evaluate(async () => {
    const { prepareChatImage } = await import('/_nuxt/utils/chat-image.ts')
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 6000 3000"><script>window.svgExecuted=true</script><rect width="6000" height="3000" fill="red"/></svg>'], 'large.svg', { type: 'image/svg+xml' })
    const result = await prepareChatImage(svg)
    const bitmap = await createImageBitmap(result)
    const info = { type: result.type, size: result.size, width: bitmap.width, height: bitmap.height, executed: window.svgExecuted === true }
    bitmap.close()
    const canvas = document.createElement('canvas'); canvas.width = 5000; canvas.height = 2400
    const c = canvas.getContext('2d'); c.fillStyle = '#5f8899'; c.fillRect(0,0,5000,2400)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    const compressed = await prepareChatImage(new File([blob], 'screenshot.png', { type: 'image/png' }))
    const resized = await createImageBitmap(compressed)
    const original = new File([compressed], 'small.png', { type: compressed.type })
    const unchanged = await prepareChatImage(original) === original
    let invalid
    try { await prepareChatImage(new File(['invalid'], 'broken.png', {type:'image/png'})) } catch (error) { invalid = error.code }
    return { svg: info, raster: { size: compressed.size, width: resized.width, height: resized.height }, unchanged, invalid }
  })
  assert.equal(imageResults.svg.executed, false)
  assert.equal(imageResults.svg.type, 'image/png')
  assert.equal(imageResults.svg.width, 4096)
  assert.equal(imageResults.raster.width, 4096)
  assert.ok(imageResults.raster.size <= 4 * 1024 * 1024)
  assert.equal(imageResults.unchanged, true)
  assert.equal(imageResults.invalid, 'image_unsupported')
  console.log('PASS SVG rasterization, safe rendering, oversized screenshot resizing and corrupt image feedback')
  if (process.env.HEIC_TEST_FILE) {
    const bytes = [...await readFile(process.env.HEIC_TEST_FILE)]
    const converted = await page.evaluate(async bytes => {
      const { prepareChatImage } = await import('/_nuxt/utils/chat-image.ts')
      const file = await prepareChatImage(new File([new Uint8Array(bytes)], 'photo.heic', { type: 'image/heic' }))
      const bitmap = await createImageBitmap(file)
      return { type: file.type, size: file.size, width: bitmap.width, height: bitmap.height }
    }, bytes)
    assert.ok(['image/png', 'image/jpeg'].includes(converted.type))
    assert.ok(converted.size <= 4 * 1024 * 1024)
    assert.ok(converted.width > 0)
    console.log('PASS real HEIC conversion in a browser worker', converted)
  }
  assert.deepEqual(failures, [])
} finally {
  await browser.close()
  if (userId) {
    await pool.query(`DELETE FROM scheduled_task WHERE ref_id IN (SELECT id FROM conversation WHERE user_id=$1)
      OR ref_id IN (SELECT r.id FROM agent_run r JOIN conversation c ON c.id=r.conversation_id WHERE c.user_id=$1)`, [userId])
    await pool.query("DELETE FROM conversation_item WHERE author_type='agent' AND conversation_id IN (SELECT id FROM conversation WHERE user_id=$1)", [userId])
    await pool.query('DELETE FROM agent_run WHERE conversation_id IN (SELECT id FROM conversation WHERE user_id=$1)', [userId])
    await pool.query('DELETE FROM conversation_item WHERE conversation_id IN (SELECT id FROM conversation WHERE user_id=$1)', [userId])
    await pool.query('DELETE FROM conversation WHERE user_id=$1', [userId])
    await pool.query('DELETE FROM "user" WHERE id=$1', [userId])
  }
  await pool.end()
}

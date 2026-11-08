import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp, defineEventHandler, setResponseHeader, toWebHandler, type H3Event } from 'h3'

Object.assign(globalThis, {
  defineEventHandler,
  setResponseHeader,
  useRuntimeConfig: (event: H3Event) => ({ public: { i18n: event.context.testI18n } }),
})
const { default: frameAncestors } = await import('../server/middleware/01-frame-ancestors')

function createRequest(locales?: Array<string | { code: string }>) {
  const app = createApp()
  app.use(defineEventHandler((event) => {
    event.context.testI18n = locales ? { locales } : undefined
  }))
  app.use(frameAncestors)
  app.use(defineEventHandler(() => 'test page'))
  return toWebHandler(app)
}

test('default and Chinese widget pages share the embedding policy, including queries and descendants', async () => {
  const request = createRequest([{ code: 'en' }, { code: 'zh' }])
  for (const path of [
    '/widget/embed', '/widget/embed/', '/widget/embed/conversations',
    '/widget/embed?theme=dark&origin=http%3A%2F%2Flocalhost%3A15173',
    '/zh/widget/embed', '/zh/widget/embed/', '/zh/widget/embed/conversations',
    '/zh/widget/embed?theme=dark&origin=http%3A%2F%2Flocalhost%3A15173',
  ]) {
    const response = await request(new Request(`https://feedback.example.com${path}`))
    assert.equal(response.status, 200, path)
    assert.equal(response.headers.get('content-security-policy'), 'frame-ancestors *', path)
  }
})

test('locale prefixes follow the configured locales rather than a hardcoded language or wildcard', async () => {
  const request = createRequest(['en', { code: 'fr' }, { code: 'pt-BR' }])
  for (const path of ['/fr/widget/embed', '/pt-BR/widget/embed']) {
    const response = await request(new Request(`https://feedback.example.com${path}`))
    assert.equal(response.headers.get('content-security-policy'), 'frame-ancestors *', path)
  }
  for (const path of ['/zh/widget/embed', '/unknown/widget/embed']) {
    const response = await request(new Request(`https://feedback.example.com${path}`))
    assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'", path)
  }
})

test('ordinary pages and paths that only resemble widget routes remain protected', async () => {
  const request = createRequest(['en', 'zh'])
  for (const path of [
    '/', '/dashboard', '/login', '/zh', '/zh/dashboard', '/zh/login',
    '/widget', '/zh/widget', '/widget/embed-other', '/zh/widget/embed-other',
    '/dashboard/widget/embed', '/zh/dashboard/widget/embed', '/other/zh/widget/embed',
    '/zh//widget/embed', '/zh/zh/widget/embed', '/zh/api/widget/config',
    '/login?next=/zh/widget/embed',
  ]) {
    const response = await request(new Request(`https://feedback.example.com${path}`))
    assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'", path)
  }
})

test('API response headers are left to their existing handlers', async () => {
  const request = createRequest(['en', 'zh'])
  for (const path of ['/api/widget/config', '/api/auth/get-session']) {
    const response = await request(new Request(`https://feedback.example.com${path}`))
    assert.equal(response.headers.get('content-security-policy'), null, path)
  }
})

test('missing locale configuration preserves the default widget policy without allowing arbitrary prefixes', async () => {
  const request = createRequest()
  for (const [path, policy] of [
    ['/widget/embed', 'frame-ancestors *'],
    ['/zh/widget/embed', "frame-ancestors 'none'"],
    ['/dashboard', "frame-ancestors 'none'"],
  ]) {
    const response = await request(new Request(`https://feedback.example.com${path}`))
    assert.equal(response.headers.get('content-security-policy'), policy, path)
  }
})

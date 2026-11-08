import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { test } from 'node:test'

const target = process.env.SEO_TEST_URL

test('SEO: sitemap and response indexing policies', { skip: !target, timeout: 60_000 }, async t => {
  const origin = new URL(target!)
  assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname))
  const tenant = process.env.SEO_TEST_TENANT_HOST

  async function request(path: string) {
    return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      const req = httpRequest(new URL(path, origin), { headers: tenant ? { host: tenant } : {}, timeout: 10_000 }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }))
      })
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error('SEO request timed out')))
      req.end()
    })
  }

  const functional = ['/dashboard', '/dashboard/settings/personal', '/auth/callback', '/invite', '/reset-password', '/verified', '/mcp/connect', '/mcp/consent', '/sso/error', '/setup', '/widget/embed']
  functional.push(...JSON.parse(process.env.SEO_TEST_EXTRA_FUNCTIONAL_ROUTES ?? '[]') as string[])
  const publicPages = ['/', '/roadmap', '/changelog', '/help']
  const localized = (path: string, prefix: string) => prefix ? `${prefix}${path === '/' ? '' : path}` : path

  await t.test('both language sitemaps keep public pages and omit functional pages', async () => {
    const index = await request('/sitemap_index.xml')
    assert.equal(index.status, 200)
    const maps = [...index.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => new URL(match[1]!).pathname)
    assert.equal(maps.length, 2)
    const paths = new Set<string>()
    for (const map of maps) {
      const response = await request(map)
      assert.equal(response.status, 200, map)
      for (const match of response.body.matchAll(/<loc>([^<]+)<\/loc>/g)) paths.add(new URL(match[1]!).pathname.replace(/\/$/, '') || '/')
    }
    for (const prefix of ['', '/zh']) {
      for (const path of publicPages) assert.ok(paths.has(localized(path, prefix)), `Missing public page: ${prefix}${path}`)
    }
    for (const path of paths) {
      const unprefixed = path.replace(/^\/zh(?=\/|$)/, '') || '/'
      assert.ok(!/^\/(dashboard|auth|mcp|sso|widget)(\/|$)/.test(unprefixed), path)
      assert.ok(!functional.some(blocked => unprefixed === blocked || unprefixed.startsWith(`${blocked}/`)), path)
    }
  })

  await t.test('functional responses carry noindex in both languages, including redirects and client-rendered widgets', async () => {
    for (const prefix of ['', '/zh']) {
      for (const path of functional) {
        const route = localized(path, prefix)
        const response = await request(route)
        assert.ok(response.status < 500, `${route}: ${response.status}`)
        assert.match(String(response.headers['x-robots-tag']), /\bnoindex\b/, route)
        if (path === '/widget/embed') {
          assert.equal(response.status, 200)
          assert.match(String(response.headers['cache-control']), /max-age=300/)
        }
      }
    }
  })

  await t.test('public responses remain indexable and robots.txt allows crawling functional pages', async () => {
    for (const prefix of ['', '/zh']) {
      for (const path of publicPages) {
        const route = localized(path, prefix)
        const response = await request(route)
        assert.equal(response.status, 200, route)
        assert.doesNotMatch(String(response.headers['x-robots-tag']), /\bnoindex\b/, route)
      }
    }
    const robots = await request('/robots.txt')
    assert.equal(robots.status, 200)
    assert.doesNotMatch(robots.body, /Disallow:\s*\/(?:zh\/)?(?:dashboard|auth|mcp|sso|widget|reset-password|invite)(?:[/*\s]|$)/i)
  })
})

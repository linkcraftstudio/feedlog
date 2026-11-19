import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discoverWebSourcePages } from '../server/lib/web-source/discovery'
import { inspectWebSourcePage } from '../server/lib/web-source/content'
import { processWebSourcePage } from '../server/lib/web-source/page'
import type { CrawlResponse } from '../server/lib/web-source/fetch'

const origin = 'https://example.com'
const response = (url: string, body = '', status = 200): CrawlResponse => ({ url, body, status, headers: { 'content-type': 'text/html' } })
const input = { url: origin, excludes: '', pageLimit: 200 }

test('usable sitemap returns candidates without fetching pages, hydration assets or rendering', async () => {
  const requested: string[] = []
  const found = await discoverWebSourcePages(input, async url => {
    requested.push(url)
    if (url.endsWith('robots.txt')) return response(url, `Sitemap: ${origin}/sitemap.xml`)
    if (url.endsWith('sitemap.xml')) return response(url, `<urlset><url><loc>${origin}/guide</loc></url></urlset>`)
    assert.equal(url, origin)
    return response(url, '<div id="app"></div><script src="/app.js"></script>')
  })
  assert.deepEqual(found.pages, [{ url: origin + '/guide', title: '' }])
  assert.equal(requested.length, 2)
  assert.ok(!requested.includes(origin), 'a usable sitemap must not wait for the homepage')
  assert.equal(found.limited, false)
})

test('fallback discovers navigation links from a JS shell without extracting its body', async () => {
  const found = await discoverWebSourcePages(input, async url => {
    if (url.endsWith('robots.txt')) return response(url)
    if (url.endsWith('sitemap.xml')) return response(url, '', 404)
    return response(url, '<html><title>Example</title><body><nav><a href="/guide">Guide</a><a href="https://elsewhere.com">Other</a></nav><div id="app"></div><script src="/app.js"></script></body></html>')
  })
  assert.deepEqual(found.pages.map(page => page.url).sort(), [origin, origin + '/guide'])
})

test('nested sitemap requests are concurrent, globally capped at four and not truncated at eight requests', async () => {
  let active = 0, peak = 0, requests = 0
  const xml = (paths: string[], index = false) => index
    ? `<sitemapindex>${paths.map(path => `<sitemap><loc>${origin}${path}</loc></sitemap>`).join('')}</sitemapindex>`
    : `<urlset>${paths.map(path => `<url><loc>${origin}${path}</loc></url>`).join('')}</urlset>`
  const found = await discoverWebSourcePages(input, async url => {
    requests++; active++; peak = Math.max(peak, active)
    try {
      await new Promise(resolve => setTimeout(resolve, 15))
      if (url.endsWith('robots.txt')) return response(url, `Sitemap: ${origin}/sitemap.xml`)
      if (url.endsWith('/sitemap.xml')) return response(url, xml(['/a.xml', '/b.xml', '/c.xml', '/d.xml'], true))
      if (url.endsWith('/a.xml')) return response(url, xml(['/a1.xml', '/a2.xml'], true))
      if (url.endsWith('.xml')) return response(url, xml(['/' + url.split('/').pop()!.replace('.xml', '')]))
      return response(url, '<h1>Example</h1>')
    } finally { active-- }
  })
  assert.equal(peak, 4)
  assert.equal(requests, 8)
  assert.ok(found.pages.length >= 3)
  assert.equal(found.limited, false)
})

test('one broken sitemap does not discard candidates from another sitemap', async () => {
  const found = await discoverWebSourcePages(input, async url => {
    if (url.endsWith('robots.txt')) return response(url, `Sitemap: ${origin}/broken.xml\nSitemap: ${origin}/valid.xml`)
    if (url.endsWith('broken.xml')) return response(url, '', 500)
    if (url.endsWith('valid.xml')) return response(url, `<urlset><url><loc>${origin}/guide</loc></url></urlset>`)
    return response(url, '<h1>Example</h1>')
  })
  assert.deepEqual(found.pages.map(page => page.url), [origin + '/guide'])
})

test('an empty interactive mount beside published HTML does not require a browser', async () => {
  const html = '<html><head><title>AI Vector</title></head><body><div id="app"></div><script src="/app.js"></script><main><h1>Convert images</h1><p>Convert PNG to SVG using the published image conversion tool. Downloads retain vector paths and can be used in supported design applications.</p></main></body></html>'
  assert.equal(inspectWebSourcePage(html, origin).needsBrowser, false)
  const page = await processWebSourcePage(response(origin, html), { })
  assert.equal(page.fetchMode, 'http')
  assert.ok(page.content.content.includes('Downloads retain vector paths'))
  assert.equal(inspectWebSourcePage('<html><body><div id="app"></div><script src="/app.js"></script></body></html>', origin).needsBrowser, true)
})

test('a locale redirect never narrows a root website to just its default language', async () => {
  const requested: string[] = []
  const found = await discoverWebSourcePages(input, async url => {
    requested.push(url)
    if (url.endsWith('robots.txt')) return response(url)
    if (url.endsWith('sitemap.xml')) return response(url, `<urlset><url><loc>${origin}/</loc></url><url><loc>${origin}/cn/</loc></url><url><loc>${origin}/ai-vector-generator</loc></url><url><loc>${origin}/cn/ai-vector-generator</loc></url></urlset>`)
    throw Error('Do not fetch the homepage when a sitemap is available')
  })
  assert.equal(found.url, origin)
  assert.deepEqual(found.pages.map(page => page.url).sort(), [origin, origin + '/cn/', origin + '/ai-vector-generator', origin + '/cn/ai-vector-generator'].sort())
  assert.equal(requested.length, 2)
})

test('HTML fallback keeps all languages when the root redirects to a locale homepage', async () => {
  const found = await discoverWebSourcePages(input, async url => {
    if (url.endsWith('robots.txt')) return response(url)
    if (url.endsWith('sitemap.xml')) return response(url, '', 404)
    return response(url === origin ? origin + '/en' : url, '<html><title>Product</title><body><a href="/cn">Chinese</a><a href="/en/pricing">Pricing</a><a href="/cn/pricing">中文价格</a></body></html>')
  })
  assert.equal(found.url, origin)
  for (const path of ['/en', '/cn', '/en/pricing', '/cn/pricing']) assert.ok(found.pages.some(page => page.url === origin + path), path)
})

test('sitemap discovery returns partial candidates explicitly at the larger request budget', async () => {
  let requests = 0
  const found = await discoverWebSourcePages(input, async url => {
    requests++
    if (url.endsWith('robots.txt')) return response(url)
    if (url.endsWith('sitemap.xml')) return response(url, `<sitemapindex>${Array.from({ length: 40 }, (_, i) => `<sitemap><loc>${origin}/${i}.xml</loc></sitemap>`).join('')}</sitemapindex>`)
    return response(url, `<urlset><url><loc>${url.replace('.xml', '')}</loc></url></urlset>`)
  })
  assert.equal(requests, 32)
  assert.equal(found.pages.length, 30)
  assert.equal(found.limited, true)
})

test('disallowed entry pages and redirect targets are never fetched during discovery', async () => {
  for (const redirect of [false, true]) {
    const requested: string[] = []
    await assert.rejects(discoverWebSourcePages({ ...input, url: origin + (redirect ? '/start' : '/blocked') }, async url => {
      requested.push(url)
      if (url.endsWith('/robots.txt')) return response(url, 'User-agent: *\nDisallow: /blocked')
      if (url.endsWith('/start')) return { ...response(url, '', 302), headers: { location: '/blocked' } }
      throw new Error('Forbidden page must not be fetched')
    }), /robots_disallowed/)
    assert.ok(!requested.includes(origin + '/blocked'))
  }
})

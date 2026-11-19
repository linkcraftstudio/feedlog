import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeWebsiteData } from '../server/lib/web-source/data-decoder'
import { collectWebsiteData, collectWebsitePageData, appendWebsiteData, type WebsitePageData } from '../server/lib/web-source/page-data'
import { selectWebsitePageData } from '../server/lib/web-source/data-selection'
import { processWebSourcePage } from '../server/lib/web-source/page'
import type { CrawlResponse } from '../server/lib/web-source/fetch'

const url = 'https://example.com/guide'
const html = (body: string): CrawlResponse => ({ url, status: 200, headers: { 'content-type': 'text/html' }, body })
const body = '<main><h1>Account guide</h1><p>Manage account email addresses and update your password in the dashboard settings.</p></main>'
const script = (value: unknown) => `<script type="application/json" id="__NEXT_DATA__">${JSON.stringify(value)}</script>`

test('data decoder reads Nuxt IIFE aliases without executing code', () => {
  const value = decodeWebsiteData('__NUXT_JSONP__("/guide",(function(a,b){return {data:[{text:a,disabled:b,amount:-12}],missing:void 0}})("真实正文",!1))') as Record<string, unknown>
  assert.equal(JSON.stringify(value), '{"data":[{"text":"真实正文","disabled":false,"amount":-12}]}')
  assert.equal(JSON.stringify(decodeWebsiteData('window.__NUXT__={text:"Public documentation"}')), '{"text":"Public documentation"}')
})

test('data decoder rejects executable expressions and prototype mutations', () => {
  for (const source of [
    'evil("/",{text:"payload"})', 'window.other={text:"payload"}',
    '__NUXT_JSONP__("/",fetch("https://example.com"))',
    '__NUXT_JSONP__("/",(function(){while(true){} return {}})())',
    '__NUXT_JSONP__("/",{get text(){return "invisible"}})',
    '__NUXT_JSONP__("/",{["computed"]:"data"})',
    '__NUXT_JSONP__("/",{__proto__:{injected:true}})',
    '__NUXT_JSONP__("/",(async function(){return {text:"payload"}})())',
    '__NUXT_JSONP__("/",{text:globalThis.process.env.SECRET})',
  ]) assert.throws(() => decodeWebsiteData(source), /page_data_unsupported/, source)
  assert.equal(({} as Record<string, unknown>).injected, undefined)
})

test('generic collection keeps Chinese facts, short prices and arbitrary link keys; prunes only sibling locales', () => {
  const candidates = collectWebsiteData([{ translations: {
    'zh-CN': { billing: { heading: '退款规则', amount: '¥9', sentence: '有未使用的额度时可以申请退款。', internalPath: '/refunds' } },
    'zh-TW': { billing: { heading: '退款規則', sentence: '不應混入簡體頁面' } },
    en: { billing: { heading: 'Refund policy', sentence: 'Unused credits may be refunded.' } },
  }, notes: ['中文短句', '使用邮箱登录。'] }], url, 'zh-Hans')
  const result = appendWebsiteData('', candidates)
  for (const text of ['退款规则', '¥9', '有未使用的额度', 'https://example.com/refunds', '中文短句', '使用邮箱']) assert.ok(result.includes(text), text)
  for (const text of ['不應混入', 'Unused credits']) assert.ok(!result.includes(text), text)
})

test('React/Next embedded data and pure static HTML both use HTTP without starting a browser', async () => {
  const next = await processWebSourcePage(html(`<html lang="en">${body}${script({ props: { pageProps: { note: 'Password resets require access to your registered email address.', pathToRead: '/reset' } } })}</html>`), { collectData: true })
  assert.equal(next.fetchMode, 'http')
  assert.ok(next.content.data?.candidates.some(candidate => candidate.properties.note?.includes('registered email')))
  const staticPage = await processWebSourcePage(html(body), { collectData: true })
  assert.equal(staticPage.content.data?.candidates.length, 0)
  assert.ok(staticPage.content.content.includes('update your password'))
})

test('data-only shell can supply original facts without JavaScript execution', async () => {
  const page = await processWebSourcePage(html(`<html lang="zh"><head><title>退款说明</title></head><body><div id="__next"></div>${script({ props: { pageProps: { text: '退款申请需要在购买后的七天内提交，已使用的额度不能退款。' } } })}</body></html>`), { collectData: true })
  assert.equal(page.content.data?.requiresSelection, true)
  const selected = await selectWebsitePageData(page.content, page.content.data!, async () => ({ ids: page.content.data!.candidates.map(candidate => candidate.id) }))
  assert.ok(appendWebsiteData(page.content.content, selected).includes('七天内'))
})

test('Nuxt resources must be declared, same origin and robots permitted; data changes affect content fingerprint', async () => {
  const page = html(`${body}<link rel="preload" href="/_nuxt/static/build/state.js" as="script"><script src="https://evil.example.com/_nuxt/static/b/state.js"></script>`)
  let version = 1
  const seen: string[] = []
  const fetcher = async (target: string): Promise<CrawlResponse> => {
    seen.push(target)
    return { url: target, status: 200, headers: {}, body: `window.__NUXT__={article:{label:"Plan",note:"A monthly quota of ${version} credits applies."}}` }
  }
  const one = await processWebSourcePage(page, { collectData: true, fetcher })
  version = 2
  const two = await processWebSourcePage(page, { collectData: true, fetcher })
  assert.equal(one.dataBacked, true)
  assert.notEqual(one.content.hash, two.content.hash)
  assert.deepEqual(seen, ['https://example.com/_nuxt/static/build/state.js', 'https://example.com/_nuxt/static/build/state.js'])
  await assert.rejects(collectWebsitePageData(page, fetcher, () => false), /robots_disallowed/)
  await assert.rejects(collectWebsitePageData(page, async target => ({ url: target.replace('example.com', 'other.example.com'), status: 200, headers: {}, body: 'window.__NUXT__={}' })), /redirect_outside_scope/)
  await assert.rejects(collectWebsitePageData(page, async target => ({ url: target, status: 503, headers: {}, body: '' })), /page_data_http_503/)
})

test('build identifier alone does not invalidate equivalent public data', async () => {
  const fetcher = async (target: string): Promise<CrawlResponse> => ({ url: target, status: 200, headers: {}, body: 'window.__NUXT__={text:"The quota is 100 pages per month."}' })
  const first = await processWebSourcePage(html(`${body}<script src="/_nuxt/static/build-one/state.js"></script>`), { collectData: true, fetcher })
  const second = await processWebSourcePage(html(`${body}<script src="/_nuxt/static/build-two/state.js"></script>`), { collectData: true, fetcher })
  assert.equal(first.content.hash, second.content.hash)
})

test('selection validates all IDs and publishes original links, never generated facts', async () => {
  const candidates = collectWebsiteData([{ arbitrary: 'Refunds require unused credits.', xyz: '/refunds', price: '$9' }], url, 'en')
  const data: WebsitePageData = { candidates, external: false, hash: '' }
  const page = { title: 'Refunds', content: body, language: 'en', url }
  for (const raw of [{ ids: [999] }, { ids: [0], invented: 'Instant refunds' }, { ids: ['0'] }]) {
    await assert.rejects(selectWebsitePageData(page, data, async () => raw))
  }
  const selected = await selectWebsitePageData(page, data, async () => ({ ids: [0, 0] }))
  assert.equal(selected.length, 1)
  const content = appendWebsiteData('Original body', selected)
  assert.ok(content.includes('Refunds require unused credits.'))
  assert.ok(content.includes('https://example.com/refunds'))
  assert.ok(content.includes('$9'))
  assert.ok(!content.includes('Instant refunds'))
})

test('large multilingual site data is scoped before passage selection and rejects unknown namespace IDs', async () => {
  const candidates = collectWebsiteData([{ translations: { en: {
    guide: Array.from({ length: 80 }, (_, i) => ({ label: `Guide ${i}`, text: `Password and email instructions ${i}. `.repeat(35) })),
    other: Array.from({ length: 50 }, (_, i) => ({ label: `Other ${i}`, text: `Unrelated tool UI ${i}. `.repeat(35) })),
  }, fr: { guide: { text: 'French version excluded from this English page' } } } }], url, 'en')
  const data: WebsitePageData = { candidates, external: false, hash: '' }
  const page = { title: 'Account guide', content: body, language: 'en', url }
  let calls = 0
  const selected = await selectWebsitePageData(page, data, async input => {
    calls++
    if (input.groups) {
      const groups = input.groups as { id: number; path: string }[]
      return { ids: groups.filter(group => group.path.includes('.guide')).map(group => group.id) }
    }
    const items = input.candidates as { id: number }[]
    return { ids: items.map(item => item.id) }
  })
  assert.ok(calls >= 2)
  assert.equal(selected.length, 80)
  assert.ok(selected.every(candidate => candidate.properties.text?.includes('Password and email')))
  await assert.rejects(selectWebsitePageData(page, data, async () => ({ ids: [99999] })), /cleanup_invalid_selection/)
})

test('scalar language dictionaries and rendering metadata do not pollute the requested language', () => {
  const candidates = collectWebsiteData([{ name: { en: 'English product', zh: '中文产品' }, plan: { label: '基础版', price: '¥9', enabled: false, backgroundColor: 'red', style: 'padding: 8px', isNuxtLink: false, theme: 'linear-gradient(180deg, red, blue)' } }], url, 'zh')
  const content = appendWebsiteData('', candidates)
  assert.ok(content.includes('中文产品'))
  assert.ok(content.includes('¥9'))
  assert.ok(content.includes('enabled: false'), 'a product boolean can be meaningful')
  for (const noise of ['English product', 'backgroundColor', 'padding:', 'isNuxtLink', 'linear-gradient']) assert.ok(!content.includes(noise), noise)
})

test('bounded collection rejects excessive data instead of silently discarding late facts', () => {
  assert.throws(() => collectWebsiteData([Array.from({ length: 3001 }, (_, i) => ({ text: `A distinct public condition ${i}` }))], url), /page_data_too_large/)
})

test('unrelated Nuxt configuration scripts do not break SSR content and broken required JSON fails explicitly', async () => {
  const page = await processWebSourcePage(html(`${body}<script>window.__NUXT__={};window.__NUXT__.config={public:{key:"not body"}}</script>`), { collectData: true })
  assert.ok(page.content.content.includes('update your password'))
  assert.equal(page.content.data?.candidates.length, 0)
  await assert.rejects(processWebSourcePage(html(`${body}<script id="__NEXT_DATA__" type="application/json">{broken}</script>`), { collectData: true }), /page_data_invalid_json/)
})

test('JSON-LD alone cannot turn a JavaScript shell into a successfully captured document', async () => {
  await assert.rejects(processWebSourcePage(html('<html><body><div id="__next"></div><script src="/app.js"></script><script type="application/ld+json">{"@type":"Organization","name":"Example company"}</script></body></html>'), { collectData: true }), /page_requires_rendering/)
})

test('structured metadata cannot publish SEO ratings or a bare free offer as product conditions', async () => {
  const metadata = { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Account guide',
    description: 'Paid plans include downloadable account reports.', softwareVersion: '1.0',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.9', ratingCount: '13832' },
    mainEntity: [{ '@type': 'Question', name: 'Can I get a refund?', acceptedAnswer: { '@type': 'Answer', text: 'Refunds require unused credits within seven days.' } }],
  }
  const data = await collectWebsitePageData(html(`${body}<script type="application/ld+json">${JSON.stringify(metadata)}</script>`))
  const text = appendWebsiteData('', data.candidates)
  for (const fact of ['Paid plans include', 'Can I get a refund?', 'unused credits within seven days']) assert.ok(text.includes(fact), fact)
  for (const noise of ['@context', '@type', 'schema.org', 'ratingValue', '13832', 'price:', 'softwareVersion']) assert.ok(!text.includes(noise), noise)
})

test('serialized rendering snapshots and framework state are not published as prose', () => {
  const candidates = collectWebsiteData([{ __N_SSG: true, toc: JSON.stringify([{ text: 'Overview', url: '#' }, { text: 'Components', url: '#components' }]), __i18n: { en: { text: 'A genuine public email policy is retained.' } } }], url, 'en')
  assert.ok(!candidates.some(candidate => candidate.properties.text === 'Overview'))
  assert.ok(!candidates.some(candidate => candidate.properties.toc))
  assert.ok(!candidates.some(candidate => candidate.properties.__N_SSG))
  assert.ok(candidates.some(candidate => candidate.properties.text?.includes('public email policy')))
})

test('website discovery accepts embedded-data shells without model calls or a configured browser', async () => {
  const { discoverWebSourcePages } = await import('../server/lib/web-source/discovery')
  const { webSourceDiscovery } = await import('../shared/schemas/web-source')
  const result = await discoverWebSourcePages(webSourceDiscovery.parse({ url: 'https://example.com' }), async target => ({
    url: target, status: target.endsWith('sitemap.xml') ? 404 : 200, headers: { 'content-type': 'text/html' },
    body: target.endsWith('robots.txt') ? '' : `<html lang="en"><head><title>Public guide</title></head><body><div id="__next"></div>${script({ props: { pageProps: { body: 'Public documentation, available without login or browser execution.' } } })}</body></html>`,
  }))
  assert.ok(result.pages.some(page => page.url === 'https://example.com' && page.title === 'Public guide'))
})

test('data facts already present in DOM do not require another model call', async () => {
  const candidates = collectWebsiteData([{ title: 'Refund policy', text: 'Unused credits can be refunded.' }], url)
  const selected = await selectWebsitePageData({ title: 'Refund policy', content: '# Refund policy\n\nUnused credits can be refunded.' }, { candidates, hash: '', external: false }, async () => { throw Error('Duplicate facts should be skipped') })
  assert.deepEqual(selected, [])
})

test('identical prices assigned to different plans are not treated as DOM duplicates', async () => {
  let called = false
  const data: WebsitePageData = { hash: '', external: false, candidates: [{ id: 0, path: '$.enterprise', context: { name: 'Enterprise' }, properties: { price: '$9', period: 'monthly' } }] }
  const selected = await selectWebsitePageData({ title: 'Plans', content: 'Enterprise plans are annual. Starter costs $9 monthly.' }, data, async () => { called = true; return { ids: [0] } })
  assert.equal(called, true)
  assert.equal(selected.length, 1)
})

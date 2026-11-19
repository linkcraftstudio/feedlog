import { webSourceInputTypeForUrl } from '../../../shared/utils/web-source-pages'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { parseDocument, DomUtils } from 'htmlparser2'
import type { z } from 'zod'
import type { webSourceDiscovery } from '../../../shared/schemas/web-source'
import { CrawlError, excludedWebSourcePath, fetchWebSourceUrl, normalizeWebSourceUrl, withinWebSourceScope } from './fetch'
import { webSourceRobotsAllows, loadWebSourceRobots, parseWebSourceRobots, type RobotsPolicy } from './robots'

export function parseWebSourceSitemap(text: string, eligible: (url: string) => boolean = () => true) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw new CrawlError('invalid_sitemap')
  const xml = new XMLParser({ ignoreAttributes: false, processEntities: true, isArray: name => ['url', 'sitemap', 'xhtml:link'].includes(name) }).parse(text)
  const rows = xml.urlset?.url ?? xml.sitemapindex?.sitemap
  if (!Array.isArray(rows)) throw new CrawlError('invalid_sitemap')
  const urls: string[] = []
  for (const row of rows.slice(0, 50000)) {
    if (typeof row.loc === 'string') urls.push(row.loc)
    if (xml.sitemapindex) continue
    // Translations are distinct selectable pages, not duplicate URLs.
    for (const link of row['xhtml:link'] ?? []) {
      const href = link['@_href']
      if (String(link['@_rel']).toLowerCase().split(/\s+/).includes('alternate') && typeof href === 'string') {
        try { if (eligible(href)) urls.push(href) } catch { /* Ignore malformed alternates. */ }
      }
    }
  }
  return { index: !!xml.sitemapindex, urls: [...new Set(urls)] }
}
export async function discoverWebSourcePages(input: z.infer<typeof webSourceDiscovery>, fetcher = fetchWebSourceUrl) {
  let url = normalizeWebSourceUrl(input.url)
  let inputType = input.inputType ?? webSourceInputTypeForUrl(url)
  const deadline = AbortSignal.timeout(20000)
  let requests = 0, limited = false
  let active = 0
  const waiting: (() => void)[] = []
  const responseCache = new Map<string, ReturnType<typeof fetcher>>()
  const request: typeof fetcher = async (value, headers, scope, options) => {
    const key = normalizeWebSourceUrl(value), cached = responseCache.get(key)
    if (cached) return cached
    if (requests >= 32 || deadline.aborted) { limited = true; throw new CrawlError('discovery_limit') }
    requests++
    const signal = options?.signal ? AbortSignal.any([deadline, options.signal]) : deadline
    const origin = new URL(url).origin
    const allowed = scope ?? (requests === 1 ? undefined : (next: string) => new URL(next).origin === origin)
    const pending = (async () => {
      if (active >= 4) await new Promise<void>(resolve => waiting.push(resolve))
      else active++
      try {
        signal.throwIfAborted()
        return await fetcher(value, headers ?? {}, allowed, { ...options, signal })
      } catch (error) {
        if (deadline.aborted) { limited = true; throw new CrawlError('discovery_limit') }
        throw error
      } finally {
        const next = waiting.shift()
        if (next) next(); else active--
      }
    })()
    responseCache.set(key, pending)
    return pending
  }
  const pagePolicies = new Map<string, Promise<RobotsPolicy>>()
  function pagePolicy(value: string) {
    const origin = new URL(value).origin
    if (!pagePolicies.has(origin)) pagePolicies.set(origin, loadWebSourceRobots(value,
      (target, headers, scope, options) => request(target, headers, scope ?? (() => true), options)))
    return pagePolicies.get(origin)!
  }
  async function readEntry(value: string) {
    let current = normalizeWebSourceUrl(value)
    for (let redirects = 0; redirects <= 5; redirects++) {
      const rules = await pagePolicy(current)
      if (!webSourceRobotsAllows(rules, current)) throw new CrawlError('robots_disallowed')
      const response = await request(current, {}, () => true, { singleHop: true })
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      if (!response.headers.location) throw new CrawlError('invalid_redirect')
      current = normalizeWebSourceUrl(new URL(response.headers.location, current).href)
    }
    throw new CrawlError('too_many_redirects')
  }
  const wholeWebsite = inputType === 'website' && new URL(url).pathname === '/'
  let policy: RobotsPolicy
  if (wholeWebsite) {
    // Read crawl rules before requesting sitemap or page content. A usable
    // sitemap still avoids fetching the homepage or individual page bodies.
    try { policy = await loadWebSourceRobots(url, request) }
    catch (error) {
      if (!(error instanceof CrawlError && error.code === 'redirect_outside_scope')) throw error
      const initial = await readEntry(url)
      if (initial.status >= 400) throw new CrawlError(`http_${initial.status}`, initial.status >= 500)
      url = new URL(normalizeWebSourceUrl(initial.url)).origin
      responseCache.set(normalizeWebSourceUrl(initial.url), Promise.resolve(initial))
      policy = await pagePolicy(url)
    }
  } else {
    const initial = inputType === 'robots' ? await request(url, {}, () => true) : await readEntry(url)
    if (initial.status >= 400 && !(inputType === 'robots' && [404, 410].includes(initial.status))) throw new CrawlError(`http_${initial.status}`, initial.status >= 500 || initial.status === 429)
    url = normalizeWebSourceUrl(initial.url)
    if (!input.inputType && /<(?:urlset|sitemapindex)(?:\s|>)/i.test(initial.body.slice(0, 5000))) inputType = 'sitemap'
    responseCache.set(url, Promise.resolve(initial))
    policy = inputType === 'robots' ? parseWebSourceRobots(initial.body) : await pagePolicy(url)
  }
  const pages = new Map<string, { title: string; url: string }>()
  const visited = new Set<string>()
  const eligible = (value: string) => withinWebSourceScope(value, url, inputType)
    && !excludedWebSourcePath(value, input.excludes) && webSourceRobotsAllows(policy, value)
    && !/\.(png|jpe?g|gif|webp|svg|pdf|zip|mp[34]|css|js|woff2?)(?:\?|$)/i.test(new URL(value).pathname)
  const add = (value: string, title?: string) => {
    try {
      const normalized = normalizeWebSourceUrl(value)
      if (pages.size < input.pageLimit && eligible(normalized)) pages.set(normalized, { url: normalized, title: title || '' })
    } catch { /* Ignore malformed sitemap entries and unsupported links. */ }
  }
  async function sitemaps(locations: string[], depth = 0) {
    // Only sitemap documents are fetched, with at most four in flight. A page
    // URL in a sitemap is already a candidate; fetching its body belongs to sync.
    for (let i = 0; i < locations.length && pages.size < input.pageLimit; i += 4) {
      const results = await Promise.allSettled(locations.slice(i, i + 4).map(location => sitemap(location, depth)))
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure) throw failure.reason
    }
  }
  async function sitemap(value: string, depth = 0): Promise<void> {
    if (depth > 4) { limited = true; return }
    if (visited.has(value) || pages.size >= input.pageLimit) return
    if (new URL(value).origin !== new URL(url).origin) return
    visited.add(value)
    if (!webSourceRobotsAllows(policy, value)) throw new CrawlError('robots_disallowed')
    const response = await request(value, {}, target => new URL(target).origin === new URL(url).origin && webSourceRobotsAllows(policy, target))
    if (response.status >= 400) throw new CrawlError(`http_${response.status}`, response.status >= 500 || response.status === 429)
    const parsed = parseWebSourceSitemap(response.body, eligible)
    const locations = parsed.urls.flatMap(location => { try { return [normalizeWebSourceUrl(location)] } catch { return [] } })
    if (parsed.index) await sitemaps(locations, depth + 1)
    else for (const next of locations) add(next)
  }
  if (inputType === 'sitemap') {
    try { await sitemap(url) } catch (error) { if (!(error instanceof CrawlError && error.code === 'discovery_limit' && pages.size)) throw error }
  }
  else if (inputType === 'robots') {
    if (!policy.sitemaps.length) throw new CrawlError('robots_has_no_sitemap')
    try { await sitemaps(policy.sitemaps) } catch (error) { if (!(error instanceof CrawlError && error.code === 'discovery_limit' && pages.size)) throw error }
  } else {
    try { await sitemaps(policy.sitemaps.length ? policy.sitemaps : [new URL('/sitemap.xml', url).href]) } catch { /* Fall back to HTML links when the sitemap is unavailable. */ }
    const queue = [url]
    // A usable sitemap completes discovery. Never inspect page bodies, hydrate
    // framework data or start a browser merely to populate the selection list.
    if (!pages.size) while (queue.length && !deadline.aborted && pages.size < input.pageLimit) {
      const batch = queue.splice(0, 4)
      await Promise.allSettled(batch.map(async next => {
        if (visited.has(next) || !eligible(next)) return
        visited.add(next)
        const response = await readEntry(next)
        if (next === url) {
          const resolved = normalizeWebSourceUrl(response.url)
          const originChanged = new URL(resolved).origin !== new URL(url).origin
          url = wholeWebsite ? new URL(resolved).origin : resolved
          if (originChanged) policy = await pagePolicy(url)
        }
        if (response.status >= 400 || !/text\/html|application\/xhtml\+xml/i.test(response.headers['content-type'] ?? 'text/html')) return
        const dom = parseDocument(response.body)
        const title = DomUtils.getElementsByTagName('title', dom, true)[0] ?? DomUtils.getElementsByTagName('h1', dom, true)[0]
        add(response.url, title ? DomUtils.textContent(title).replace(/\s+/g, ' ').trim().slice(0, 300) : '')
        for (const node of DomUtils.getElementsByTagName('a', dom, true)) {
          try {
            if (!node.attribs.href) continue
            const link = normalizeWebSourceUrl(new URL(node.attribs.href, response.url).href)
            if (eligible(link)) { add(link); if (!visited.has(link)) queue.push(link) }
          } catch { /* Ignore invalid and unsupported links. */ }
        }
      }))
      if (requests >= 32) { limited = queue.length > 0 || limited; break }
    }
  }
  if (!pages.size) throw new CrawlError(webSourceRobotsAllows(policy, url) ? 'no_pages_found' : 'robots_disallowed')
  return { url, inputType, pages: [...pages.values()], limited: limited || pages.size >= input.pageLimit || deadline.aborted }
}

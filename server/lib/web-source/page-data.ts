import { createHash } from 'node:crypto'
import { parseDocument, DomUtils } from 'htmlparser2'
import { CrawlError, MAX_PAGE_BYTES, normalizeWebSourceUrl, fetchWebSourceUrl, type CrawlResponse } from './fetch'
import { decodeWebsiteData } from './data-decoder'
import { extractWebSourceContent } from './content'

export interface WebsiteDataCandidate { id: number; path: string; properties: Record<string, string>; context?: Record<string, string> }
export interface WebsitePageData { candidates: WebsiteDataCandidate[]; external: boolean; hash: string; canHydrate?: boolean; requiresSelection?: boolean }
const MAX_CANDIDATES = 3000, MAX_TEXT = 600000
const locale = (key: string) => /^(?:en|zh|fr|de|es|pt|ru|ja|ko|it|ar|hi|tr|vi|th|nl|pl|uk|id|cs|da|fi|sv|no|he|hu|ro|el|bn|ms|ta|te)(?:[-_][a-z\d]{2,8})*$/i.test(key)
const comparableLocale = (key: string) => key.toLowerCase().replace(/_/g, '-').replace(/^zh-(?:cn|hans)$/, 'zh-hans').replace(/^zh-(?:tw|hant)$/, 'zh-hant')

// Search-engine descriptors are not page prose. Keep authored answers and
// conditions, but do not turn an application's SEO "free" offer into pricing.
function structuredPageFacts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structuredPageFacts).filter(item => item != null)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const types = [record['@type']].flat()
  if (types.includes('AggregateRating') || types.includes('Rating')) return null
  if (types.includes('Offer') && Number(record.price) === 0 && !record.description && !record.priceSpecification) return null
  return Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith('@')
    && !['aggregateRating', 'review', 'ratingValue', 'ratingCount', 'bestRating', 'worstRating', 'operatingSystem', 'applicationCategory', 'softwareVersion', 'availability'].includes(key))
    .map(([key, child]) => [key, structuredPageFacts(child)]).filter(([, child]) => child != null))
}

// Shape-based collection keeps short prices, non-Latin text and link values.
// No product field paths or word blacklists ("email" can be a valid FAQ fact).
export function collectWebsiteData(roots: unknown[], url: string, language?: string): WebsiteDataCandidate[] {
  const candidates: WebsiteDataCandidate[] = [], seen = new Set<string>()
  let visits = 0, textSize = 0
  function walk(value: unknown, path: string, depth: number, context?: Record<string, string>) {
    if (++visits > 60000 || depth > 60) throw new CrawlError('page_data_too_large')
    if (typeof value === 'string' && value.trim() && value.length <= 12000 && /\p{L}/u.test(value)) {
      const signature = JSON.stringify([context, value])
      if (!seen.has(signature)) {
        textSize += signature.length
        if (textSize > MAX_TEXT || candidates.length >= MAX_CANDIDATES) throw new CrawlError('page_data_too_large')
        seen.add(signature); candidates.push({ id: candidates.length, path, properties: { text: value }, ...(context && { context }) })
      }
      return
    }
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach((child, index) => walk(child, `${path}[${index}]`, depth + 1, context)); return }
    const entries = Object.entries(value), languages = entries.filter(([key, child]) => locale(key) && child != null)
    // Only treat keys as locale branches when at least two siblings agree.
    // Unknown page language keeps all branches for model-assisted selection.
    const target = language && comparableLocale(language)
    const available = languages.map(([key]) => comparableLocale(key))
    const match = target && (available.includes(target) ? target : available.find(key => key === target.split('-')[0]))
    const properties: Record<string, string> = Object.create(null)
    for (const [key, child] of entries) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || key.length > 100) continue
      if (match && languages.length >= 2 && locale(key) && comparableLocale(key) !== match) continue
      if (key.startsWith('__') || key.startsWith('@')) continue
      // Serialized rendering snapshots are not independent prose. Actual
      // application/json scripts are decoded above; don't flatten component ASTs.
      if (typeof child === 'string' && (child.trim().startsWith('[') || child.trim().startsWith('{'))) {
        try { const nested = JSON.parse(child); if (nested && typeof nested === 'object') continue } catch { /* ordinary prose/code */ }
      }
      if (/^(?:class(?:name)?|style|icon|background(?:color)?|isNuxtLink|buildId|isFallback|nextExport)$/i.test(key)) continue
      if (typeof child !== 'string' && typeof child !== 'number' && typeof child !== 'boolean') continue
      let text = String(child).trim()
      if (!text || text.length > 12000 || /^(?:#[a-f\d]{3,8}|[a-f\d]{24,}|data:|(?:repeating-)?(?:linear|radial|conic)-gradient\(|rgba?\(|hsla?\(|M[\d .,-]+[a-z])/i.test(text) || /<svg\b/i.test(text)) continue
      if (/^(?:https?:\/\/|\/[^/])/.test(text)) {
        try { text = normalizeWebSourceUrl(new URL(text, url).href) } catch { continue }
        if (/\.(?:svg|png|jpe?g|webp|avif|gif|woff2?|css|js)(?:\?|$)/i.test(new URL(text).pathname)) continue
      } else if (/<[a-z][^>]*>/i.test(text)) {
        try { text = extractWebSourceContent(`<main>${text}</main>`, url).content }
        catch { text = DomUtils.textContent(parseDocument(text.replace(/<\/?(?:script|style)\b[^>]*>[\s\S]*?(?:<\/\s*(?:script|style)>|$)/gi, ''))).trim() }
      }
      if (text) properties[key] = text
    }
    if (Object.keys(properties).length && Object.values(properties).some(text => /\p{L}/u.test(text) && !/^https?:\/\//.test(text))) {
      const signature = JSON.stringify([context, properties])
      if (!seen.has(signature)) {
        textSize += signature.length
        if (textSize > MAX_TEXT || candidates.length >= MAX_CANDIDATES) throw new CrawlError('page_data_too_large')
        seen.add(signature); candidates.push({ id: candidates.length, path, properties, ...(context && { context }) })
      }
    }
    // Carry small parent labels into nested arrays without repeating whole site dictionaries.
    const inherited = Object.fromEntries(Object.entries(properties).filter(([key, text]) => /^(?:name|title|label|heading)$/i.test(key) && text.length <= 100 && !/^https?:/.test(text)).slice(0, 2))
    for (const [key, child] of entries) {
      if (match && languages.length >= 2 && locale(key) && comparableLocale(key) !== match) continue
      if (child && typeof child === 'object') walk(child, `${path}.${key}`, depth + 1, Object.keys(inherited).length ? inherited : context)
    }
  }
  roots.forEach((root, index) => walk(root, `$${index}`, 0))
  return candidates
}

export async function collectWebsitePageData(response: CrawlResponse, fetcher = fetchWebSourceUrl, allows: (url: string) => boolean = () => true): Promise<WebsitePageData> {
  const dom = parseDocument(response.body), roots: unknown[] = [], resources = new Set<string>()
  let canHydrate = false
  const scripts = DomUtils.getElementsByTagName('script', dom, true)
  for (const script of scripts) {
    const type = (script.attribs.type ?? '').toLowerCase(), text = DomUtils.textContent(script).trim()
    if ((type === 'application/json' || type === 'application/ld+json' || script.attribs.id === '__NEXT_DATA__') && text) {
      if (Buffer.byteLength(text) > MAX_PAGE_BYTES) throw new CrawlError('page_data_too_large')
      try { roots.push(type === 'application/ld+json' ? structuredPageFacts(JSON.parse(text)) : JSON.parse(text)); if (type !== 'application/ld+json') canHydrate = true }
      catch {
        if (['__NEXT_DATA__', '__NUXT_DATA__'].includes(script.attribs.id ?? '')) throw new CrawlError('page_data_invalid_json', true)
        // Ignore unrelated malformed structured metadata.
      }
    } else if (/^window\.__NUXT__\s*=/.test(text)) {
      try { roots.push(decodeWebsiteData(text)); canHydrate = true }
      catch (error) {
        if (!(error instanceof CrawlError) || error.code !== 'page_data_unsupported') throw error
        // Nuxt 3 may combine configuration assignments in this script. That
        // executable format is not a data envelope; keep the SSR body path.
      }
    }
  }
  // Read only declared Nuxt data assets, never guess arbitrary APIs or execute bundles.
  const declared = [...scripts, ...DomUtils.getElementsByTagName('link', dom, true).filter(node => /^(?:preload|prefetch)$/i.test(node.attribs.rel ?? ''))]
  for (const node of declared) {
    const raw = node.attribs.src ?? node.attribs.href
    if (!raw) continue
    let url: string
    try { url = normalizeWebSourceUrl(new URL(raw, response.url).href) } catch { continue }
    if (new URL(url).origin === new URL(response.url).origin && /\/_nuxt\/static\/[^/]+\/(?:[^?#]*\/)?(?:state|payload)\.js$/.test(new URL(url).pathname)) resources.add(url)
  }
  if (resources.size > 3) throw new CrawlError('page_data_too_large')
  const assets = await Promise.all([...resources].map(async url => {
    if (!allows(url)) throw new CrawlError('robots_disallowed')
    const scope = (target: string) => new URL(target).origin === new URL(response.url).origin && allows(target)
    const asset = await fetcher(url, {}, scope)
    if (!scope(asset.url)) throw new CrawlError('redirect_outside_scope')
    if (asset.status >= 400) throw new CrawlError(`page_data_http_${asset.status}`, asset.status === 429 || asset.status >= 500)
    if (asset.status !== 200) throw new CrawlError('page_data_invalid_response', true)
    return decodeWebsiteData(asset.body)
  }))
  roots.push(...assets)
  const html = DomUtils.getElementsByTagName('html', dom, true)[0]
  const language = html?.attribs.lang
  const candidates = collectWebsiteData(roots, response.url, language)
  // Exclude asset build URLs from the fingerprint; include the actual data.
  const hash = createHash('sha256').update(JSON.stringify(candidates)).digest('hex')
  return { candidates, external: resources.size > 0, hash, canHydrate: canHydrate || resources.size > 0 }
}

export function websiteDataGroups(candidates: WebsiteDataCandidate[]) {
  const groups = new Map<string, WebsiteDataCandidate[]>()
  for (const candidate of candidates) {
    const parts = candidate.path.split('.'), index = parts.findIndex(part => locale(part.replace(/\[\d+\]/g, '')))
    const path = parts.slice(0, index < 0 ? 3 : index + (parts[index]!.includes('[') ? 1 : 2)).join('.').replace(/\[\d+\]/g, '[]')
    const group = groups.get(path) ?? []; group.push(candidate); groups.set(path, group)
  }
  return [...groups].map(([path, items], id) => ({ id, path, items }))
}

export function appendWebsiteData(content: string, selected: WebsiteDataCandidate[]) {
  const blocks = selected.map(candidate => [candidate.context, candidate.properties].filter(Boolean).map(properties => Object.entries(properties!).map(([key, text]) => `${key}: ${text}`).join('\n')).join('\n'))
  const combined = [content, ...blocks].filter(Boolean).join('\n\n')
  if (combined.length > 500000) throw new CrawlError('content_too_large')
  return combined
}

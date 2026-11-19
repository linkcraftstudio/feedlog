import { isIP } from 'node:net'
import { resolve4 } from 'node:dns/promises'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'
import type { IncomingMessage } from 'node:http'

export class CrawlError extends Error {
  constructor(public code: string, public retryable = false) { super(code) }
}
export const CRAWL_USER_AGENT = 'FeedLogBot/1.0'
export const MAX_PAGE_BYTES = 2 * 1024 * 1024
export interface CrawlResponse { url: string; status: number; headers: Record<string, string>; body: string }

export function normalizeWebSourceUrl(value: string) {
  let url: URL
  try { url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`) }
  catch { throw new CrawlError('invalid_url') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || (url.port && !['80', '443'].includes(url.port)) || value.length > 2048) throw new CrawlError('invalid_url')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host.includes('.') || isIP(host.replace(/^\[|\]$/g, '')) || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) throw new CrawlError('private_address')
  url.hostname = host; url.hash = ''
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key)
  url.searchParams.sort()
  return url.pathname === '/' ? url.href.replace(/\/$/, '') : url.href
}
export function isPublicIPv4(address: string) {
  if (isIP(address) !== 4) return false
  const [a, b, c] = address.split('.').map(Number) as [number, number, number, number]
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 0 && c === 2)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
}
export function withinWebSourceScope(value: string, source: string, inputType: string) {
  const target = new URL(normalizeWebSourceUrl(value)), root = new URL(normalizeWebSourceUrl(source))
  if (target.origin !== root.origin) return false
  if (inputType !== 'website' || root.pathname === '/') return true
  const prefix = root.pathname.replace(/\/$/, '')
  return target.pathname === prefix || target.pathname.startsWith(prefix + '/')
}
export function excludedWebSourcePath(value: string, excludes: string) {
  const path = new URL(value).pathname
  return excludes.split('\n').map(x => x.trim()).filter(Boolean).some(prefix => path.startsWith(prefix))
}

// Resolve once and pin the connection to that public address. Redirects repeat
// both URL and DNS validation; provider headers and cookies are never forwarded.
async function nodeFetch(url: URL, headers: Record<string, string>, signal?: AbortSignal): Promise<CrawlResponse> {
  let dnsTimer: ReturnType<typeof setTimeout> | undefined
  let abortDns: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    abortDns = () => reject(new CrawlError('fetch_failed', true))
    signal?.addEventListener('abort', abortDns, { once: true })
    if (signal?.aborted) abortDns()
  })
  const addresses = await Promise.race([resolve4(url.hostname), cancelled, new Promise<never>((_resolve, reject) => {
    dnsTimer = setTimeout(() => reject(new CrawlError('dns_failed', true)), 5000)
  })]).catch(error => { throw error instanceof CrawlError ? error : new CrawlError('dns_failed', true) }).finally(() => {
    clearTimeout(dnsTimer)
    if (abortDns) signal?.removeEventListener('abort', abortDns)
  })
  if (!addresses.length || !addresses.every(isPublicIPv4)) throw new CrawlError('private_address')
  const { request } = await import(url.protocol === 'https:' ? 'node:https' : 'node:http')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => req.destroy(new CrawlError('fetch_timeout', true)), 10000)
    const req = request(url, {
      method: 'GET', agent: false, family: 4, signal,
      headers: { 'User-Agent': CRAWL_USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml,text/xml,text/plain;q=0.9', ...headers },
      lookup: (_hostname: string, _options: unknown, callback: (error: null, address: string, family: number) => void) => callback(null, addresses[0]!, 4),
    }, (response: IncomingMessage) => {
      const parts: Buffer[] = []; let bytes = 0
      response.on('data', (part: Buffer) => {
        bytes += part.length
        if (bytes > MAX_PAGE_BYTES) {
          const error = new CrawlError('page_too_large')
          clearTimeout(timer); reject(error); req.destroy(error); return
        }
        parts.push(part)
      })
      response.on('error', error => { clearTimeout(timer); reject(error) })
      response.on('aborted', () => { clearTimeout(timer); reject(new CrawlError('fetch_failed', true)) })
      response.on('end', () => {
        clearTimeout(timer)
        try {
          let body = Buffer.concat(parts)
          const encoding = response.headers['content-encoding']
          if (encoding === 'gzip' || (body[0] === 31 && body[1] === 139)) body = gunzipSync(body, { maxOutputLength: MAX_PAGE_BYTES })
          else if (encoding === 'deflate') body = inflateSync(body, { maxOutputLength: MAX_PAGE_BYTES })
          else if (encoding === 'br') body = brotliDecompressSync(body, { maxOutputLength: MAX_PAGE_BYTES })
          if (body.length > MAX_PAGE_BYTES) throw new CrawlError('page_too_large')
          const out: Record<string, string> = {}
          for (const name of ['location', 'content-type', 'etag', 'last-modified', 'x-robots-tag', 'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-expose-headers', 'content-security-policy']) {
            const value = response.headers[name]
            if (typeof value === 'string') out[name] = value
          }
          const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(out['content-type'] ?? '')?.[1]
            ?? /<meta[^>]+charset\s*=\s*["']?([^\s;"'>]+)/i.exec(body.subarray(0, 4096).toString('ascii'))?.[1]
            ?? 'utf-8'
          resolve({ url: url.href, status: response.statusCode ?? 502, headers: out, body: new TextDecoder(charset).decode(body) })
        } catch (error) {
          reject(error instanceof CrawlError ? error : new CrawlError(error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE' ? 'page_too_large' : 'invalid_encoding'))
        }
      })
    })
    req.on('error', (error: Error) => { clearTimeout(timer); reject(error instanceof CrawlError ? error : new CrawlError('fetch_failed', true)) })
    req.end()
  })
}

export async function fetchWebSourceUrl(value: string, headers: Record<string, string> = {}, scope?: (url: string) => boolean, options: { signal?: AbortSignal; singleHop?: boolean } = {}): Promise<CrawlResponse> {
  let current = normalizeWebSourceUrl(value)
  for (let redirects = 0; redirects <= 5; redirects++) {
    options.signal?.throwIfAborted()
    if (scope && !scope(current)) throw new CrawlError('redirect_outside_scope')
    let result: CrawlResponse
    if (import.meta.preset?.startsWith('cloudflare')) {
      const gateway = process.env.WEB_SOURCE_FETCH_GATEWAY_URL, token = process.env.WEB_SOURCE_FETCH_GATEWAY_TOKEN
      if (!gateway || !token) throw new CrawlError('fetch_gateway_not_configured')
      const response = await fetch(gateway, { method: 'POST', redirect: 'error', signal: options.signal ? AbortSignal.any([AbortSignal.timeout(15000), options.signal]) : AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ url: current, headers }) })
      if (!response.ok) throw new CrawlError('fetch_gateway_failed', response.status >= 500)
      result = await response.json() as CrawlResponse
    } else result = await nodeFetch(new URL(current), headers, options.signal)
    if (options.singleHop) return result
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      if (!result.headers.location) throw new CrawlError('invalid_redirect')
      current = normalizeWebSourceUrl(new URL(result.headers.location, current).href)
      continue
    }
    return result
  }
  throw new CrawlError('too_many_redirects')
}

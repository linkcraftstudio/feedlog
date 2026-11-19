import { CrawlError, fetchWebSourceUrl, CRAWL_USER_AGENT } from './fetch'

interface Rule { allow: boolean; path: string }
export interface RobotsPolicy { rules: Rule[]; sitemaps: string[] }
export function parseWebSourceRobots(text: string): RobotsPolicy {
  const groups: { agents: string[]; rules: Rule[] }[] = [], sitemaps: string[] = []
  let group: typeof groups[number] | undefined, hasRules = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim(), at = line.indexOf(':')
    if (at < 0) continue
    const key = line.slice(0, at).trim().toLowerCase(), value = line.slice(at + 1).trim()
    if (key === 'sitemap') { if (value) sitemaps.push(value); continue }
    if (key === 'user-agent') {
      if (!value) continue
      if (!group || hasRules) { group = { agents: [], rules: [] }; groups.push(group); hasRules = false }
      group.agents.push(value.toLowerCase())
    } else if (group && ['allow', 'disallow'].includes(key)) {
      hasRules = true
      if (value) group.rules.push({ allow: key === 'allow', path: value })
    }
  }
  const bot = CRAWL_USER_AGENT.split('/')[0]!.toLowerCase()
  const score = (group: typeof groups[number]) => Math.max(0, ...group.agents.filter(a => a !== '*' && bot.includes(a)).map(a => a.length))
  const longest = Math.max(0, ...groups.map(score))
  return { rules: groups.filter(g => longest ? score(g) === longest : g.agents.includes('*')).flatMap(g => g.rules), sitemaps }
}
export function webSourceRobotsAllows(policy: RobotsPolicy, value: string) {
  const url = new URL(value), path = url.pathname + url.search
  const matching = policy.rules.filter(rule => {
    const end = rule.path.endsWith('$'), raw = end ? rule.path.slice(0, -1) : rule.path
    const parts = raw.split('*')
    if (!path.startsWith(parts[0]!)) return false
    if (parts.length === 1) return !end || path === raw
    let offset = parts[0]!.length
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i]!
      const at = end && i === parts.length - 1 ? path.length - part.length : path.indexOf(part, offset)
      if (at < offset || path.slice(at, at + part.length) !== part) return false
      offset = at + part.length
    }
    return true
  }).sort((a, b) => b.path.replace(/[*$]/g, '').length - a.path.replace(/[*$]/g, '').length || Number(b.allow) - Number(a.allow))
  return matching[0]?.allow ?? true
}
export async function loadWebSourceRobots(url: string, fetcher = fetchWebSourceUrl) {
  const result = await fetcher(new URL('/robots.txt', url).href)
  if (result.status === 404 || result.status === 410) return { rules: [], sitemaps: [] } as RobotsPolicy
  if ([401, 403].includes(result.status)) throw new CrawlError('robots_disallowed')
  if (result.status >= 400) throw new CrawlError('robots_unavailable', true)
  return parseWebSourceRobots(result.body)
}

import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { CJK_RANGE } from '../../shared/constants/help'

const CJK_CHAR = new RegExp(`[${CJK_RANGE}]`)
const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/
const LATIN_STEM = /(ing|ed|es|s)$/i

const MAX_SEGMENTS = 8
const EXCERPT_BEFORE = 100
const EXCERPT_AFTER = 160

export interface HelpQueryToken {
  kind: 'latin' | 'cjk'
  text: string
}

export function splitHelpQuery(q: string): HelpQueryToken[] {
  const tokens: HelpQueryToken[] = []

  for (const segment of q.trim().split(/\s+/).filter(Boolean).slice(0, MAX_SEGMENTS)) {
    let buffer = ''
    let kind: HelpQueryToken['kind'] | null = null

    const flush = () => {
      if (buffer && kind) tokens.push({ kind, text: buffer })
      buffer = ''
    }

    for (const char of segment) {
      const next = CJK_CHAR.test(char) ? 'cjk' : 'latin'
      if (next !== kind) {
        flush()
        kind = next
      }
      buffer += char
    }
    flush()
  }

  return tokens.filter(token => token.kind === 'cjk' || /[a-z0-9]/i.test(token.text))
}

export function buildHelpTsQuery(tokens: HelpQueryToken[]): SQL | null {
  const parts = tokens.map((token) => {
    if (token.kind === 'latin') return sql`plainto_tsquery('english', ${token.text})`
    if (token.text.length >= 2) return sql`to_tsquery('simple', ${Array.from({ length: token.text.length - 1 }, (_, i) => token.text.slice(i, i + 2)).join(' | ')})`
    return sql`to_tsquery('simple', ${`${token.text}:*`})`
  })

  if (!parts.length) return null
  return parts.reduce((acc, part) => sql`${acc} || ${part}`)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: [number, number][] = []

  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else out.push([range[0], range[1]])
  }

  return out
}

export function helpHighlightRanges(text: string, tokens: HelpQueryToken[]): [number, number][] {
  const ranges: [number, number][] = []

  for (const token of tokens) {
    let pattern: RegExp
    if (token.kind === 'latin') {
      const root = token.text.replace(LATIN_STEM, '')
      pattern = root.length >= 4 && root.length < token.text.length
        ? new RegExp(`${escapeRegExp(root)}[\\p{L}\\p{N}]*`, 'giu')
        : new RegExp(escapeRegExp(token.text), 'gi')
    }
    else {
      pattern = new RegExp(escapeRegExp(token.text), 'g')
    }

    for (const match of text.matchAll(pattern)) {
      if (match[0].length) ranges.push([match.index, match.index + match[0].length])
    }
  }

  return mergeRanges(ranges)
}

const charWidth = (char: string) => (WIDE_CHAR.test(char) ? 2 : 1)

function truncateToWidth(text: string, maxWidth: number): string {
  let width = 0
  for (let i = 0; i < text.length; i++) {
    width += charWidth(text[i]!)
    if (width > maxWidth) return `${text.slice(0, i)}…`
  }
  return text
}

function bestExcerptAnchor(body: string, tokens: HelpQueryToken[]): number | null {
  const distinct = [...new Map(tokens.map(token => [`${token.kind}:${token.text.toLowerCase()}`, token])).values()]
  const points = distinct.flatMap((token, term) => helpHighlightRanges(body, [token]).map(([from, to]) => ({ from, to, term })))
    .sort((a, b) => a.from - b.from || a.to - b.to)
  if (!points.length) return null

  const counts = new Array<number>(distinct.length).fill(0)
  let left = 0, covered = 0, bestCovered = 0, bestSpan = Infinity, anchor = points[0]!.from
  for (let right = 0; right < points.length; right++) {
    const point = points[right]!
    if (counts[point.term]!++ === 0) covered++
    while (point.to - points[left]!.from > 180) {
      if (--counts[points[left]!.term] === 0) covered--
      left++
    }
    const span = point.to - points[left]!.from
    if (covered > bestCovered || (covered === bestCovered && span < bestSpan)) {
      bestCovered = covered
      bestSpan = span
      anchor = Math.floor((points[left]!.from + point.to) / 2)
    }
  }
  return anchor
}

export function buildHelpExcerpt(body: string, description: string | null, tokens: HelpQueryToken[], options: { bestMatch?: boolean } = {}): {
  excerpt: string
  ranges: [number, number][]
} {
  const hits = helpHighlightRanges(body, tokens)

  if (!hits.length) {
    const fallback = truncateToWidth((description?.trim() || body).trim(), EXCERPT_BEFORE + EXCERPT_AFTER)
    return { excerpt: fallback, ranges: helpHighlightRanges(fallback, tokens) }
  }

  const [firstStart, firstEnd] = hits[0]!
  const anchor = options.bestMatch ? bestExcerptAnchor(body, tokens) : null
  const hitStart = anchor ?? firstStart
  const hitEnd = anchor ?? firstEnd

  let start = hitStart
  for (let width = 0; start > 0;) {
    const next = charWidth(body[start - 1]!)
    if (width + next > EXCERPT_BEFORE) break
    width += next
    start--
  }

  let end = hitEnd
  for (let width = 0; end < body.length;) {
    const next = charWidth(body[end]!)
    if (width + next > EXCERPT_AFTER) break
    width += next
    end++
  }

  const prefix = start > 0 ? '…' : ''
  const shift = prefix.length - start

  return {
    excerpt: `${prefix}${body.slice(start, end)}${end < body.length ? '…' : ''}`,
    ranges: hits
      .filter(([from, to]) => from >= start && to <= end)
      .map(([from, to]) => [from + shift, to + shift] as [number, number]),
  }
}

import { sql } from 'drizzle-orm'
import { splitHelpQuery } from '../../utils/help-search'

// Shared query construction; each caller must apply its own visibility scope.
export function buildBilingualHelpQuery(query: string, english: string[]) {
  const parts = splitHelpQuery(query).map(token => {
    if (token.kind === 'latin') return sql`plainto_tsquery('english', ${token.text})`
    const terms = Array.from({ length: token.text.length - 1 }, (_, i) => token.text.slice(i, i + 2))
    return sql`to_tsquery('simple', ${terms.length ? terms.join(' & ') : `${token.text}:*`})`
  })
  const routes = english.map(value => sql`plainto_tsquery('english', ${value})`)
  if (parts.length) routes.unshift(parts.reduce((a, b) => sql`(${a}) && (${b})`))
  return routes.reduce((a, b) => sql`(${a}) || (${b})`)
}

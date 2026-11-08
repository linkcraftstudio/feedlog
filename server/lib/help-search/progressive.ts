import { rewriteHelpQuery } from './rewrite'

export function canTranslateHelpQuery(query: string): boolean {
  return /[\u3400-\u9fff]/.test(query)
    && process.env.HELP_SEARCH_BILINGUAL === 'true'
    && !!process.env.OPENAI_API_KEY && !!process.env.OPENAI_TEXT_MODEL
}

// The first request never invokes a model. A translation retry rechecks live results.
export async function searchHelpProgressively<T>(options: {
  query: string
  orgId: string
  translate: boolean
  search: (phrases?: string[]) => Promise<T[]>
  rewrite?: typeof rewriteHelpQuery
}) {
  const rows = await options.search()
  const eligible = !rows.length && canTranslateHelpQuery(options.query)
  if (!rows.length && options.translate && /[\u3400-\u9fff]/.test(options.query) && !eligible) {
    return { rows, searchMode: 'fallback' as const, canTranslate: false, translatedQueries: [] as string[] }
  }
  if (!eligible || !options.translate) {
    return { rows, searchMode: 'lexical' as const, canTranslate: eligible, translatedQueries: [] as string[] }
  }
  const rewritten = await (options.rewrite ?? rewriteHelpQuery)(options.orgId, options.query)
  if (!rewritten.queries?.length) {
    return { rows, searchMode: 'fallback' as const, canTranslate: false, translatedQueries: [] as string[] }
  }
  return {
    rows: await options.search(rewritten.queries),
    searchMode: 'bilingual' as const,
    canTranslate: false,
    translatedQueries: rewritten.queries,
  }
}

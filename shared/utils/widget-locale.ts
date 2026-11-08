export type WidgetLanguage = 'en' | 'zh'

export function resolveWidgetLocale(input: string, languages: readonly string[]): WidgetLanguage {
  for (const candidate of input === 'auto' ? languages : [input]) {
    const language = candidate.toLowerCase().split('-')[0]
    if (language === 'en' || language === 'zh') return language
  }
  return 'en'
}

export function widgetLocaleRequest(query: unknown, path: string): string {
  if (typeof query === 'string' && query.length > 0 && query.length <= 100) return query
  // Preserve existing integrations that explicitly selected the Chinese route.
  return path.startsWith('/zh/') ? 'zh' : 'auto'
}

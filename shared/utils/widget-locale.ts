// Widget-only translations in i18n/widget. A host must ask for one with an explicit
// locale: `auto` keeps resolving to English or Chinese.
export const WIDGET_TRANSLATIONS = ['de', 'es', 'fr', 'it', 'pt'] as const
export type WidgetTranslation = typeof WIDGET_TRANSLATIONS[number]
export type WidgetLanguage = 'en' | 'zh' | WidgetTranslation
export const isWidgetTranslation = (language: string): language is WidgetTranslation =>
  (WIDGET_TRANSLATIONS as readonly string[]).includes(language)

export function resolveWidgetLocale(input: string, languages: readonly string[]): WidgetLanguage {
  for (const candidate of input === 'auto' ? languages : [input]) {
    const language = candidate.toLowerCase().split('-')[0] ?? ''
    if (language === 'en' || language === 'zh') return language
    if (input !== 'auto' && isWidgetTranslation(language)) return language
  }
  return 'en'
}

export function widgetLocaleRequest(query: unknown, path: string): string {
  if (typeof query === 'string' && query.length > 0 && query.length <= 100) return query
  // Preserve existing integrations that explicitly selected the Chinese route.
  return path.startsWith('/zh/') ? 'zh' : 'auto'
}

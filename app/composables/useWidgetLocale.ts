import { resolveWidgetLocale, widgetLocaleRequest } from '#layers/feedlog/shared/utils/widget-locale'
import type { WidgetLanguage } from '#layers/feedlog/shared/utils/widget-locale'
import type { Ref } from 'vue'

export function useWidgetLocale(override: Ref<WidgetLanguage | undefined>) {
  const route = useRoute()
  const { locale, loadLocaleMessages } = useI18n()
  const request = computed(() => override.value ?? widgetLocaleRequest(route.query.locale, route.path))
  useHead({ htmlAttrs: { lang: () => locale.value === 'zh' ? 'zh-CN' : 'en' } })
  let sequence = 0

  async function apply() {
    const current = ++sequence
    const language = resolveWidgetLocale(request.value, navigator.languages?.length ? navigator.languages : [navigator.language])
    await loadLocaleMessages(language)
    // A slower language download must not overwrite a newer host instruction.
    if (current !== sequence) return
    locale.value = language
  }

  const update = () => { void apply().catch(() => console.warn('[widget] Language messages could not be loaded')) }
  watch(request, update)
  onBeforeUnmount(() => {
    sequence++
    window.removeEventListener('languagechange', update)
  })
  return {
    init: async () => {
      window.addEventListener('languagechange', update)
      await apply().catch(() => console.warn('[widget] Language messages could not be loaded'))
    },
  }
}

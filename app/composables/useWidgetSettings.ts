import type { ResolvedWidgetSettings } from '#layers/feedlog/shared/utils/widget-settings'
import type { WidgetCustomRule } from '#layers/feedlog/shared/constants/widget-rules'
import type { UpdateWidgetSettingsInput } from '#layers/feedlog/shared/schemas/widget'

export type WidgetSettingsResponse = ResolvedWidgetSettings & { baseUrl: string }

export type WidgetSettingsPatch = UpdateWidgetSettingsInput

// Included rule lists replace the stored lists, so callers must send the whole
// list for each included field, rather than only the rules they changed.
export function useWidgetSettings() {
  const settings = ref<WidgetSettingsResponse | null>(null)
  const loading = ref(true)
  const saving = ref(false)
  const error = ref<string | null>(null)

  async function refresh() {
    loading.value = true
    error.value = null
    try {
      settings.value = await $fetch<WidgetSettingsResponse>('/api/admin/widget')
    }
    catch (e) {
      error.value = (e as { data?: { message?: string } })?.data?.message || 'Failed to load widget settings'
    }
    finally {
      loading.value = false
    }
  }

  // Returns the server's message on failure so the caller can surface the
  // specific rule-cap or validation error rather than a generic one.
  async function save(patch: WidgetSettingsPatch): Promise<string | null> {
    saving.value = true
    try {
      settings.value = await $fetch<WidgetSettingsResponse>('/api/admin/widget', {
        method: 'PATCH',
        body: patch,
      })
      return null
    }
    catch (e) {
      return (e as { data?: { message?: string } })?.data?.message || 'Failed to save'
    }
    finally {
      saving.value = false
    }
  }

  // The API keeps built-ins and custom rules apart because they are stored
  // differently; the UI shows one list, so flatten here. Built-ins carry no
  // editable text — only a toggle.
  const { locale } = useI18n()
  const allRules = computed(() => {
    const s = settings.value
    if (!s) return []
    // Built-ins ship in both languages; a custom rule is shown as the admin
    // typed it, in either locale — their own prompt text is never translated.
    const zh = locale.value.startsWith('zh')
    return [
      ...s.rules.builtins.map(b => ({
        id: b.id,
        scenario: zh ? b.scenarioZh : b.scenario,
        enabled: b.enabled,
        builtin: true,
      })),
      ...s.rules.custom.map(c => ({ id: c.id, scenario: c.scenario, enabled: c.enabled, builtin: false })),
    ]
  })

  // The API stores these lists separately. The assistant settings card combines
  // both patches so its rule edits are saved together with the other fields.
  type FlatRule = { id: string; scenario: string; enabled: boolean; builtin: boolean }

  function builtinsPatch(rules: FlatRule[]): WidgetSettingsPatch {
    return { disabledBuiltins: rules.filter(r => r.builtin && !r.enabled).map(r => r.id) }
  }

  function customPatch(rules: FlatRule[]): WidgetSettingsPatch {
    return {
      customRules: rules.filter(r => !r.builtin).map(r => ({
        // A rule the admin just added has a temporary client id; the server
        // assigns the real one.
        id: r.id.startsWith('new-') ? undefined : r.id,
        scenario: r.scenario,
        enabled: r.enabled,
      })) as WidgetCustomRule[],
    }
  }

  return { settings, loading, saving, error, refresh, save, allRules, builtinsPatch, customPatch }
}

import type { ResolvedWidgetSettings } from '~~/shared/utils/widget-settings'
import type { WidgetCustomRule } from '~~/shared/constants/widget-rules'

export type WidgetSettingsResponse = ResolvedWidgetSettings & { baseUrl: string }

export interface WidgetSettingsPatch {
  enabled?: boolean
  supportEmail?: string
  disabledBuiltins?: string[]
  customRules?: { id?: string; scenario: string; enabled: boolean }[]
}

// Client-side state for /dashboard/settings/widget, backed by /api/admin/widget.
// Every save posts the whole rule list rather than a diff — the endpoint merges
// against the stored row, so a partial body would silently keep stale rules.
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

  // Rebuilds both halves of the payload from the flattened list.
  function toPatch(rules: { id: string; scenario: string; enabled: boolean; builtin: boolean }[]): WidgetSettingsPatch {
    return {
      disabledBuiltins: rules.filter(r => r.builtin && !r.enabled).map(r => r.id),
      customRules: rules.filter(r => !r.builtin).map(r => ({
        // A rule the admin just added has a temporary client id; the server
        // assigns the real one.
        id: r.id.startsWith('new-') ? undefined : r.id,
        scenario: r.scenario,
        enabled: r.enabled,
      })) as WidgetCustomRule[],
    }
  }

  return { settings, loading, saving, error, refresh, save, allRules, toPatch }
}

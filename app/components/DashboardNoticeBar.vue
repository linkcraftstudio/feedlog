<script setup lang="ts">
import { dashboardNoticeSources, DEFAULT_NOTICE_DISMISS_MS, type DashboardNotice } from '#layers/feedlog/app/utils/dashboard-notices'

// One notice at a time above every dashboard page: the highest priority among the registered notices that are not
// dismissed. Dismissals are per user and browser, kept in localStorage until they expire.
const { t } = useI18n()
const { data: session } = useAuthSession()
const storageKey = computed(() => `feedlog.dashboardNotices.dismissed.${session.value?.user?.id ?? 'anon'}`)
const dismissed = ref<Record<string, number>>({})
// Sources are registered on the client only; rendering after mount keeps hydration consistent.
const mounted = ref(false)

function readDismissed() {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey.value) ?? '{}') as Record<string, number>
    const now = Date.now()
    dismissed.value = Object.fromEntries(Object.entries(raw).filter(([, until]) => typeof until === 'number' && until > now))
  }
  catch { dismissed.value = {} }
}
onMounted(() => { readDismissed(); mounted.value = true })
watch(storageKey, () => { if (mounted.value) readDismissed() })

const notice = computed<DashboardNotice | null>(() => {
  if (!mounted.value) return null
  const now = Date.now()
  const all = dashboardNoticeSources().flatMap(source => source())
  return all
    .filter(n => !(dismissed.value[n.id]! > now))
    .sort((a, b) => b.priority - a.priority)[0] ?? null
})

function dismiss(n: DashboardNotice) {
  dismissed.value = { ...dismissed.value, [n.id]: Date.now() + (n.dismissFor ?? DEFAULT_NOTICE_DISMISS_MS) }
  try { localStorage.setItem(storageKey.value, JSON.stringify(dismissed.value)) }
  catch { /* Hidden for this page view only. */ }
}

const TONES: Record<DashboardNotice['level'], string> = {
  info: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300',
  warning: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  danger: 'border-destructive/25 bg-destructive/5 text-destructive',
}
const ICONS: Record<DashboardNotice['level'], string> = { info: 'lucide:info', warning: 'lucide:triangle-alert', danger: 'lucide:circle-alert' }
const BUTTON = 'h-8 px-3 rounded-lg text-xs font-semibold inline-flex items-center justify-center transition-colors'
const VARIANTS = {
  primary: 'bg-primary text-primary-foreground font-heading font-bold hover:opacity-90',
  secondary: 'border border-border bg-background text-foreground hover:bg-secondary',
}
</script>

<template>
  <div v-if="notice" role="status" class="flex items-center gap-3 border-b px-4 py-2 text-xs" :class="TONES[notice.level]" :data-notice="notice.id">
    <Icon :name="notice.icon ?? ICONS[notice.level]" size="14" class="shrink-0" />
    <p class="flex-1 font-semibold">{{ notice.text }}</p>
    <button v-for="action in notice.actions ?? []" :key="action.label" type="button" :class="[BUTTON, VARIANTS[action.variant ?? 'secondary']]" @click="action.onClick()">{{ action.label }}</button>
    <button type="button" class="w-8 h-8 rounded-md hover:bg-secondary transition-colors flex items-center justify-center text-muted-foreground" :aria-label="t('dashboard.notices.dismiss')" @click="dismiss(notice)"><Icon name="lucide:x" size="16" /></button>
  </div>
</template>

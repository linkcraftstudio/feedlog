<script setup lang="ts">
import type { MemberPreferenceResponse } from '#layers/feedlog/shared/schemas/member-preference'

// Keep the email destination during sign-in; the shared login modal stays on this URL.
definePageMeta({ layout: false })

const { data: session } = await useAuthSession()
const { hasAccount } = useGuestSession()
const ctx = useOrgContext()
const { open: openLogin } = useLoginModal()
const localePath = useLocalePath()
const route = useRoute()
const { t } = useI18n()
const isMember = computed(() => hasAccount.value && !!ctx.value.role)
const scope = computed(() => isMember.value ? `${ctx.value.orgId}:${session.value?.user.id}` : '')
const preferences = ref<MemberPreferenceResponse | null>(null)
const enabled = ref(false)
const state = ref<'loading' | 'ready' | 'saving' | 'saved' | 'loadError' | 'saveError' | 'unknown'>('loading')
const busy = computed(() => state.value === 'loading' || state.value === 'saving')
const dirty = computed(() => !!preferences.value && enabled.value !== preferences.value.notifications.staff_feedback_email_enabled)
let generation = 0
let mounted = false
let savedTimer: ReturnType<typeof setTimeout> | undefined

function applyPreferences(value: MemberPreferenceResponse) {
  preferences.value = value
  enabled.value = value.notifications.staff_feedback_email_enabled
}

function showSaved() {
  state.value = 'saved'
  savedTimer = setTimeout(() => { state.value = 'ready' }, 2500)
}

async function load() {
  if (!scope.value) return
  const current = ++generation
  clearTimeout(savedTimer)
  state.value = 'loading'
  preferences.value = null
  try {
    const value = await useApiFetch<MemberPreferenceResponse>('/api/me/preferences', { retry: 0, timeout: 10000 })
    if (current !== generation) return
    applyPreferences(value)
    state.value = 'ready'
  }
  catch {
    if (current === generation) state.value = 'loadError'
  }
}

function setEnabled(value: boolean) {
  if (busy.value) return
  clearTimeout(savedTimer)
  enabled.value = value
  state.value = 'ready'
}

function reset() {
  if (preferences.value && !busy.value) setEnabled(preferences.value.notifications.staff_feedback_email_enabled)
}

async function save() {
  if (!dirty.value || busy.value) return
  const current = ++generation
  const value = enabled.value
  clearTimeout(savedTimer)
  state.value = 'saving'
  try {
    const result = await useApiFetch<MemberPreferenceResponse>('/api/me/preferences', {
      method: 'PATCH',
      body: { notifications: { staff_feedback_email_enabled: value } },
      retry: 0,
      timeout: 10000,
    })
    if (current !== generation) return
    applyPreferences(result)
    showSaved()
  }
  catch (error) {
    if (current !== generation) return
    const status = (error as { statusCode?: number }).statusCode ?? 0
    if (status >= 400 && status < 500 && status !== 408) {
      state.value = 'saveError'
      return
    }
    // A lost response may follow a successful write. Read back before claiming either outcome.
    try {
      const result = await useApiFetch<MemberPreferenceResponse>('/api/me/preferences', { retry: 0, timeout: 10000 })
      if (current !== generation) return
      preferences.value = result
      if (result.notifications.staff_feedback_email_enabled === value) showSaved()
      else state.value = 'saveError'
    }
    catch {
      if (current !== generation) return
      preferences.value = null
      state.value = 'unknown'
    }
  }
}

watch(scope, () => {
  ++generation
  clearTimeout(savedTimer)
  preferences.value = null
  state.value = 'loading'
  if (mounted) void load()
}, { immediate: true, flush: 'sync' })

function redirectLegacyAccountLink() {
  const { hash, query } = route
  if (!isMember.value || !['#edit-profile', '#change-password'].includes(hash)) return false
  void navigateTo(localePath({ path: '/dashboard/settings/profile', query, hash }), { replace: true })
  return true
}

watch([() => route.hash, isMember], () => {
  if (mounted) redirectLegacyAccountLink()
}, { flush: 'post' })

// Wait for the async layout to hydrate before replacing its loading content.
onMounted(() => {
  mounted = true
  if (!redirectLegacyAccountLink()) void load()
})

onScopeDispose(() => {
  ++generation
  clearTimeout(savedTimer)
})
useHead({ title: () => t('settings.personal.notifications') })
</script>

<template>
  <NuxtLayout :name="isMember ? 'dashboard' : 'default'">
    <div v-if="isMember" class="flex flex-col h-full">
      <header class="dashboard-panel-page-header">
        <div>
          <h2 class="font-heading text-lg font-bold">{{ $t('settings.personal.notifications') }}</h2>
          <p class="text-xs text-muted-foreground">
            {{ preferences ? $t('settings.personal.subtitle', { name: preferences.organization.name }) : $t('settings.personal.scope') }}
          </p>
        </div>
      </header>

      <div class="flex-1 overflow-y-auto">
        <div class="dashboard-panel-container dashboard-panel-stack">
          <section class="dashboard-panel overflow-hidden" :aria-busy="busy">
            <div class="dashboard-panel-header border-b border-border">
              <h3 class="font-heading font-bold text-sm">{{ $t('settings.personal.emailNotifications') }}</h3>
              <p class="text-xs text-muted-foreground mt-0.5">{{ $t('settings.personal.notificationsDesc') }}</p>
            </div>
            <div class="dashboard-panel-body space-y-6">
              <p v-if="state === 'loading'" role="status" class="text-sm text-muted-foreground flex items-center gap-2">
                <Icon name="lucide:loader-circle" size="16" class="animate-spin" />
                {{ $t('settings.loading') }}
              </p>
              <div v-else-if="!preferences" class="space-y-3">
                <p role="alert" class="text-sm text-destructive">{{ $t(`settings.personal.${state === 'unknown' ? 'unknown' : 'loadError'}`) }}</p>
                <Button variant="outline" size="sm" @click="load">{{ $t('settings.personal.retry') }}</Button>
              </div>
              <template v-else>
                <div class="flex items-start justify-between gap-5">
                  <div class="min-w-0">
                    <label for="staff-feedback-email" class="block text-sm font-semibold cursor-pointer">{{ $t('settings.personal.feedbackEmail') }}</label>
                    <p id="staff-feedback-email-description" class="mt-1 text-xs text-muted-foreground leading-relaxed">{{ $t('settings.personal.feedbackEmailDesc') }}</p>
                    <p class="mt-3 text-xs"><span class="text-muted-foreground">{{ $t('settings.personal.email') }}</span> <span class="inline-block max-w-full break-all align-top">{{ preferences.email }}</span></p>
                  </div>
                  <Switch
                    id="staff-feedback-email"
                    class="mt-0.5"
                    :model-value="enabled"
                    :disabled="busy"
                    aria-describedby="staff-feedback-email-description"
                    @update:model-value="setEnabled"
                  />
                </div>
                <div class="text-xs text-muted-foreground leading-relaxed">
                  <p>{{ $t('settings.personal.onlyMe') }}</p>
                  <p>{{ $t('settings.personal.essentialEmails') }}</p>
                  <p v-if="preferences.role === 'contributor'" class="mt-2">{{ $t('settings.personal.contributor') }}</p>
                </div>
              </template>
            </div>
            <div v-if="preferences" class="dashboard-panel-footer border-t border-border bg-muted/30 flex flex-wrap items-center justify-end gap-3">
              <p aria-live="polite" class="text-xs flex items-center gap-1.5 mr-auto" :class="state === 'saveError' ? 'text-destructive' : 'text-muted-foreground'">
                <template v-if="state === 'saveError'">
                  <Icon name="lucide:alert-circle" size="13" class="shrink-0" />
                  {{ $t('settings.personal.saveError') }}
                </template>
                <template v-else-if="state === 'saved'">
                  <Icon name="lucide:check" size="13" />
                  {{ $t('settings.personal.saved') }}
                </template>
                <template v-else-if="dirty">{{ $t('settings.unsavedChanges') }}</template>
              </p>
              <div class="flex items-center gap-2 ml-auto">
                <button v-if="dirty" :disabled="busy" class="h-9 px-4 rounded-lg border border-border bg-background text-xs font-semibold hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-colors" @click="reset">
                  {{ $t('settings.reset') }}
                </button>
                <button :disabled="!dirty || busy" class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all" @click="save">
                  {{ busy ? $t('settings.saving') : $t('settings.saveChanges') }}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
    <section v-else class="max-w-md mx-auto my-12 p-6 rounded-xl border border-border bg-card space-y-4">
      <h1 class="font-heading text-lg font-bold">{{ $t('settings.personal.notifications') }}</h1>
      <p class="text-sm text-muted-foreground">{{ $t(hasAccount ? 'settings.personal.membersOnly' : 'settings.personal.signInPrompt') }}</p>
      <Button v-if="!hasAccount" @click="openLogin()">{{ $t('common.signIn') }}</Button>
      <Button v-else variant="outline" as-child><NuxtLink :to="localePath('/')">{{ $t('common.goHome') }}</NuxtLink></Button>
    </section>
  </NuxtLayout>
</template>

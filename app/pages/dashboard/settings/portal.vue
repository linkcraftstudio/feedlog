<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { mergeBrandingMetadata, type OrgMetadataInput, parseBranding } from '#layers/feedlog/shared/utils/branding'
import { mergePortalModulesMetadata, resolvePortalModules } from '#layers/feedlog/shared/utils/portal-modules'
import { mergePortalAuthMetadata, parsePortalAuthConfig, validateExternalAuthUrl } from '#layers/feedlog/shared/utils/external-auth'

definePageMeta({ layout: 'dashboard', middleware: ['admin'] })

const { t } = useI18n()
const { onUploadImg } = useUploadImg()
const ctx = useOrgContext()
const orgId = computed(() => ctx.value.orgId)
const isOwner = computed(() => ctx.value.role === 'owner')

interface OrgRow {
  id: string
  name: string
  slug: string
  logo: string | null
  metadata: OrgMetadataInput
}

const org = ref<OrgRow | null>(null)
const loading = ref(true)
const saving = ref(false)
const authSaving = ref(false)
const error = ref<string | null>(null)
const authError = ref<string | null>(null)
const form = reactive({
  welcomeTitle: '',
  welcomeDescription: '',
})
const authForm = reactive({
  loginUrl: '',
  signupUrl: '',
})

const { data: helpStats } = await useFetch<{ collectionCount: number; articleCount: number }>('/api/admin/help/stats')
const helpCenterAvailable = computed(() => (helpStats.value?.collectionCount ?? 0) > 0)
const helpCenterOn = computed({
  get: () => resolvePortalModules(org.value?.metadata).helpCenter,
  set: value => void toggleHelpCenter(value),
})

async function toggleHelpCenter(value: boolean) {
  if (!org.value) return
  const metadata = mergePortalModulesMetadata(org.value.metadata, { helpCenter: value })
  try {
    await authClient.organization.update({ organizationId: org.value.id, data: { metadata } })
    await loadOrg()
  }
  catch {
    error.value = t('settings.portal.saveFailed')
  }
}

const toolbars = ['bold', 'italic', 'strikeThrough', '-', 'title', 'unorderedList', 'orderedList', '-', 'link', 'code', 'codeRow', 'table']

async function loadOrg() {
  if (!ctx.value.role) return
  loading.value = true
  try {
    const res = await authClient.organization.getFullOrganization({ query: { organizationId: orgId.value } })
    org.value = (res as { data?: OrgRow }).data ?? null
    if (org.value) {
      const branding = parseBranding(org.value.metadata)
      form.welcomeTitle = branding.welcomeTitle ?? ''
      form.welcomeDescription = branding.welcomeDescription ?? ''
      const portalAuth = parsePortalAuthConfig(org.value.metadata)
      authForm.loginUrl = portalAuth.loginUrl ?? ''
      authForm.signupUrl = portalAuth.signupUrl ?? ''
    }
  } finally {
    loading.value = false
  }
}

// Load on the client only. The dashboard sits behind auth (nothing to SSR for
// SEO) and the better-auth client is browser-oriented; fetching during SSR would
// bake the loaded section into the HTML while the client hydrates from the empty
// initial state, tripping a hydration mismatch.
watch(() => [orgId.value, ctx.value.role] as const, ([, role]) => {
  if (role && import.meta.client) void loadOrg()
}, { immediate: true })

const currentBranding = computed(() => parseBranding(org.value?.metadata))
const dirty = computed(() => {
  return form.welcomeTitle !== (currentBranding.value.welcomeTitle ?? '')
    || form.welcomeDescription !== (currentBranding.value.welcomeDescription ?? '')
})
const canSave = computed(() => !!org.value && isOwner.value && dirty.value && !saving.value)
const currentPortalAuth = computed(() => parsePortalAuthConfig(org.value?.metadata))
const authDirty = computed(() => {
  return authForm.loginUrl.trim() !== (currentPortalAuth.value.loginUrl ?? '')
    || authForm.signupUrl.trim() !== (currentPortalAuth.value.signupUrl ?? '')
})
const authUrlsValid = computed(() => {
  return (!authForm.loginUrl.trim() || !!validateExternalAuthUrl(authForm.loginUrl))
    && (!authForm.signupUrl.trim() || !!validateExternalAuthUrl(authForm.signupUrl))
})
const canSaveAuth = computed(() => !!org.value && isOwner.value && authDirty.value && authUrlsValid.value && !authSaving.value)

function reset() {
  form.welcomeTitle = currentBranding.value.welcomeTitle ?? ''
  form.welcomeDescription = currentBranding.value.welcomeDescription ?? ''
  error.value = null
}

async function save() {
  if (!org.value || !canSave.value) return
  saving.value = true
  error.value = null
  try {
    const metadata = mergeBrandingMetadata(org.value.metadata, {
      ...currentBranding.value,
      welcomeTitle: form.welcomeTitle.trim(),
      welcomeDescription: form.welcomeDescription.trim(),
    })
    await authClient.organization.update({
      organizationId: org.value.id,
      data: { metadata },
    })
    await loadOrg()
  } catch {
    error.value = t('settings.portal.saveFailed')
  } finally {
    saving.value = false
  }
}

function resetAuth() {
  authForm.loginUrl = currentPortalAuth.value.loginUrl ?? ''
  authForm.signupUrl = currentPortalAuth.value.signupUrl ?? ''
  authError.value = null
}

async function saveAuth() {
  if (!org.value || !canSaveAuth.value) return
  authSaving.value = true
  authError.value = null
  try {
    const metadata = mergePortalAuthMetadata(org.value.metadata, {
      loginUrl: authForm.loginUrl,
      signupUrl: authForm.signupUrl,
    })
    await authClient.organization.update({
      organizationId: org.value.id,
      data: { metadata },
    })
    await loadOrg()
  }
  catch {
    authError.value = t('settings.portal.authSaveFailed')
  }
  finally {
    authSaving.value = false
  }
}
</script>

<template>
  <div class="flex flex-col h-full">
    <header class="h-16 px-6 border-b border-border flex items-center shrink-0 bg-card">
      <div>
        <h2 class="font-heading text-lg font-bold">{{ $t('settings.portal.title') }}</h2>
        <p class="text-xs text-muted-foreground">{{ $t('settings.portal.subtitle') }}</p>
      </div>
    </header>

    <div class="flex-1 overflow-y-auto">
      <div class="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <template v-if="loading">
          <p class="text-sm text-muted-foreground">{{ $t('settings.loading') }}</p>
        </template>

        <section v-if="!loading && org" class="rounded-xl border border-border bg-card overflow-hidden">
          <div class="px-6 py-5 border-b border-border">
            <h3 class="font-heading font-bold text-sm">{{ $t('settings.portal.modulesSection') }}</h3>
            <p class="text-xs text-muted-foreground mt-0.5">{{ $t('settings.portal.modulesDesc') }}</p>
          </div>
          <div class="flex items-center gap-4 px-6 py-[18px]">
            <span class="flex-1 min-w-0">
              <span class="block text-sm font-bold leading-5">{{ $t('settings.portal.moduleHelpCenter') }}</span>
              <span class="block mt-[3px] text-xs leading-4 text-muted-foreground">
                {{ helpCenterAvailable ? $t('settings.portal.moduleHelpCenterOn') : $t('settings.portal.moduleHelpCenterEmpty') }}
              </span>
            </span>
            <Switch v-model="helpCenterOn" :disabled="!helpCenterAvailable" />
          </div>
        </section>

        <section v-if="!loading && org" class="rounded-xl border border-border bg-card overflow-hidden">
          <div class="px-6 py-5 border-b border-border">
            <h3 class="font-heading font-bold text-sm">{{ $t('settings.portal.authSection') }}</h3>
            <p class="text-xs text-muted-foreground mt-0.5">{{ $t('settings.portal.authDesc') }}</p>
          </div>
          <div class="px-6 py-6 space-y-5">
            <div>
              <label for="portal-login-url" class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('settings.portal.loginUrlLabel') }}</label>
              <input
                id="portal-login-url"
                v-model="authForm.loginUrl"
                type="url"
                inputmode="url"
                autocomplete="url"
                placeholder="https://app.example.com/login"
                :disabled="!isOwner"
                class="mt-2 w-full h-11 px-3.5 rounded-lg border border-border bg-background text-sm focus:outline-none focus:border-primary transition-colors disabled:opacity-60"
              >
            </div>
            <div>
              <label for="portal-signup-url" class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('settings.portal.signupUrlLabel') }}</label>
              <input
                id="portal-signup-url"
                v-model="authForm.signupUrl"
                type="url"
                inputmode="url"
                autocomplete="url"
                placeholder="https://app.example.com/signup"
                :disabled="!isOwner"
                class="mt-2 w-full h-11 px-3.5 rounded-lg border border-border bg-background text-sm focus:outline-none focus:border-primary transition-colors disabled:opacity-60"
              >
            </div>
            <p class="text-[11px] text-muted-foreground leading-relaxed">{{ $t('settings.portal.authHint') }}</p>
            <p v-if="authDirty && !authUrlsValid" role="alert" class="text-xs text-destructive">{{ $t('settings.portal.authInvalidUrl') }}</p>
          </div>
          <div class="px-6 py-3 border-t border-border bg-muted/30 flex items-center justify-end gap-3">
            <p v-if="authError" class="text-xs text-red-600 flex items-center gap-1.5 min-w-0 truncate mr-auto">
              <Icon name="lucide:alert-circle" size="13" class="shrink-0" />
              {{ authError }}
            </p>
            <button
              v-if="authDirty"
              class="h-9 px-4 rounded-lg border border-border bg-background text-xs font-semibold hover:bg-secondary transition-colors"
              :disabled="authSaving"
              @click="resetAuth"
            >
              {{ $t('settings.reset') }}
            </button>
            <button
              :disabled="!canSaveAuth"
              class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              @click="saveAuth"
            >
              {{ authSaving ? $t('settings.saving') : $t('settings.saveChanges') }}
            </button>
          </div>
        </section>

        <section v-if="!loading && org" class="rounded-xl border border-border bg-card overflow-hidden">
          <div class="px-6 py-5 border-b border-border">
            <h3 class="font-heading font-bold text-sm">{{ $t('settings.portal.welcomeSection') }}</h3>
            <p class="text-xs text-muted-foreground mt-0.5">{{ $t('settings.portal.welcomeDesc') }}</p>
          </div>

          <div class="px-6 py-6 space-y-6">
            <div>
              <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('settings.portal.titleLabel') }}</label>
              <input
                v-model="form.welcomeTitle"
                type="text"
                :placeholder="$t('settings.portal.titlePlaceholder', { name: org.name })"
                :disabled="!isOwner"
                class="mt-2 w-full h-11 px-3.5 rounded-lg border border-border bg-background text-sm focus:outline-none focus:border-primary transition-colors disabled:opacity-60"
              >
              <p class="text-[11px] text-muted-foreground mt-1.5">{{ $t('settings.portal.titleHint') }}</p>
            </div>

            <div>
              <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('settings.portal.descriptionLabel') }}</label>
              <ClientOnly>
                <ThemedMdEditor
                  v-model="form.welcomeDescription"
                  language="en-US"
                  :placeholder="$t('settings.portal.descriptionPlaceholder')"
                  :preview="false"
                  :max-length="10000"
                  :toolbars="toolbars"
                  :footers="[]"
                  :disabled="!isOwner"
                  :style="{ height: '220px' }"
                  class="mt-2 !rounded-lg"
                  @on-upload-img="onUploadImg"
                />
                <template #fallback>
                  <div class="mt-2 h-[220px] rounded-lg border border-border bg-background grid place-items-center text-xs text-muted-foreground">{{ $t('settings.portal.loadingEditor') }}</div>
                </template>
              </ClientOnly>
              <p class="text-[11px] text-muted-foreground mt-1.5">{{ $t('settings.portal.descriptionHint') }}</p>
            </div>

            <div class="pt-4 border-t border-border">
              <p class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">{{ $t('settings.preview') }}</p>
              <div class="rounded-lg bg-muted/30 p-4">
                <PortalWelcomeBlock
                  :title="form.welcomeTitle"
                  :description="form.welcomeDescription"
                />
              </div>
            </div>
          </div>

          <div class="px-6 py-3 border-t border-border bg-muted/30 flex items-center justify-end gap-3">
            <p v-if="error" class="text-xs text-red-600 flex items-center gap-1.5 min-w-0 truncate mr-auto">
              <Icon name="lucide:alert-circle" size="13" class="shrink-0" />
              {{ error }}
            </p>
            <button
              v-if="dirty"
              class="h-9 px-4 rounded-lg border border-border bg-background text-xs font-semibold hover:bg-secondary transition-colors"
              :disabled="saving"
              @click="reset"
            >
              {{ $t('settings.reset') }}
            </button>
            <button
              :disabled="!canSave"
              class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              @click="save"
            >
              {{ saving ? $t('settings.saving') : $t('settings.saveChanges') }}
            </button>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

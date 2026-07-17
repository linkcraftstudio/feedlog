<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { resolveAttachmentUrl } from '~/utils/attachment'
import {
  DEFAULT_BRAND_COLOR,
  mergeBrandingMetadata,
  normalizeBrandHex,
  type OrgMetadataInput,
  parseBranding,
  portalThemeSchema,
} from '#layers/feedlog/shared/utils/branding'

interface OrgRow {
  id: string
  name: string
  slug: string
  logo: string | null
  metadata: OrgMetadataInput
}

const props = defineProps<{
  org: OrgRow
  isOwner: boolean
  // Layout variant. 'stacked' (default) is a single column, used by the OSS
  // workspace settings; 'split' puts controls in a compact left column and the
  // preview in a wider right column, used by the SaaS organization settings card.
  layout?: 'stacked' | 'split'
}>()

const layoutMode = computed(() => props.layout ?? 'stacked')

const emit = defineEmits<{
  saved: []
}>()

const { t } = useI18n()
const presets = ['#C45A46', '#2563EB', '#7C3AED', '#059669', '#DB2777', '#0F172A']
const themeOptions = computed(() => [
  { value: 'system' as const, label: t('settings.branding.theme.system'), icon: 'lucide:monitor' },
  { value: 'light' as const, label: t('settings.branding.theme.light'), icon: 'lucide:sun' },
  { value: 'dark' as const, label: t('settings.branding.theme.dark'), icon: 'lucide:moon' },
])

const fileInput = ref<HTMLInputElement | null>(null)
const saving = ref(false)
const uploading = ref(false)
const error = ref<string | null>(null)
const previewMode = ref<'light' | 'dark'>('light')

const form = reactive({
  logo: null as string | null,
  primaryColor: DEFAULT_BRAND_COLOR,
  defaultTheme: 'system' as 'system' | 'light' | 'dark',
})

function hydrate() {
  const branding = parseBranding(props.org.metadata)
  form.logo = props.org.logo
  form.primaryColor = normalizeBrandHex(branding.primaryColor)
  form.defaultTheme = branding.defaultTheme ?? 'system'
  previewMode.value = form.defaultTheme === 'dark' ? 'dark' : 'light'
  error.value = null
}

watch(() => props.org, hydrate, { immediate: true })

// Picking a default theme drives the preview so the admin immediately sees that
// mode rendered. Deliberately one-way: toggling the preview is a transient
// look-around and must never write back to the saved default theme. System has
// no single rendering, so it previews as light (the conventional baseline).
watch(() => form.defaultTheme, (theme) => {
  previewMode.value = theme === 'dark' ? 'dark' : 'light'
})

const logoUrl = computed(() => resolveAttachmentUrl(form.logo))
// Domain shown in the preview's mock browser address bar: the host this dashboard
// is served from, which is where the portal lives too in a single-host deployment.
// Mirrors the real address a visitor would see instead of a hardcoded brand domain.
const previewDomain = computed(() => useRequestURL().host)
const currentBranding = computed(() => parseBranding(props.org.metadata))
const dirty = computed(() => {
  return form.logo !== props.org.logo
    || normalizeBrandHex(form.primaryColor) !== normalizeBrandHex(currentBranding.value.primaryColor)
    || form.defaultTheme !== (currentBranding.value.defaultTheme ?? 'system')
})
const canSave = computed(() => props.isOwner && dirty.value && !saving.value && !uploading.value)

async function uploadLogo(file: File) {
  uploading.value = true
  error.value = null
  try {
    const body = new FormData()
    body.append('file', file)
    const result = await $fetch<{ key: string }>('/api/upload', { method: 'POST', body })
    form.logo = result.key
  } catch {
    error.value = t('settings.branding.uploadFailed')
  } finally {
    uploading.value = false
  }
}

function onFileChange(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) void uploadLogo(file)
  if (fileInput.value) fileInput.value.value = ''
}

async function save() {
  if (!canSave.value) return
  saving.value = true
  error.value = null
  try {
    const metadata = mergeBrandingMetadata(props.org.metadata, {
      ...currentBranding.value,
      primaryColor: normalizeBrandHex(form.primaryColor),
      defaultTheme: portalThemeSchema.parse(form.defaultTheme),
    })
    await authClient.organization.update({
      organizationId: props.org.id,
      data: {
        // better-auth's update rejects a null logo (expects string); send ''
        // to clear, which the portal/switcher already treat as "no logo".
        logo: form.logo ?? '',
        metadata,
      },
    })
    emit('saved')
  } catch {
    error.value = t('settings.branding.saveFailed')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="rounded-xl border border-border bg-card overflow-hidden">
    <div class="px-6 py-5 border-b border-border">
      <h3 class="font-heading font-bold text-sm">{{ $t('settings.branding.title') }}</h3>
      <p class="text-xs text-muted-foreground mt-0.5">{{ $t('settings.branding.subtitle') }}</p>
    </div>

    <div class="px-6 py-6">
      <!-- split: controls take a compact fixed left column; the preview gets the
           remaining width (it scales to its container, so a wider column = a
           larger, more faithful preview). stacked falls back to a single column. -->
      <div :class="layoutMode === 'split' ? 'grid lg:grid-cols-[270px_minmax(0,1fr)] gap-6 items-start' : 'space-y-6'">
        <div class="space-y-6">
          <!-- Logo -->
          <div>
            <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('settings.branding.logo') }}</label>
            <div class="mt-2 flex items-center gap-4">
              <input ref="fileInput" type="file" accept="image/*" class="hidden" :disabled="!isOwner || uploading" @change="onFileChange">
              <!-- Logo doubles as the upload trigger: hover reveals an edit overlay. -->
              <button
                type="button"
                class="group relative w-16 h-16 rounded-xl border border-border bg-background grid place-items-center overflow-hidden shrink-0 disabled:cursor-not-allowed"
                :disabled="!isOwner || uploading"
                @click="fileInput?.click()"
              >
                <img v-if="logoUrl" :src="logoUrl" alt="Logo" class="w-full h-full object-contain">
                <span v-else class="font-heading font-bold text-2xl text-muted-foreground">{{ org.name.charAt(0) }}</span>
                <span
                  v-if="isOwner || uploading"
                  class="absolute inset-0 grid place-items-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"
                  :class="{ '!opacity-100': uploading }"
                >
                  <Icon :name="uploading ? 'lucide:loader-2' : 'lucide:pencil'" size="16" :class="{ 'animate-spin': uploading }" />
                </span>
              </button>
              <button
                v-if="form.logo"
                class="h-9 px-3.5 rounded-lg text-xs font-semibold text-destructive hover:bg-destructive/10 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                :disabled="!isOwner || uploading"
                @click="form.logo = null"
              >
                <Icon name="lucide:trash-2" size="14" />
                {{ $t('settings.branding.removeLogo') }}
              </button>
            </div>
            <!-- Helper on its own full-width line so it stays one line in the
                 narrow split column instead of wrapping beside the buttons. -->
            <p class="text-[11px] text-muted-foreground mt-2">{{ $t('settings.branding.logoHint') }}</p>
          </div>

          <!-- Brand color -->
          <div>
            <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('settings.branding.brandColor') }}</label>
            <div class="mt-2 flex flex-wrap items-center gap-3">
              <label class="relative w-11 h-11 rounded-lg border border-border overflow-hidden cursor-pointer shrink-0" :style="{ backgroundColor: form.primaryColor }">
                <input v-model="form.primaryColor" type="color" class="absolute inset-0 opacity-0 cursor-pointer" :disabled="!isOwner">
              </label>
              <input
                v-model="form.primaryColor"
                type="text"
                class="w-32 h-11 px-3 rounded-lg border border-border bg-background text-sm font-mono uppercase focus:outline-none focus:border-primary transition-colors disabled:opacity-60"
                :disabled="!isOwner"
              >
              <div class="flex items-center gap-1.5">
                <button
                  v-for="c in presets"
                  :key="c"
                  type="button"
                  :style="{ backgroundColor: c }"
                  class="w-7 h-7 rounded-md border border-border/60 ring-offset-2 ring-offset-card transition disabled:cursor-not-allowed"
                  :class="normalizeBrandHex(form.primaryColor) === c ? 'ring-2 ring-foreground' : ''"
                  :disabled="!isOwner"
                  @click="form.primaryColor = c"
                />
              </div>
            </div>
            <p class="text-[11px] text-muted-foreground mt-1.5">{{ $t('settings.branding.brandColorHint') }}</p>
          </div>

          <!-- Default theme -->
          <div>
            <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('settings.branding.defaultTheme') }}</label>
            <!-- flex (block-level) + w-fit so it drops below the inline <label> like
                 the Logo/Brand-color rows; inline-flex would stay on the label's line. -->
            <div class="mt-2 flex w-fit rounded-lg border border-border bg-background p-1">
              <button
                v-for="opt in themeOptions"
                :key="opt.value"
                type="button"
                class="flex items-center gap-1.5 px-3 h-8 rounded-md text-xs font-semibold transition-colors disabled:cursor-not-allowed"
                :class="form.defaultTheme === opt.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'"
                :disabled="!isOwner"
                @click="form.defaultTheme = opt.value"
              >
                <Icon :name="opt.icon" size="14" />
                {{ opt.label }}
              </button>
            </div>
            <p class="text-[11px] text-muted-foreground mt-1.5">{{ $t('settings.branding.defaultThemeHint') }}</p>
          </div>
        </div>

        <!-- Preview -->
        <div :class="layoutMode === 'split' ? '' : 'pt-2 border-t border-border'">
          <div class="flex items-center justify-between mb-2">
            <p class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('settings.preview') }}</p>
            <div class="inline-flex rounded-md border border-border bg-background p-0.5">
              <button type="button" class="w-7 h-6 rounded grid place-items-center transition-colors" :class="previewMode === 'light' ? 'bg-secondary text-primary' : 'text-muted-foreground'" @click="previewMode = 'light'">
                <Icon name="lucide:sun" size="13" />
              </button>
              <button type="button" class="w-7 h-6 rounded grid place-items-center transition-colors" :class="previewMode === 'dark' ? 'bg-secondary text-primary' : 'text-muted-foreground'" @click="previewMode = 'dark'">
                <Icon name="lucide:moon" size="13" />
              </button>
            </div>
          </div>
          <PortalMiniPreview
            :org-name="org.name"
            :logo="logoUrl"
            :primary-color="form.primaryColor"
            :dark="previewMode === 'dark'"
            :welcome-title="currentBranding.welcomeTitle"
            :welcome-description="currentBranding.welcomeDescription"
            :domain="previewDomain"
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
        @click="hydrate"
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
</template>

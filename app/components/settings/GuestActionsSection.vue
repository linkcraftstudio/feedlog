<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import type { GuestAction, ResolvedGuestAccess } from '#layers/feedlog/shared/utils/guest'
import { mergeGuestAccessMetadata, resolveGuestAccess } from '#layers/feedlog/shared/utils/guest'
import type { OrgMetadataInput } from '#layers/feedlog/shared/utils/branding'

interface OrgRow {
  id: string
  metadata: OrgMetadataInput
}

const props = defineProps<{
  org: OrgRow
  isOwner: boolean
}>()

const emit = defineEmits<{
  saved: []
}>()

const { t } = useI18n()

// Only guest posting carries a note. It is the one switch whose reach an admin
// can't infer from a page titled "organization settings": submitting is the only
// thing a visitor does in the embedded widget, so this switch alone decides
// whether the widget works at all for someone who isn't signed in.
const ROWS: { key: GuestAction; hasNote?: boolean }[] = [
  { key: 'allowPost', hasNote: true },
  { key: 'allowVote' },
  { key: 'allowComment' },
]

const form = reactive<ResolvedGuestAccess>({ allowPost: false, allowVote: false, allowComment: false })
const saving = ref(false)
const error = ref<string | null>(null)

function hydrate() {
  Object.assign(form, resolveGuestAccess(props.org.metadata))
  error.value = null
}

watch(() => props.org, hydrate, { immediate: true })

const current = computed(() => resolveGuestAccess(props.org.metadata))
const dirty = computed(() => ROWS.some(r => form[r.key] !== current.value[r.key]))
const canSave = computed(() => props.isOwner && dirty.value && !saving.value)

async function save() {
  if (!canSave.value) return
  saving.value = true
  error.value = null
  try {
    await authClient.organization.update({
      organizationId: props.org.id,
      data: { metadata: mergeGuestAccessMetadata(props.org.metadata, { ...form }) },
    })
    emit('saved')
  }
  catch {
    error.value = t('settings.guest.saveFailed')
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="rounded-xl border border-border bg-card overflow-hidden">
    <div class="px-6 py-5 border-b border-border">
      <h3 class="font-heading font-bold text-sm">{{ $t('settings.guest.title') }}</h3>
      <p class="text-xs text-muted-foreground mt-0.5">{{ $t('settings.guest.subtitle') }}</p>
    </div>

    <!-- Spacing separates the rows; a second set of rules inside the body would
         read as another level of nesting under the header's divider. -->
    <div class="px-6 py-6 space-y-7">
      <div v-for="row in ROWS" :key="row.key" class="flex items-start justify-between gap-6">
        <div class="min-w-0">
          <p class="text-sm font-bold">{{ $t(`settings.guest.${row.key}.title`) }}</p>
          <p class="text-xs text-muted-foreground mt-1 leading-relaxed">{{ $t(`settings.guest.${row.key}.desc`) }}</p>
          <p
            v-if="row.hasNote"
            class="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground/80"
          >
            <Icon name="lucide:info" size="12" class="mt-0.5 shrink-0" />
            <span>{{ $t(`settings.guest.${row.key}.note`) }}</span>
          </p>
        </div>
        <Switch v-model="form[row.key]" :disabled="!isOwner" class="mt-1 shrink-0" />
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

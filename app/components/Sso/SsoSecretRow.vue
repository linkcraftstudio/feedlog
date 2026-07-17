<script setup lang="ts">
import type { SsoSecret } from '~/composables/useSsoSecrets'

// One signing-secret row: reveal / copy / enable-disable / rename / delete.
// Secrets are encrypted-recoverable, so reveal is a plain toggle (not a
// one-time show). Rename and delete are both driven by the parent via a dialog
// (rename) / AlertDialog (delete) — this row only emits the intent.

const props = defineProps<{
  secret: SsoSecret
  justCreated?: boolean
}>()

const emit = defineEmits<{
  toggle: []
  rename: []
  delete: []
}>()

const { t } = useI18n()
const revealed = ref(props.justCreated ?? false)
const copied = ref(false)

const displayLabel = computed(() => props.secret.label || t('dashboard.sso.untitled'))

const masked = computed(() => {
  const s = props.secret.secret
  return `${'•'.repeat(24)}${s.slice(-4)}`
})

function copy() {
  navigator.clipboard?.writeText(props.secret.secret)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
</script>

<template>
  <div
    class="px-5 py-4 transition-colors"
    :class="secret.enabled ? '' : 'bg-muted/30'"
  >
    <div class="flex items-center gap-3">
      <!-- Label + meta -->
      <div class="min-w-0 w-[180px]">
        <div class="flex items-center gap-1.5">
          <p class="text-sm font-bold truncate" :class="secret.enabled ? '' : 'text-muted-foreground'">
            {{ displayLabel }}
          </p>
          <span v-if="justCreated" class="text-[10px] font-bold uppercase tracking-wider text-primary bg-secondary px-1.5 py-0.5 rounded">{{ $t('dashboard.sso.new') }}</span>
        </div>
        <p class="text-[11px] text-muted-foreground mt-0.5">{{ $t('dashboard.sso.created', { date: formatDate(secret.createdAt) }) }}</p>
      </div>

      <!-- Secret value: masked / revealed + reveal + copy -->
      <div class="flex-1 min-w-0 flex items-center gap-1.5">
        <code
          class="flex-1 min-w-0 truncate text-xs font-mono px-2.5 py-1.5 rounded-md bg-muted border border-border"
          :class="secret.enabled ? 'text-foreground' : 'text-muted-foreground'"
        >{{ revealed ? secret.secret : masked }}</code>
        <button
          class="w-8 h-8 rounded-md hover:bg-secondary transition-colors flex items-center justify-center text-muted-foreground shrink-0"
          :title="revealed ? $t('dashboard.sso.hide') : $t('dashboard.sso.reveal')"
          @click="revealed = !revealed"
        >
          <Icon :name="revealed ? 'lucide:eye-off' : 'lucide:eye'" size="14" />
        </button>
        <button
          class="w-8 h-8 rounded-md hover:bg-secondary transition-colors flex items-center justify-center shrink-0"
          :class="copied ? 'text-[var(--status-done)]' : 'text-muted-foreground'"
          :title="copied ? $t('dashboard.sso.copied') : $t('dashboard.sso.copy')"
          @click="copy"
        >
          <Icon :name="copied ? 'lucide:check' : 'lucide:copy'" size="14" />
        </button>
      </div>

      <!-- Status indicator (enable / disable action lives in the ⋯ menu) -->
      <span
        class="inline-flex items-center justify-center gap-1.5 h-6 rounded-full text-[11px] font-semibold shrink-0"
        :class="secret.enabled ? '' : 'bg-muted text-muted-foreground'"
        :style="secret.enabled
          ? 'min-width: 82px; background-color: var(--status-done-bg); color: var(--status-done)'
          : 'min-width: 82px'"
      >
        <span
          class="w-1.5 h-1.5 rounded-full"
          :style="{ backgroundColor: secret.enabled ? 'var(--status-done)' : 'var(--status-open)' }"
        />
        {{ secret.enabled ? $t('dashboard.sso.active') : $t('dashboard.sso.disabled') }}
      </span>

      <!-- More menu -->
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button class="w-8 h-8 rounded-md hover:bg-secondary transition-colors flex items-center justify-center text-muted-foreground shrink-0">
            <Icon name="lucide:more-horizontal" size="14" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-[180px]">
          <DropdownMenuItem @click="emit('rename')">
            <Icon name="lucide:pencil" size="13" class="mr-2" />
            {{ $t('dashboard.sso.rename') }}
          </DropdownMenuItem>
          <DropdownMenuItem @click="emit('toggle')">
            <Icon :name="secret.enabled ? 'lucide:pause' : 'lucide:play'" size="13" class="mr-2" />
            {{ secret.enabled ? $t('dashboard.sso.disable') : $t('dashboard.sso.enable') }}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem class="text-red-600" @click="emit('delete')">
            <Icon name="lucide:trash-2" size="13" class="mr-2" />
            {{ $t('common.delete') }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toast } from 'vue-sonner'
import type { AgentToken, AgentTokenCreated } from '~/composables/useAgentTokens'
import {
  AGENT_TOKEN_DEFAULT_DAYS,
  AGENT_TOKEN_LIMIT,
  AGENT_TOKEN_MAX_DAYS,
  type AgentTokenRole,
} from '~~/shared/constants/agent'

// /dashboard/developer/agent-tokens — mint and revoke machine credentials.
// Owner-only (the API enforces it too); other staff see a notice.
//
// Deliberately one file with the dialog inlined: unlike SSO secrets there is no
// rename mode and no second surface, so a shared child component would be one
// indirection serving a single caller.

definePageMeta({ layout: 'dashboard', middleware: ['admin'] })

const { t } = useI18n()
const ctx = useOrgContext()
const isOwner = computed(() => ctx.value.role === 'owner')

const { tokens, loading, refresh, create, setAllowDelete, remove } = useAgentTokens()

const used = computed(() => tokens.value.length)
const canCreate = computed(() => used.value < AGENT_TOKEN_LIMIT)

// Defer to onMounted: the list endpoint needs the session cookie, simplest to
// fetch client-side after mount (mirrors the SSO page).
onMounted(() => { if (isOwner.value) void refresh() })

// Create dialog.
const dialogOpen = ref(false)
const formLabel = ref('')
const formRole = ref<AgentTokenRole>('manager')
const formDays = ref(AGENT_TOKEN_DEFAULT_DAYS)
const formAllowDelete = ref(false)
const creating = ref(false)

function openCreate() {
  formLabel.value = ''
  formRole.value = 'manager'
  formDays.value = AGENT_TOKEN_DEFAULT_DAYS
  formAllowDelete.value = false
  dialogOpen.value = true
}

// The one and only sighting of the raw token. Held in memory until dismissed;
// never written to storage, and the list endpoint cannot return it again.
const revealed = ref<AgentTokenCreated | null>(null)
const copied = ref(false)

async function submitCreate() {
  if (creating.value) return
  creating.value = true
  try {
    const made = await create({
      label: formLabel.value.trim() || undefined,
      role: formRole.value,
      expiresInDays: Number(formDays.value) || AGENT_TOKEN_DEFAULT_DAYS,
      allowDelete: formAllowDelete.value,
    })
    dialogOpen.value = false
    revealed.value = made
    copied.value = false
  }
  catch (e) {
    toast.error((e as { data?: { message?: string } })?.data?.message || t('dashboard.agentTokens.createFailed'))
  }
  finally {
    creating.value = false
  }
}

async function copyToken() {
  if (!revealed.value) return
  try {
    await navigator.clipboard.writeText(revealed.value.token)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  }
  catch {
    toast.error(t('dashboard.agentTokens.copyFailed'))
  }
}

// Granting or withdrawing the delete capability. Takes effect on the token's
// very next request — no re-minting, so whatever the agent already has keeps
// working either way.
//
// The switch is driven from the server's answer rather than from local state:
// on failure nothing is mutated, so the control snaps back to the truth instead
// of showing a permission the token does not actually have.
const pendingPerm = ref<Set<string>>(new Set())

async function onToggleDelete(tk: AgentToken, next: boolean) {
  if (pendingPerm.value.has(tk.id)) return
  pendingPerm.value = new Set(pendingPerm.value).add(tk.id)
  try {
    await setAllowDelete(tk.id, next)
  }
  catch {
    toast.error(t('dashboard.agentTokens.deletePermFailed'))
  }
  finally {
    const s = new Set(pendingPerm.value)
    s.delete(tk.id)
    pendingPerm.value = s
  }
}

// Revoke (page-level confirm). Target kept in its own ref, separate from the
// dialog's open flag — see the note on the SSO page: AlertDialogAction closes
// the dialog on click, and a shared ref would wipe the target first.
const revokeTarget = ref<AgentToken | null>(null)
const showRevoke = ref(false)
function askRevoke(tk: AgentToken) {
  revokeTarget.value = tk
  showRevoke.value = true
}
async function confirmRevoke() {
  const target = revokeTarget.value
  showRevoke.value = false
  if (!target) return
  try {
    await remove(target.id)
    if (revealed.value?.id === target.id) revealed.value = null
  }
  catch {
    toast.error(t('dashboard.agentTokens.revokeFailed'))
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <header class="h-16 px-6 border-b border-border flex items-center justify-between shrink-0 bg-card">
      <div>
        <h2 class="font-heading text-lg font-bold">{{ $t('dashboard.agentTokens.title') }}</h2>
        <p class="text-xs text-muted-foreground">{{ $t('dashboard.agentTokens.subtitle') }}</p>
      </div>
      <button
        v-if="isOwner"
        :disabled="!canCreate"
        class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-2"
        :title="canCreate ? '' : $t('dashboard.agentTokens.limitReached', { limit: AGENT_TOKEN_LIMIT })"
        @click="openCreate"
      >
        <Icon name="lucide:plus" size="14" />
        {{ $t('dashboard.agentTokens.createToken') }}
      </button>
    </header>

    <div class="flex-1 overflow-y-auto">
      <div class="max-w-3xl mx-auto px-6 py-8">
        <!-- Owner gate -->
        <div v-if="!isOwner" class="rounded-xl border border-border bg-card px-6 py-14 flex flex-col items-center text-center">
          <div class="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center mb-3">
            <Icon name="lucide:lock" size="22" class="text-muted-foreground" />
          </div>
          <p class="font-heading font-bold text-sm">{{ $t('dashboard.agentTokens.ownersOnly') }}</p>
          <p class="text-xs text-muted-foreground mt-1 max-w-xs leading-relaxed">
            {{ $t('dashboard.agentTokens.ownersOnlyHint') }}
          </p>
        </div>

        <template v-else>
          <!-- One-time reveal -->
          <section v-if="revealed" class="rounded-xl border-2 border-primary bg-primary/5 p-5 mb-6">
            <div class="flex items-start gap-3">
              <Icon name="lucide:key-round" size="18" class="text-primary mt-0.5 shrink-0" />
              <div class="min-w-0 flex-1">
                <p class="font-heading font-bold text-sm">{{ $t('dashboard.agentTokens.revealTitle') }}</p>
                <p class="text-xs text-muted-foreground mt-1 leading-relaxed">
                  {{ $t('dashboard.agentTokens.revealHint') }}
                </p>
                <div class="mt-3 flex items-center gap-2">
                  <code class="flex-1 min-w-0 px-3 py-2 rounded-lg bg-background border border-border text-xs font-mono break-all">{{ revealed.token }}</code>
                  <button
                    class="h-9 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 transition-all flex items-center gap-1.5 shrink-0"
                    @click="copyToken"
                  >
                    <Icon :name="copied ? 'lucide:check' : 'lucide:copy'" size="14" />
                    {{ copied ? $t('dashboard.agentTokens.copied') : $t('common.copy') }}
                  </button>
                </div>
                <button
                  class="mt-3 text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
                  @click="revealed = null"
                >
                  {{ $t('dashboard.agentTokens.revealDismiss') }}
                </button>
              </div>
            </div>
          </section>

          <section class="rounded-xl border border-border bg-card overflow-hidden">
            <div class="px-5 py-3 border-b border-border flex items-center justify-between">
              <div>
                <h3 class="font-heading font-bold text-sm">{{ $t('dashboard.agentTokens.listTitle') }}</h3>
                <p class="text-[11px] text-muted-foreground mt-0.5">{{ $t('dashboard.agentTokens.listDesc') }}</p>
              </div>
              <span class="text-[11px] font-semibold text-muted-foreground tabular-nums">{{ $t('dashboard.agentTokens.usedCount', { used, limit: AGENT_TOKEN_LIMIT }) }}</span>
            </div>

            <div v-if="loading" class="px-6 py-14 text-center text-sm text-muted-foreground">
              {{ $t('dashboard.agentTokens.loading') }}
            </div>

            <div v-else-if="!tokens.length" class="px-6 py-14 flex flex-col items-center text-center">
              <div class="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center mb-3">
                <Icon name="lucide:bot" size="22" class="text-primary" />
              </div>
              <p class="font-heading font-bold text-sm">{{ $t('dashboard.agentTokens.empty') }}</p>
              <p class="text-xs text-muted-foreground mt-1 max-w-sm leading-relaxed">
                {{ $t('dashboard.agentTokens.emptyHint') }}
              </p>
              <button
                class="mt-4 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 transition-all flex items-center gap-2"
                @click="openCreate"
              >
                <Icon name="lucide:plus" size="14" />
                {{ $t('dashboard.agentTokens.createToken') }}
              </button>
            </div>

            <div v-else class="divide-y divide-border">
              <div v-for="tk in tokens" :key="tk.id" class="px-5 py-4 flex items-center gap-4">
                <div class="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                  <Icon name="lucide:bot" size="16" class="text-muted-foreground" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <p class="font-semibold text-sm truncate">{{ tk.label || $t('dashboard.agentTokens.untitled') }}</p>
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-secondary text-muted-foreground">{{ tk.role }}</span>
                    <span
                      v-if="tk.expired"
                      class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                    >{{ $t('dashboard.agentTokens.expired') }}</span>
                  </div>
                  <p class="text-[11px] text-muted-foreground mt-0.5">
                    <span class="font-mono">{{ tk.prefix }}...</span>
                    <span> &middot; {{ $t('dashboard.agentTokens.expiresOn', { date: formatDate(tk.expiresAt) }) }}</span>
                  </p>
                </div>
                <!-- Not a <label>: reka-ui's Switch renders a button plus a hidden
                     checkbox, and a wrapping label forwards the click to the hidden
                     input instead of the control. Template expressions are plain
                     JavaScript too, so no type annotation on the handler argument. -->
                <div
                  class="flex items-center gap-2 shrink-0"
                  :title="$t('dashboard.agentTokens.deletePermHint')"
                >
                  <span
                    class="text-[11px] font-semibold transition-colors"
                    :class="tk.allowDelete ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'"
                  >{{ $t('dashboard.agentTokens.deletePermSwitch') }}</span>
                  <Switch
                    :model-value="tk.allowDelete"
                    :disabled="pendingPerm.has(tk.id)"
                    :aria-label="$t('dashboard.agentTokens.deletePermSwitch')"
                    class="data-[state=checked]:bg-red-600"
                    @update:model-value="onToggleDelete(tk, $event)"
                  />
                </div>
                <button
                  class="h-8 px-3 rounded-lg border border-border bg-background text-xs font-semibold hover:bg-secondary transition-colors shrink-0"
                  @click="askRevoke(tk)"
                >
                  {{ $t('dashboard.agentTokens.revoke') }}
                </button>
              </div>
            </div>
          </section>

          <p class="text-[11px] text-muted-foreground leading-relaxed mt-4">
            <Icon name="lucide:shield" size="11" class="inline mr-1" />
            {{ $t('dashboard.agentTokens.securityNote') }}
          </p>
        </template>
      </div>
    </div>

    <!-- Create dialog -->
    <Dialog v-model:open="dialogOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle class="font-heading">{{ $t('dashboard.agentTokens.createTitle') }}</DialogTitle>
          <DialogDescription class="text-sm">{{ $t('dashboard.agentTokens.createDesc') }}</DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <div>
            <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              {{ $t('dashboard.agentTokens.labelLabel') }}
              <span class="font-normal normal-case">{{ $t('dashboard.agentTokens.labelOptional') }}</span>
            </label>
            <input
              v-model="formLabel"
              type="text"
              :placeholder="$t('dashboard.agentTokens.labelPlaceholder')"
              class="mt-2 w-full h-10 px-3 rounded-lg border border-border bg-background text-sm focus:outline-none focus:border-primary transition-colors"
            >
            <p class="text-[11px] text-muted-foreground mt-1.5">{{ $t('dashboard.agentTokens.labelHint') }}</p>
          </div>

          <div>
            <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('dashboard.agentTokens.roleLabel') }}</label>
            <select
              v-model="formRole"
              class="mt-2 w-full h-10 px-3 rounded-lg border border-border bg-background text-sm focus:outline-none focus:border-primary transition-colors"
            >
              <option value="manager">{{ $t('dashboard.agentTokens.roleManager') }}</option>
              <option value="contributor">{{ $t('dashboard.agentTokens.roleContributor') }}</option>
            </select>
            <p class="text-[11px] text-muted-foreground mt-1.5">{{ $t('dashboard.agentTokens.roleHint') }}</p>
          </div>

          <div>
            <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('dashboard.agentTokens.expiryLabel') }}</label>
            <input
              v-model.number="formDays"
              type="number"
              min="1"
              :max="AGENT_TOKEN_MAX_DAYS"
              class="mt-2 w-full h-10 px-3 rounded-lg border border-border bg-background text-sm focus:outline-none focus:border-primary transition-colors"
            >
            <p class="text-[11px] text-muted-foreground mt-1.5">{{ $t('dashboard.agentTokens.expiryHint', { max: AGENT_TOKEN_MAX_DAYS }) }}</p>
          </div>

          <div class="rounded-lg border border-border p-3">
            <div class="flex items-start gap-3">
              <span class="min-w-0 flex-1">
                <span
                  class="text-sm font-semibold transition-colors"
                  :class="formAllowDelete ? 'text-red-600 dark:text-red-400' : ''"
                >{{ $t('dashboard.agentTokens.deletePermLabel') }}</span>
                <span class="block text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{{ $t('dashboard.agentTokens.deletePermDesc') }}</span>
              </span>
              <Switch
                v-model="formAllowDelete"
                :aria-label="$t('dashboard.agentTokens.deletePermLabel')"
                class="mt-0.5 shrink-0 data-[state=checked]:bg-red-600"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <button class="h-9 px-4 rounded-lg border border-border bg-background text-xs font-semibold hover:bg-secondary transition-colors" @click="dialogOpen = false">
            {{ $t('common.cancel') }}
          </button>
          <button
            :disabled="creating"
            class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 disabled:opacity-40 transition-all flex items-center gap-1.5"
            @click="submitCreate"
          >
            <Icon name="lucide:plus" size="14" />
            {{ $t('dashboard.agentTokens.createToken') }}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Revoke confirmation -->
    <AlertDialog v-model:open="showRevoke">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle class="font-heading">{{ $t('dashboard.agentTokens.revokeTitle') }}</AlertDialogTitle>
          <AlertDialogDescription>
            <span class="font-semibold text-foreground">{{ revokeTarget?.label || $t('dashboard.agentTokens.untitled') }}</span>{{ $t('dashboard.agentTokens.revokeDescription') }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ $t('common.cancel') }}</AlertDialogCancel>
          <AlertDialogAction class="bg-red-600 hover:bg-red-700 text-white" @click="confirmRevoke">
            {{ $t('dashboard.agentTokens.revokePermanently') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>

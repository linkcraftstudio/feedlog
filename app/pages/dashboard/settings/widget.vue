<script setup lang="ts">
import { toast } from 'vue-sonner'
import {
  CONVERSATION_RETENTION_DEFAULT_DAYS,
  CONVERSATION_RETENTION_MAX_DAYS,
  CONVERSATION_RETENTION_MIN_DAYS,
} from '~~/shared/constants/conversation'
import { WIDGET_MAX_ENABLED_RULES } from '~~/shared/constants/widget-rules'

// /dashboard/settings/widget — install guide + the rules that decide when the
// in-widget assistant points a visitor at support instead of filing feedback.

definePageMeta({ layout: 'dashboard', middleware: ['admin'] })

const { t } = useI18n()
const ctx = useOrgContext()
const canEdit = computed(() => ctx.value.role === 'owner' || ctx.value.role === 'manager')

const { settings, loading, saving, error, refresh, save, allRules, builtinsPatch, customPatch } = useWidgetSettings()

// Client-side after mount: the endpoint needs the session cookie (mirrors the
// Members and SSO pages).
onMounted(() => { if (canEdit.value) void refresh() })

// ---- install -------------------------------------------------------------
// The endpoint the browser snippet fetches is the customer's own — FeedLog
// serves no such route — and nothing else tells them to build it: the SDK's
// README assumes an integrator who already signs these tokens for Product SSO.
const serverSnippet = `import jwt from 'jsonwebtoken'

// Your own route, reachable only when signed in — the widget trusts whoever
// this endpoint says the visitor is. The secret stays here, never the browser.
app.get('/api/feedlog-token', requireSignIn, (req, res) => {
  const token = jwt.sign(
    {
      email:   req.user.email,  // required — identity key
      name:    req.user.name,   // optional — falls back to the email
      picture: req.user.avatar, // optional — avatar URL
      exp: Math.floor(Date.now() / 1000) + 60 * 60, // required — 24h at most
    },
    process.env.FEEDLOG_SSO_SECRET, // one of this workspace's enabled secrets
    { algorithm: 'HS256' },
  )
  res.json({ token })
})`

// Verbatim from the SDK's README, with this workspace's URL filled in: the
// throw/null distinction is its contract to state, and paraphrasing it once
// already turned a transient 500 into a spurious sign-out.
const snippet = computed(() => `import { createWidget } from '@feedlog/widget'

createWidget({
  baseUrl: '${settings.value?.baseUrl ?? ''}',
  auth: {
    // Return a JWT signed by YOUR backend with your org's SSO secret.
    getToken: async () => {
      const res = await fetch('/api/feedlog-token')
      if (!res.ok) throw new Error('temporary failure') // throw = retryable failure
      return (await res.json()).token ?? null           // null = signed out
    },
    // Optional: open your own sign-in UI (popup or full-page redirect).
    login: () => openYourLoginModal(),
  },
  theme: 'auto',
})`)

const copiedKey = ref<string | null>(null)
function copy(key: string, text: string) {
  navigator.clipboard?.writeText(text)
  copiedKey.value = key
  setTimeout(() => { copiedKey.value = null }, 1500)
}

// ---- persistence ---------------------------------------------------------
// Every mutation commits immediately; a failed save reloads so the UI can never
// keep showing a state the server rejected.
async function commit(patch: Parameters<typeof save>[0]) {
  const err = await save(patch)
  if (err) {
    toast.error(err)
    await refresh()
    return false
  }
  return true
}

async function toggleEnabled() {
  if (!settings.value) return
  await commit({ enabled: !settings.value.enabled })
}

// ---- support email -------------------------------------------------------
// Text has no natural commit point the way a switch does, so it takes an
// explicit Save.
const emailDraft = ref('')
watch(settings, s => { emailDraft.value = s?.supportEmail ?? '' }, { immediate: true })
const emailDirty = computed(() => emailDraft.value.trim() !== (settings.value?.supportEmail ?? ''))

async function saveEmail() {
  if (!emailDirty.value) return
  if (await commit({ supportEmail: emailDraft.value.trim() })) {
    toast.success(t('settings.widget.saved'))
  }
}

// ---- conversation retention ----------------------------------------------
const retentionDraft = ref(CONVERSATION_RETENTION_DEFAULT_DAYS)
watch(settings, s => { retentionDraft.value = s?.conversationRetentionDays ?? CONVERSATION_RETENTION_DEFAULT_DAYS }, { immediate: true })
const retentionValue = computed(() => Math.trunc(Number(retentionDraft.value)))
const retentionValid = computed(() => Number.isFinite(retentionValue.value)
  && retentionValue.value >= CONVERSATION_RETENTION_MIN_DAYS
  && retentionValue.value <= CONVERSATION_RETENTION_MAX_DAYS)
const retentionDirty = computed(() => retentionValid.value
  && retentionValue.value !== (settings.value?.conversationRetentionDays ?? CONVERSATION_RETENTION_DEFAULT_DAYS))

async function saveRetention() {
  if (!retentionDirty.value) return
  if (await commit({ conversationRetentionDays: retentionValue.value })) {
    toast.success(t('settings.widget.saved'))
  }
}

// ---- rules ---------------------------------------------------------------
const activeCount = computed(() => settings.value?.enabledCount ?? 0)
const atLimit = computed(() => activeCount.value >= WIDGET_MAX_ENABLED_RULES)
// Stay quiet until the limit is close enough to matter.
const showCount = computed(() => activeCount.value >= WIDGET_MAX_ENABLED_RULES - 2)

// The cap is explained on the spot rather than by disabling the control: a
// greyed switch can't say why it won't budge, and says nothing at all on touch.
const limitOpen = ref(false)

const dialogOpen = ref(false)
const editingId = ref<string | null>(null)
const editingText = computed(() => allRules.value.find(r => r.id === editingId.value)?.scenario)

function openAdd() {
  if (atLimit.value) { limitOpen.value = true; return }
  editingId.value = null
  dialogOpen.value = true
}

function openEdit(id: string) {
  editingId.value = id
  dialogOpen.value = true
}

async function onRuleSubmit(scenario: string) {
  const rules = allRules.value.map(r => ({ ...r }))
  if (editingId.value) {
    const target = rules.find(r => r.id === editingId.value)
    if (target) target.scenario = scenario
  }
  else {
    rules.push({ id: `new-${Date.now()}`, scenario, enabled: true, builtin: false })
  }
  await commit(customPatch(rules))
}

async function toggleRule(id: string) {
  const rules = allRules.value.map(r => ({ ...r }))
  const target = rules.find(r => r.id === id)
  if (!target) return
  // Turning a rule off is always allowed; enabling one past the cap explains why.
  if (!target.enabled && atLimit.value) { limitOpen.value = true; return }
  target.enabled = !target.enabled
  await commit(target.builtin ? builtinsPatch(rules) : customPatch(rules))
}

const { confirm } = useConfirmDialog()
async function removeRule(id: string) {
  const confirmed = await confirm({
    title: t('settings.widget.deleteTitle'),
    description: t('settings.widget.deleteDesc'),
    confirmText: t('settings.widget.deleteConfirm'),
    cancelText: t('settings.widget.cancel'),
    variant: 'destructive',
  })
  if (!confirmed) return
  await commit(customPatch(allRules.value.filter(r => r.id !== id).map(r => ({ ...r }))))
}
</script>

<template>
  <div class="flex flex-col h-full">
    <header class="h-16 px-6 border-b border-border flex items-center shrink-0 bg-card">
      <div>
        <h2 class="font-heading text-lg font-bold">{{ $t('settings.widget.title') }}</h2>
        <p class="text-xs text-muted-foreground">{{ $t('settings.widget.subtitle') }}</p>
      </div>
    </header>

    <div class="flex-1 overflow-y-auto">
      <div class="max-w-4xl mx-auto px-6 py-8 space-y-6">
        <p v-if="!canEdit" class="text-sm text-muted-foreground">{{ $t('settings.widget.ownerOnly') }}</p>
        <p v-else-if="loading" class="text-sm text-muted-foreground">{{ $t('settings.loading') }}</p>
        <p v-else-if="error" class="text-sm text-red-600">{{ error }}</p>

        <template v-else-if="settings">
          <!-- Install -->
          <section class="rounded-xl border border-border bg-card overflow-hidden">
            <div class="px-6 py-5 border-b border-border flex items-start justify-between gap-4">
              <div>
                <h3 class="font-heading font-bold text-sm">{{ $t('settings.widget.installSection') }}</h3>
                <p class="text-xs text-muted-foreground mt-0.5">{{ $t('settings.widget.installDesc') }}</p>
              </div>
              <button
                class="shrink-0 flex items-center gap-2.5 text-xs font-semibold"
                :disabled="saving"
                @click="toggleEnabled"
              >
                <span
                  class="w-9 h-5 rounded-full transition-colors relative"
                  :class="settings.enabled ? 'bg-primary' : 'bg-muted-foreground/30'"
                >
                  <span
                    class="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all"
                    :class="settings.enabled ? 'left-[18px]' : 'left-0.5'"
                  />
                </span>
                {{ $t('settings.widget.enabledLabel') }}
              </button>
            </div>

            <div class="px-6 py-6 space-y-5">
              <div>
                <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('settings.widget.baseUrlLabel') }}</label>
                <div class="mt-2 flex items-center gap-2">
                  <code class="flex-1 min-w-0 truncate text-xs font-mono px-2.5 py-2 rounded-md bg-muted border border-border">{{ settings.baseUrl }}</code>
                  <button
                    class="w-8 h-8 rounded-md hover:bg-secondary transition-colors flex items-center justify-center shrink-0"
                    :class="copiedKey === 'url' ? 'text-[var(--status-done)]' : 'text-muted-foreground'"
                    @click="copy('url', settings.baseUrl)"
                  >
                    <Icon :name="copiedKey === 'url' ? 'lucide:check' : 'lucide:copy'" size="14" />
                  </button>
                </div>
                <p class="text-[11px] text-muted-foreground mt-1.5">{{ $t('settings.widget.baseUrlHint') }}</p>
              </div>

              <div>
                <div class="flex items-center justify-between">
                  <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('settings.widget.serverLabel') }}</label>
                  <button
                    class="h-7 px-2.5 rounded-md border border-border bg-background hover:bg-secondary transition-colors flex items-center gap-1.5 text-[11px] font-semibold"
                    :class="copiedKey === 'server' ? 'text-[var(--status-done)]' : 'text-muted-foreground'"
                    @click="copy('server', serverSnippet)"
                  >
                    <Icon :name="copiedKey === 'server' ? 'lucide:check' : 'lucide:copy'" size="12" />
                    {{ copiedKey === 'server' ? $t('settings.widget.copied') : $t('settings.widget.copy') }}
                  </button>
                </div>
                <pre class="mt-2 px-4 py-3 rounded-lg bg-muted/40 border border-border overflow-x-auto text-xs font-mono leading-relaxed"><code>{{ serverSnippet }}</code></pre>
                <p class="text-[11px] text-muted-foreground mt-1.5">{{ $t('settings.widget.serverHint') }}</p>
              </div>

              <div>
                <div class="flex items-center justify-between">
                  <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('settings.widget.snippetLabel') }}</label>
                  <button
                    class="h-7 px-2.5 rounded-md border border-border bg-background hover:bg-secondary transition-colors flex items-center gap-1.5 text-[11px] font-semibold"
                    :class="copiedKey === 'snippet' ? 'text-[var(--status-done)]' : 'text-muted-foreground'"
                    @click="copy('snippet', snippet)"
                  >
                    <Icon :name="copiedKey === 'snippet' ? 'lucide:check' : 'lucide:copy'" size="12" />
                    {{ copiedKey === 'snippet' ? $t('settings.widget.copied') : $t('settings.widget.copy') }}
                  </button>
                </div>
                <pre class="mt-2 px-4 py-3 rounded-lg bg-muted/40 border border-border overflow-x-auto text-xs font-mono leading-relaxed"><code>{{ snippet }}</code></pre>
              </div>

              <p class="text-[11px] text-muted-foreground">{{ $t('settings.widget.enabledHint') }}</p>
            </div>
          </section>

          <!-- Contact support -->
          <section class="rounded-xl border border-border bg-card overflow-hidden">
            <div class="px-6 py-5 border-b border-border">
              <h3 class="font-heading font-bold text-sm">{{ $t('settings.widget.supportSection') }}</h3>
              <p class="text-xs text-muted-foreground mt-0.5">{{ $t('settings.widget.supportDesc') }}</p>
            </div>

            <div class="px-6 py-6 space-y-6">
              <div>
                <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('settings.widget.emailLabel') }}</label>
                <div class="mt-2 flex items-center gap-2">
                  <input
                    v-model="emailDraft"
                    type="email"
                    :placeholder="$t('settings.widget.emailPlaceholder')"
                    class="flex-1 h-10 px-3 rounded-lg border border-border bg-background text-sm focus:outline-none focus:border-primary transition-colors"
                    @keydown.enter="saveEmail"
                  >
                  <button
                    v-if="emailDirty"
                    class="h-10 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 transition-all shrink-0"
                    :disabled="saving"
                    @click="saveEmail"
                  >
                    {{ $t('settings.widget.save') }}
                  </button>
                </div>
                <p class="text-[11px] text-muted-foreground mt-1.5">{{ $t('settings.widget.emailHint') }}</p>
              </div>

              <div class="pt-5 border-t border-border">
                <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('settings.widget.retentionLabel') }}</label>
                <div class="mt-2 flex items-center gap-2">
                  <div class="flex-1 flex items-center gap-2">
                    <input
                      v-model="retentionDraft"
                      type="number"
                      :min="CONVERSATION_RETENTION_MIN_DAYS"
                      :max="CONVERSATION_RETENTION_MAX_DAYS"
                      class="w-28 h-10 px-3 rounded-lg border bg-background text-sm tabular-nums focus:outline-none focus:border-primary transition-colors"
                      :class="retentionValid ? 'border-border' : 'border-destructive'"
                      @keydown.enter="saveRetention"
                    >
                    <span class="text-sm text-muted-foreground">{{ $t('settings.widget.retentionUnit') }}</span>
                  </div>
                  <button
                    v-if="retentionDirty"
                    class="h-10 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 transition-all shrink-0"
                    :disabled="saving"
                    @click="saveRetention"
                  >
                    {{ $t('settings.widget.save') }}
                  </button>
                </div>
                <p class="text-[11px] mt-1.5" :class="retentionValid ? 'text-muted-foreground' : 'text-destructive'">
                  {{ retentionValid
                    ? $t('settings.widget.retentionHint')
                    : $t('settings.widget.retentionRange', { min: CONVERSATION_RETENTION_MIN_DAYS, max: CONVERSATION_RETENTION_MAX_DAYS }) }}
                </p>
              </div>

              <div class="pt-5 border-t border-border">
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <p class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('settings.widget.rulesLabel') }}</p>
                    <p class="text-[11px] text-muted-foreground mt-1">{{ $t('settings.widget.rulesHint') }}</p>
                  </div>
                  <div class="flex items-center gap-3 shrink-0">
                    <span v-if="showCount" class="text-[11px] text-muted-foreground tabular-nums">
                      {{ $t('settings.widget.activeCount', { count: activeCount, max: WIDGET_MAX_ENABLED_RULES }) }}
                    </span>
                    <button
                      class="h-8 px-3 rounded-lg border border-border bg-background text-xs font-semibold hover:bg-secondary transition-colors flex items-center gap-1.5"
                      @click="openAdd"
                    >
                      <Icon name="lucide:plus" size="13" />
                      {{ $t('settings.widget.addRule') }}
                    </button>
                  </div>
                </div>

                <ul class="mt-4 divide-y divide-border rounded-lg border border-border overflow-hidden">
                  <li
                    v-for="rule in allRules"
                    :key="rule.id"
                    class="px-4 py-3 flex items-start gap-3 bg-background"
                  >
                    <button
                      class="mt-0.5 shrink-0"
                      :disabled="saving"
                      @click="toggleRule(rule.id)"
                    >
                      <span
                        class="w-9 h-5 rounded-full transition-colors relative block"
                        :class="rule.enabled ? 'bg-primary' : 'bg-muted-foreground/30'"
                      >
                        <span
                          class="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all"
                          :class="rule.enabled ? 'left-[18px]' : 'left-0.5'"
                        />
                      </span>
                    </button>

                    <p class="flex-1 text-xs leading-relaxed" :class="rule.enabled ? '' : 'text-muted-foreground'">
                      {{ rule.scenario }}
                      <span
                        v-if="rule.builtin"
                        class="ml-1.5 align-middle text-[10px] font-bold uppercase tracking-wider bg-secondary text-primary px-1.5 py-0.5 rounded"
                      >{{ $t('settings.widget.builtinBadge') }}</span>
                    </p>

                    <!-- Built-ins toggle but never change text: their wording ships with the product. -->
                    <div v-if="!rule.builtin" class="flex items-center gap-1 shrink-0">
                      <button
                        class="w-7 h-7 rounded-md hover:bg-secondary transition-colors flex items-center justify-center text-muted-foreground"
                        @click="openEdit(rule.id)"
                      >
                        <Icon name="lucide:pencil" size="13" />
                      </button>
                      <button
                        class="w-7 h-7 rounded-md hover:bg-secondary transition-colors flex items-center justify-center text-muted-foreground hover:text-red-600"
                        @click="removeRule(rule.id)"
                      >
                        <Icon name="lucide:trash-2" size="13" />
                      </button>
                    </div>
                  </li>
                </ul>
              </div>
            </div>
          </section>
        </template>
      </div>
    </div>

    <WidgetRuleDialog v-model:open="dialogOpen" :initial="editingText" @submit="onRuleSubmit" />

    <Dialog v-model:open="limitOpen">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle class="font-heading">{{ $t('settings.widget.limitTitle') }}</DialogTitle>
          <DialogDescription class="text-sm">
            {{ $t('settings.widget.limitDesc', { max: WIDGET_MAX_ENABLED_RULES }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 transition-all"
            @click="limitOpen = false"
          >
            {{ $t('settings.widget.gotIt') }}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

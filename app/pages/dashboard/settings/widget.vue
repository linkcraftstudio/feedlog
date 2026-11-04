<script setup lang="ts">
import { toast } from 'vue-sonner'
import { CONVERSATION_RETENTION_DEFAULT_DAYS, CONVERSATION_RETENTION_MAX_DAYS, CONVERSATION_RETENTION_MIN_DAYS } from '#layers/feedlog/shared/constants/conversation'
import { WIDGET_MAX_ENABLED_RULES } from '#layers/feedlog/shared/constants/widget-rules'
import { WIDGET_LAUNCHER_ALIGNMENT_DEFAULT, WIDGET_LAUNCHER_CLOSE_BEHAVIOR_DEFAULT, WIDGET_LAUNCHER_CLOSE_BEHAVIORS, WIDGET_LAUNCHER_OFFSET_DEFAULT, WIDGET_LAUNCHER_OFFSET_MIN, type WidgetLauncherAlignment, type WidgetLauncherCloseBehavior } from '#layers/feedlog/shared/constants/widget-launcher'
import { updateWidgetSettingsSchema } from '#layers/feedlog/shared/schemas/widget'

definePageMeta({ layout: 'dashboard', middleware: ['admin'] })

const { t, locale } = useI18n()
const ctx = useOrgContext()
const canEdit = computed(() => ctx.value.role === 'owner' || ctx.value.role === 'manager')
const { settings, loading, saving, error, refresh, save, allRules, builtinsPatch, customPatch } = useWidgetSettings()
const { confirm } = useConfirmDialog()
const savingSection = ref<'enabled' | 'launcher' | 'assistant' | null>(null)
const launcherError = ref<string | null>(null)
const assistantError = ref<string | null>(null)
const launcherSaved = ref(false)
const assistantSaved = ref(false)

const alignDraft = ref<WidgetLauncherAlignment>(WIDGET_LAUNCHER_ALIGNMENT_DEFAULT)
const offsetDraft = reactive<Record<'bottom' | 'side', number | string>>({ bottom: WIDGET_LAUNCHER_OFFSET_DEFAULT, side: WIDGET_LAUNCHER_OFFSET_DEFAULT })
const closeDraft = ref<WidgetLauncherCloseBehavior>(WIDGET_LAUNCHER_CLOSE_BEHAVIOR_DEFAULT)
const emailDraft = ref('')
const retentionDraft = ref<number | string>(CONVERSATION_RETENTION_DEFAULT_DAYS)
const rulesDraft = ref<{ id: string; scenario: string; enabled: boolean; builtin: boolean }[]>([])

function hydrateLauncher() {
  if (!settings.value) return
  alignDraft.value = settings.value.launcherConfig.alignment
  offsetDraft.bottom = settings.value.launcherConfig.bottomOffset
  offsetDraft.side = settings.value.launcherConfig.sideOffset
  closeDraft.value = settings.value.launcherConfig.closeBehavior
  launcherError.value = null
  launcherSaved.value = false
}
function hydrateAssistant() {
  if (!settings.value) return
  emailDraft.value = settings.value.supportEmail ?? ''
  retentionDraft.value = settings.value.conversationRetentionDays
  rulesDraft.value = allRules.value.map(rule => ({ ...rule }))
  assistantError.value = null
  assistantSaved.value = false
}
const onboarding = useOnboarding()
const installSection = ref<HTMLElement | null>(null)
const pulsing = ref(false)
// Arriving from the onboarding guide or demo: bring the section, whose first
// step is the coding-agent prompt, into view and pulse it once. Watched rather
// than run on mount, because the demo's install link can also be used while
// already on this page.
async function highlightInstall() {
  if (!onboarding.state.value.highlightInstall || !settings.value) return
  onboarding.state.value.highlightInstall = false
  await nextTick()
  const section = installSection.value
  if (!section) return
  section.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  // Restart the animation even if a previous pulse is still running.
  pulsing.value = false
  requestAnimationFrame(() => { pulsing.value = true })
}
watch(() => onboarding.state.value.highlightInstall, () => void highlightInstall())
onMounted(async () => {
  if (!canEdit.value) return
  await refresh()
  hydrateLauncher()
  hydrateAssistant()
  await highlightInstall()
})

function isValidOffset(value: number | string) {
  return String(value).trim() !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= WIDGET_LAUNCHER_OFFSET_MIN
}
const offsetValid = computed(() => Object.values(offsetDraft).every(isValidOffset))
const launcherConfigDraft = computed(() => ({ alignment: alignDraft.value, bottomOffset: Number(offsetDraft.bottom), sideOffset: Number(offsetDraft.side), closeBehavior: closeDraft.value }))
const launcherDirty = computed(() => !!settings.value && (!offsetValid.value || Object.entries(launcherConfigDraft.value).some(([key, value]) => value !== settings.value!.launcherConfig[key as keyof typeof launcherConfigDraft.value])))
const retentionValid = computed(() => String(retentionDraft.value).trim() !== '' && Number.isInteger(Number(retentionDraft.value)) && Number(retentionDraft.value) >= CONVERSATION_RETENTION_MIN_DAYS && Number(retentionDraft.value) <= CONVERSATION_RETENTION_MAX_DAYS)
const emailValid = computed(() => updateWidgetSettingsSchema.pick({ supportEmail: true }).safeParse({ supportEmail: emailDraft.value.trim() }).success)
const assistantPatch = computed(() => ({ supportEmail: emailDraft.value.trim(), conversationRetentionDays: Number(retentionDraft.value), ...builtinsPatch(rulesDraft.value), ...customPatch(rulesDraft.value) }))
const assistantDirty = computed(() => !!settings.value && (!retentionValid.value || JSON.stringify(assistantPatch.value) !== JSON.stringify({ supportEmail: settings.value.supportEmail ?? '', conversationRetentionDays: settings.value.conversationRetentionDays, ...builtinsPatch(allRules.value), ...customPatch(allRules.value) })))
const activeCount = computed(() => rulesDraft.value.filter(rule => rule.enabled).length)
const atLimit = computed(() => activeCount.value >= WIDGET_MAX_ENABLED_RULES)
const showCount = computed(() => activeCount.value >= WIDGET_MAX_ENABLED_RULES - 2)
const assistantValid = computed(() => emailValid.value && retentionValid.value && activeCount.value <= WIDGET_MAX_ENABLED_RULES)

// Only the section that submitted is rehydrated. Other drafts, including invalid
// input, must survive both successful saves and failed requests.
async function saveLauncher() {
  if (saving.value || !launcherDirty.value || !offsetValid.value) return
  savingSection.value = 'launcher'
  launcherError.value = await save({ launcherConfig: launcherConfigDraft.value })
  if (!launcherError.value) { hydrateLauncher(); launcherSaved.value = true }
  savingSection.value = null
}
async function saveAssistant() {
  if (saving.value || !assistantDirty.value || !assistantValid.value) return
  savingSection.value = 'assistant'
  assistantError.value = await save(assistantPatch.value)
  if (!assistantError.value) { hydrateAssistant(); assistantSaved.value = true }
  savingSection.value = null
}
async function toggleEnabled() {
  if (saving.value || !settings.value) return
  savingSection.value = 'enabled'
  const err = await save({ enabled: !settings.value.enabled })
  if (err) toast.error(err)
  savingSection.value = null
}
function resetPlacement() {
  alignDraft.value = WIDGET_LAUNCHER_ALIGNMENT_DEFAULT
  offsetDraft.bottom = WIDGET_LAUNCHER_OFFSET_DEFAULT
  offsetDraft.side = WIDGET_LAUNCHER_OFFSET_DEFAULT
  launcherError.value = null
}

const limitOpen = ref(false)
const dialogOpen = ref(false)
const editingId = ref<string | null>(null)
const editingText = computed(() => rulesDraft.value.find(rule => rule.id === editingId.value)?.scenario)
function openAdd() {
  if (atLimit.value) { limitOpen.value = true; return }
  editingId.value = null
  dialogOpen.value = true
}
function openEdit(id: string) { editingId.value = id; dialogOpen.value = true }
function onRuleSubmit(scenario: string) {
  if (editingId.value) {
    const target = rulesDraft.value.find(rule => rule.id === editingId.value)
    if (target) target.scenario = scenario
  }
  else rulesDraft.value.push({ id: `new-${crypto.randomUUID()}`, scenario, enabled: true, builtin: false })
}
function toggleRule(id: string) {
  const target = rulesDraft.value.find(rule => rule.id === id)
  if (!target) return
  if (!target.enabled && atLimit.value) { limitOpen.value = true; return }
  target.enabled = !target.enabled
}
function removeRule(id: string) { rulesDraft.value = rulesDraft.value.filter(rule => rule.id !== id) }
function ruleText(rule: typeof rulesDraft.value[number]) {
  const builtin = rule.builtin && settings.value?.rules.builtins.find(item => item.id === rule.id)
  return builtin ? (locale.value.startsWith('zh') ? builtin.scenarioZh : builtin.scenario) : rule.scenario
}

const dirty = computed(() => launcherDirty.value || assistantDirty.value)
onBeforeRouteLeave(async () => {
  if (saving.value) return false
  if (!dirty.value) return true
  return confirm({ title: t('settings.widget.leaveTitle'), description: t('settings.widget.leaveDescription'), confirmText: t('settings.widget.leaveDiscard'), cancelText: t('settings.widget.leaveKeep'), variant: 'destructive' })
})
function beforeUnload(event: BeforeUnloadEvent) {
  if (!dirty.value && !saving.value) return
  event.preventDefault()
  event.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
</script>

<template>
  <div class="flex flex-col h-full">
    <header class="h-16 px-6 border-b border-border flex items-center shrink-0 bg-card">
      <div>
        <h2 class="font-heading text-lg font-bold">
          {{ $t('settings.widget.title') }}
        </h2><p class="text-xs text-muted-foreground">
          {{ $t('settings.widget.subtitle') }}
        </p>
      </div>
    </header>
    <div class="flex-1 overflow-y-auto">
      <div class="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <p
          v-if="!canEdit"
          class="text-sm text-muted-foreground"
        >
          {{ $t('settings.widget.ownerOnly') }}
        </p>
        <p
          v-else-if="loading"
          class="text-sm text-muted-foreground"
        >
          {{ $t('settings.loading') }}
        </p>
        <p
          v-else-if="error"
          class="text-sm text-red-600"
        >
          {{ error }}
        </p>
        <template v-else-if="settings">
          <OnboardingInstallCard />

          <div ref="installSection" class="rounded-xl" :class="pulsing && 'onboarding-install-pulse'" @animationend="pulsing = false">
            <WidgetInstallationSection
              :base-url="settings.baseUrl"
              :enabled="settings.enabled"
              :saving="saving"
              @toggle="toggleEnabled"
            />
          </div>

          <section
            class="rounded-xl border border-border bg-card overflow-hidden"
            data-widget-section="launcher"
          >
            <div class="px-6 py-5 border-b border-border flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 class="font-heading font-bold text-sm">
                  {{ $t('settings.widget.placementSection') }}
                </h3><p class="text-xs text-muted-foreground mt-0.5">
                  {{ $t('settings.widget.placementDesc') }}
                </p>
              </div>
              <button
                type="button"
                class="h-8 px-3 rounded-md border border-border bg-background hover:bg-secondary transition-colors flex items-center gap-1.5 text-xs font-semibold disabled:opacity-50"
                :disabled="saving"
                @click="resetPlacement"
              >
                <Icon
                  name="lucide:rotate-ccw"
                  size="14"
                />{{ $t('settings.widget.resetPlacement') }}
              </button>
            </div>
            <div class="px-6 py-6 grid lg:grid-cols-[270px_minmax(0,1fr)] gap-6 items-start">
              <fieldset
                :disabled="saving"
                class="min-w-0 space-y-6"
              >
                <div>
                  <p id="launcher-alignment-label" class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                    {{ $t('settings.widget.alignLabel') }}
                  </p>
                  <ToggleGroup
                    type="single"
                    :spacing="1"
                    class="mt-2 gap-0 rounded-lg border border-border bg-background p-1"
                    :model-value="alignDraft"
                    :disabled="saving"
                    aria-labelledby="launcher-alignment-label"
                    @update:model-value="value => { if (value === 'left' || value === 'right') alignDraft = value }"
                  >
                    <ToggleGroupItem
                      v-for="option in (['left', 'right'] as const)"
                      :key="option"
                      :value="option"
                      class="h-8 rounded-md px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground disabled:cursor-not-allowed"
                    >
                      {{ $t(`settings.widget.align_${option}`) }}
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <div class="grid grid-cols-2 gap-4 mt-5">
                    <div
                      v-for="field in (['bottom', 'side'] as const)"
                      :key="field"
                      class="min-w-0"
                    >
                      <label
                        :for="`launcher-${field}-offset`"
                        class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground"
                      >{{ $t(field === 'bottom' ? 'settings.widget.offsetLabel' : `settings.widget.sideOffsetLabel_${alignDraft}`) }}</label>
                      <div class="mt-2 flex items-center gap-2">
                        <input
                          :id="`launcher-${field}-offset`"
                          v-model="offsetDraft[field]"
                          type="number"
                          :min="WIDGET_LAUNCHER_OFFSET_MIN"
                          step="1"
                          class="min-w-16 w-0 flex-1 h-10 px-3 rounded-lg border bg-background text-sm tabular-nums focus:outline-none focus:border-primary transition-colors"
                          :class="isValidOffset(offsetDraft[field]) ? 'border-border' : 'border-destructive'"
                          :aria-invalid="!isValidOffset(offsetDraft[field])"
                          :aria-describedby="isValidOffset(offsetDraft[field]) ? undefined : `launcher-${field}-error`"
                          @keydown.enter="saveLauncher"
                        >
                        <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{{ $t('settings.widget.offsetUnit') }}</span>
                      </div>
                      <p
                        v-if="!isValidOffset(offsetDraft[field])"
                        :id="`launcher-${field}-error`"
                        class="text-[11px] text-destructive mt-2"
                        role="alert"
                      >
                        {{ $t('settings.widget.offsetInvalid') }}
                      </p>
                    </div>
                  </div>
                  <p class="text-[11px] text-muted-foreground mt-3">
                    {{ $t('settings.widget.placementHint') }}
                  </p>
                </div>
                <div class="pt-5 border-t border-border">
                  <label
                    for="launcher-close-behavior"
                    class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground"
                  >
                    {{ $t('settings.widget.closeBehaviorLabel') }}
                  </label>
                  <Select
                    :model-value="closeDraft"
                    :disabled="saving"
                    @update:model-value="value => { if (value === 'none' || value === 'collapse' || value === 'hide') closeDraft = value }"
                  >
                    <SelectTrigger
                      id="launcher-close-behavior"
                      class="mt-2 w-full data-[size=default]:h-10 rounded-lg border-border bg-background text-xs"
                      aria-describedby="launcher-close-hint"
                    >
                      <SelectValue>{{ $t(`settings.widget.closeBehavior_${closeDraft}`) }}</SelectValue>
                    </SelectTrigger>
                    <SelectContent class="max-w-[calc(100vw-2rem)]">
                      <SelectItem
                        v-for="behavior in WIDGET_LAUNCHER_CLOSE_BEHAVIORS"
                        :key="behavior"
                        :value="behavior"
                        :text-value="$t(`settings.widget.closeBehavior_${behavior}`)"
                        class="py-2.5 text-xs"
                      >
                        <span class="block min-w-0">
                          <span class="block font-medium leading-5">
                            {{ $t(`settings.widget.closeBehavior_${behavior}`) }}
                          </span>
                          <span class="mt-0.5 block text-[11px] leading-snug opacity-70">
                            {{ $t(`settings.widget.closeBehaviorHint_${behavior}`) }}
                          </span>
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p id="launcher-close-hint" class="text-[11px] text-muted-foreground mt-3">
                    {{ $t(`settings.widget.closeBehaviorHint_${closeDraft}`) }}
                  </p>
                </div>
              </fieldset>
              <WidgetLauncherPreview
                class="border-t border-border pt-6 lg:border-t-0 lg:border-l lg:pl-6 lg:pt-0"
                :alignment="alignDraft"
                :bottom-offset="offsetDraft.bottom"
                :side-offset="offsetDraft.side"
                :close-behavior="closeDraft"
                :enabled="settings.enabled"
              />
            </div>
            <WidgetSaveBar
              :dirty="launcherDirty"
              :saving="savingSection === 'launcher'"
              :disabled="saving || !offsetValid"
              :error="launcherError"
              :saved="launcherSaved"
              :saved-hint="$t('settings.widget.launcherSavedHint')"
              @cancel="hydrateLauncher"
              @save="saveLauncher"
            />
          </section>

          <section
            class="rounded-xl border border-border bg-card overflow-hidden"
            data-widget-section="assistant"
          >
            <div class="px-6 py-5 border-b border-border">
              <h3 class="font-heading font-bold text-sm">
                {{ $t('settings.widget.supportSection') }}
              </h3><p class="text-xs text-muted-foreground mt-0.5">
                {{ $t('settings.widget.supportDesc') }}
              </p>
            </div>
            <fieldset
              :disabled="saving"
              class="px-6 py-6 space-y-6 min-w-0"
            >
              <div>
                <label
                  for="widget-support-email"
                  class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground"
                >{{ $t('settings.widget.emailLabel') }}</label>
                <input
                  id="widget-support-email"
                  v-model="emailDraft"
                  type="email"
                  :placeholder="$t('settings.widget.emailPlaceholder')"
                  class="mt-2 w-full min-w-0 h-10 px-3 rounded-lg border bg-background text-sm focus:outline-none focus:border-primary transition-colors"
                  :class="emailValid ? 'border-border' : 'border-destructive'"
                  :aria-invalid="!emailValid"
                  @keydown.enter="saveAssistant"
                >
                <p
                  class="text-[11px] mt-1.5"
                  :class="emailValid ? 'text-muted-foreground' : 'text-destructive'"
                >
                  {{ $t(emailValid ? 'settings.widget.emailHint' : 'settings.widget.invalidEmail') }}
                </p>
              </div>
              <div class="pt-5 border-t border-border">
                <div class="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <p class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                      {{ $t('settings.widget.rulesLabel') }}
                    </p><p class="text-[11px] text-muted-foreground mt-1">
                      {{ $t('settings.widget.rulesHint') }}
                    </p>
                  </div>
                  <div class="flex items-center gap-3">
                    <span
                      v-if="showCount"
                      class="text-[11px] text-muted-foreground tabular-nums"
                    >{{ $t('settings.widget.activeCount', { count: activeCount, max: WIDGET_MAX_ENABLED_RULES }) }}</span><button
                      type="button"
                      class="h-8 px-3 rounded-lg border border-border bg-background text-xs font-semibold hover:bg-secondary transition-colors flex items-center gap-1.5"
                      @click="openAdd"
                    >
                      <Icon
                        name="lucide:plus"
                        size="13"
                      />{{ $t('settings.widget.addRule') }}
                    </button>
                  </div>
                </div>
                <ul class="mt-4 divide-y divide-border rounded-lg border border-border overflow-hidden">
                  <li
                    v-for="rule in rulesDraft"
                    :key="rule.id"
                    class="px-4 py-3 flex flex-wrap items-start gap-3 bg-background"
                  >
                    <Switch
                      :id="`widget-rule-${rule.id}`"
                      :model-value="rule.enabled"
                      :disabled="saving"
                      class="mt-0.5"
                      :aria-label="ruleText(rule)"
                      @update:model-value="toggleRule(rule.id)"
                    />
                    <label
                      :for="`widget-rule-${rule.id}`"
                      class="flex-1 min-w-24 text-xs leading-relaxed break-words"
                      :class="rule.enabled ? '' : 'text-muted-foreground'"
                    >{{ ruleText(rule) }}<span
                      v-if="rule.builtin"
                      class="ml-1.5 align-middle text-[10px] font-bold uppercase tracking-wider bg-secondary text-primary px-1.5 py-0.5 rounded"
                    >{{ $t('settings.widget.builtinBadge') }}</span></label>
                    <div
                      v-if="!rule.builtin"
                      class="flex items-center gap-1 shrink-0 ml-auto"
                    >
                      <button
                        type="button"
                        class="size-8 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground"
                        :aria-label="$t('settings.widget.editRule')"
                        @click="openEdit(rule.id)"
                      >
                        <Icon
                          name="lucide:pencil"
                          size="13"
                        />
                      </button>
                      <button
                        type="button"
                        class="size-8 rounded-md hover:bg-secondary flex items-center justify-center text-muted-foreground hover:text-destructive"
                        :aria-label="$t('settings.widget.deleteConfirm')"
                        @click="removeRule(rule.id)"
                      >
                        <Icon
                          name="lucide:trash-2"
                          size="13"
                        />
                      </button>
                    </div>
                  </li>
                </ul>
              </div>
              <div class="pt-5 border-t border-border">
                <label
                  for="widget-retention"
                  class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground"
                >{{ $t('settings.widget.retentionLabel') }}</label>
                <div class="mt-2 flex items-center gap-2">
                  <input
                    id="widget-retention"
                    v-model="retentionDraft"
                    type="number"
                    :min="CONVERSATION_RETENTION_MIN_DAYS"
                    :max="CONVERSATION_RETENTION_MAX_DAYS"
                    step="1"
                    class="w-28 h-10 px-3 rounded-lg border bg-background text-sm tabular-nums focus:outline-none focus:border-primary transition-colors"
                    :class="retentionValid ? 'border-border' : 'border-destructive'"
                    :aria-invalid="!retentionValid"
                    @keydown.enter="saveAssistant"
                  ><span class="text-sm text-muted-foreground">{{ $t('settings.widget.retentionUnit') }}</span>
                </div>
                <p
                  class="text-[11px] mt-1.5"
                  :class="retentionValid ? 'text-muted-foreground' : 'text-destructive'"
                >
                  {{ retentionValid ? $t('settings.widget.retentionHint') : $t('settings.widget.retentionRange', { min: CONVERSATION_RETENTION_MIN_DAYS, max: CONVERSATION_RETENTION_MAX_DAYS }) }}
                </p>
              </div>
            </fieldset>
            <WidgetSaveBar
              :dirty="assistantDirty"
              :saving="savingSection === 'assistant'"
              :disabled="saving || !assistantValid"
              :error="assistantError"
              :saved="assistantSaved"
              @cancel="hydrateAssistant"
              @save="saveAssistant"
            />
          </section>
        </template>
      </div>
    </div>
    <WidgetRuleDialog
      v-model:open="dialogOpen"
      :initial="editingText"
      @submit="onRuleSubmit"
    />
    <Dialog v-model:open="limitOpen">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle class="font-heading">
            {{ $t('settings.widget.limitTitle') }}
          </DialogTitle><DialogDescription>{{ $t('settings.widget.limitDesc', { max: WIDGET_MAX_ENABLED_RULES }) }}</DialogDescription>
        </DialogHeader><DialogFooter>
          <button
            type="button"
            class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90"
            @click="limitOpen = false"
          >
            {{ $t('settings.widget.gotIt') }}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
/* One emphasis pulse: the outline strengthens, holds briefly, then fades back to none. */
.onboarding-install-pulse { animation: onboarding-install-pulse 1.6s ease-in-out; }
@keyframes onboarding-install-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--primary) 0%, transparent); }
  20%, 45% { box-shadow: 0 0 0 4px color-mix(in oklab, var(--primary) 35%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  .onboarding-install-pulse { animation-duration: 0.01s; }
}
</style>

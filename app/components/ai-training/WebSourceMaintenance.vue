<script setup lang="ts">
import type { AiTrainingSource } from '#layers/feedlog/shared/types/ai-training'
import { aiTrainingRunStatus } from '#layers/feedlog/shared/utils/ai-training'
import type { WebSourceFrequency } from '#layers/feedlog/shared/types/web-source'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '~/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Button } from '~/components/ui/button'
import { Switch } from '~/components/ui/switch'
const props = defineProps<{ source: AiTrainingSource | null; view: 'settings' | 'history'; busy: boolean; canManage: boolean }>()
const emit = defineEmits<{ close: []; save: [id: string, settings: { frequency: WebSourceFrequency; excludes: string; paused: boolean }] }>()
const { t, locale } = useI18n()
const settingsOpen = ref(false)
watch(() => props.source?.id, () => { settingsOpen.value = false })
const frequency = ref<WebSourceFrequency>('weekly'), paused = ref(false), excludes = ref('')
const error = ref('')
const control = 'h-9 rounded-lg border border-border bg-background px-3 text-[13px] outline-none focus:border-primary disabled:opacity-50'
// Polling may replace the source object; only actual settings changes reset the draft.
watch(() => JSON.stringify(props.source && [props.source.id, props.source.frequency, props.source.paused, props.source.excludes]), () => {
  if (!props.source) return
  frequency.value = props.source.frequency; paused.value = props.source.paused
  excludes.value = props.source.excludes
  error.value = ''
}, { immediate: true })
const changed = computed(() => props.source && (frequency.value !== props.source.frequency || (frequency.value !== 'manual' && paused.value) !== props.source.paused || excludes.value !== props.source.excludes))
const frequencyLabels = computed(() => ({ weekly: t('aiTraining.frequency.weekly'), biweekly: t('aiTraining.frequency.biweekly'), monthly: t('aiTraining.frequency.monthly'), manual: t('aiTraining.frequency.manual') }))
const format = (value?: string | null) => value ? new Intl.DateTimeFormat(locale.value === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai', hour12: false }).format(new Date(value)) : t('aiTraining.noSuccessfulUpdate')
const autoUpdate = computed({
  get: () => frequency.value !== 'manual' && !paused.value,
  set: (value: boolean) => { paused.value = !value; if (value && frequency.value === 'manual') frequency.value = 'weekly' },
})
function save() {
  if (excludes.value.split('\n').some(path => path.trim() && !path.trim().startsWith('/'))) { error.value = t('aiTraining.ui.enterOnePathPerLineStarting'); return }
  error.value = ''
  emit('save', props.source!.id, { frequency: frequency.value, excludes: excludes.value.trim(), paused: frequency.value !== 'manual' && paused.value })
}
function runResult(run: AiTrainingSource['runs'][number]) {
  return t('aiTraining.runs.' + aiTrainingRunStatus({ status: run.result, failed: run.failed, total: run.total }))
}
</script>
<template>
  <Dialog :open="!!source" @update:open="!$event && !busy && emit('close')">
    <DialogContent v-if="source" class="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]" :show-close-button="!busy" data-ai-training-maintenance @interact-outside="busy && $event.preventDefault()" @escape-key-down="busy && $event.preventDefault()">
      <DialogHeader class="shrink-0 border-b border-border px-6 py-5 text-left"><DialogTitle>{{ $t(view === 'settings' ? 'aiTraining.manage.syncSettings' : 'aiTraining.ui.syncHistory') }}</DialogTitle><DialogDescription class="truncate">{{ source.name }} · {{ source.url }}</DialogDescription></DialogHeader>
      <div v-if="view === 'history'" class="scrollbar-subtle min-h-0 flex-1 overflow-y-auto" data-ai-training-history>
        <div v-for="run in source.runs" :key="run.id" class="border-b border-border px-6 py-4"><div class="flex items-center justify-between gap-3 text-sm"><strong>{{ format(run.startedAt) }}</strong><span class="text-xs text-muted-foreground">{{ runResult(run) }}</span></div><p class="mt-2 text-xs text-muted-foreground"><template v-if="run.scope">{{ $t('aiTraining.runs.' + run.scope) }} · </template>{{ $t('aiTraining.runs.' + run.trigger) }} · {{ $t('aiTraining.ui.added') }} {{ run.added }} · {{ $t('aiTraining.ui.updated') }} {{ run.updated }} · {{ $t('aiTraining.ui.failed') }} {{ run.failed }}<template v-if="run.durationSeconds !== undefined"> · {{ $t('aiTraining.runs.duration', { seconds: run.durationSeconds }) }}</template></p></div>
        <p v-if="!source.runs.length" class="py-12 text-center text-sm text-muted-foreground">{{ $t('aiTraining.ui.resultsAppearHereAfterTheFirst') }}</p>
      </div>
      <template v-else>
        <div class="scrollbar-subtle space-y-5 overflow-y-auto px-6 py-5" data-ai-training-settings>
          <div class="flex flex-wrap items-center gap-3"><label for="detail-frequency" class="text-sm font-semibold">{{ $t('aiTraining.ui.automaticUpdates') }}</label><Select v-model="frequency" :disabled="!canManage || busy"><SelectTrigger id="detail-frequency"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="(label, value) in frequencyLabels" :key="value" :value="value">{{ label }}</SelectItem></SelectContent></Select><Switch v-model="autoUpdate" :aria-label="$t('aiTraining.ui.automaticUpdates')" :disabled="!canManage || busy" /></div>
          <button type="button" class="flex items-center gap-1.5 text-sm font-semibold" :aria-expanded="settingsOpen" aria-controls="web-source-crawl-settings" @click="settingsOpen = !settingsOpen"><Icon name="lucide:chevron-right" size="14" :class="settingsOpen && 'rotate-90'" />{{ $t('aiTraining.list.crawlSettings') }}</button>
          <div v-if="settingsOpen" id="web-source-crawl-settings" class="space-y-4">
            <div><label for="detail-excludes" class="mb-1.5 block text-xs font-semibold">{{ $t('aiTraining.ui.excludedPaths') }}</label><textarea id="detail-excludes" v-model="excludes" :class="control" class="h-auto w-full py-2" rows="4" placeholder="/blog&#10;/careers" :disabled="!canManage || busy || source.status === 'syncing'" /></div>
          </div>
          <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
        </div>
        <div class="flex shrink-0 justify-end gap-2 border-t border-border px-6 py-4"><Button variant="outline" :disabled="busy" @click="emit('close')">{{ $t('aiTraining.ui.cancel') }}</Button><Button :disabled="busy || !changed || !canManage" @click="save">{{ $t('aiTraining.list.saveSettings') }}</Button></div>
      </template>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { TrainingPageLoader } from '#layers/feedlog/shared/types/ai-training-api'
import type { AiTrainingItem, AiTrainingSource } from '#layers/feedlog/shared/types/ai-training'
import { Input } from '~/components/ui/input'
import { aiTrainingProcessingStatus, aiTrainingMatchesIndexFilter, aiTrainingWebsiteStatus, aiTrainingRunStatus } from '#layers/feedlog/shared/utils/ai-training'
import { webSourceFailureStage } from '#layers/feedlog/shared/utils/web-source-failure'
import { Button } from '~/components/ui/button'
import AiTrainingAiSwitch from './AiTrainingAiSwitch.vue'
import AiTrainingSelection from './AiTrainingSelection.vue'
import AiTrainingPagination from './AiTrainingPagination.vue'
import AiTrainingItemTime from './AiTrainingItemTime.vue'
import AiTrainingStatusBadge from './AiTrainingStateBadge.vue'
import type { AiTrainingSelectionState } from '~/composables/useAiTrainingSelection'
import { aiTrainingListLayout } from '~/lib/ai-training-layout'
const props = defineProps<{ source: AiTrainingSource; loadPage?: TrainingPageLoader; revision?: number; query?: string; openRequest?: boolean; items: AiTrainingItem[]; selection: AiTrainingSelectionState; allItems?: AiTrainingItem[]; canManage: boolean; busy: boolean; syncingPageIds?: ReadonlySet<string>; format: (value: string | null) => string; progress: { done: number; total: number; percent: number } }>()
const emit = defineEmits<{ preview: [item: AiTrainingItem]; sync: []; syncPage: [item: AiTrainingItem]; removePage: [item: AiTrainingItem]; settings: []; history: []; remove: []; retrySource: []; retryPages: [items: AiTrainingItem[]]; reference: [enabled: boolean] }>()
const expanded = defineModel<boolean>('expanded', { default: false })
const { t } = useI18n()
const statusFilter = ref('all'), pageQuery = ref('')
const filteredItems = computed(() => props.items.filter(item => `${item.title} ${item.url}`.toLowerCase().includes(pageQuery.value.trim().toLowerCase()) && aiTrainingMatchesIndexFilter(item, statusFilter.value)))
const failedItems = computed(() => (props.loadPage ? pageItems.value : filteredItems.value).filter(item => aiTrainingProcessingStatus(item) === 'failed'))
const local = useAiTrainingPagination(() => filteredItems.value, () => !props.loadPage)
const page = local.page
const remote = useAiTrainingRemotePage({ id: () => props.source.id, expanded: () => expanded.value, page, query: () => [props.query, pageQuery.value].filter(Boolean).join(' '), status: () => statusFilter.value, revision: () => props.revision, loader: () => props.loadPage })
const syncingRows = ref<ReadonlySet<string>>(new Set())
watch([() => props.syncingPageIds, remote.pending], ([ids, pending]) => {
  if (ids?.size) syncingRows.value = ids
  // Filtered/later pages finish loading after the overview and its page-one previews.
  else if (!pending) syncingRows.value = new Set()
}, { immediate: true })
const pageItems = computed(() => (props.loadPage ? remote.result.value.data : local.pageItems.value).map(item => syncingRows.value.has(item.id)
  ? { ...item, status: 'indexing' as const, syncStatus: 'pending' as const, error: undefined, errorCode: undefined, errorStage: undefined }
  : item))
const total = computed(() => props.loadPage ? remote.result.value.pagination.total : filteredItems.value.length)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / 10)))
const statusOptions = computed(() => [
  { value: 'all', label: t('aiTraining.ui.allStatuses') },
  { value: 'ready', label: t('aiTraining.ui.indexed') },
  { value: 'indexing', label: t('aiTraining.ui.indexing') },
  { value: 'failed', label: t('aiTraining.ui.indexFailed') },
])
watch([statusFilter, pageQuery], () => { page.value = 1; props.selection.chooseItems(props.items, false) })
watch(() => props.query, () => { page.value = 1 })
watch(() => props.openRequest, value => { if (value) expanded.value = true }, { immediate: true })
const selected = computed(() => props.selection.selected.value)
const eligible = computed(() => props.loadPage ? pageItems.value : filteredItems.value)
const scope = useAiTrainingScopeSelection({ id: () => props.source.id, items: () => filteredItems.value, total: () => props.source.pages?.total ?? filteredItems.value.length, query: () => [props.query, pageQuery.value].filter(Boolean).join(' '), status: () => statusFilter.value, revision: () => props.revision, loader: () => props.loadPage, selection: props.selection })
const checked = scope.checked
const choose = (id: string, value: boolean) => props.selection.choose(id, value)
async function chooseAll(value: boolean) {
  if (value) expanded.value = true
  await scope.choose(value)
}
const summaryItems = computed(() => props.allItems ?? props.items)
const showProgress = computed(() => props.source.status === 'syncing' && props.progress.total > 1)
const sourceDisplayStatus = computed(() => aiTrainingWebsiteStatus(props.source))
const failureCounts = computed(() => {
  const failed = props.source.pages?.failed ?? summaryItems.value.filter(item => aiTrainingProcessingStatus(item) === 'failed').length
  const fetchFailed = props.source.pages?.fetchFailed ?? summaryItems.value.filter(item => aiTrainingProcessingStatus(item) === 'failed' && webSourceFailureStage(item.errorCode ?? '', item.errorStage) === 'fetch').length
  return { failed, total: props.source.pages?.total ?? summaryItems.value.length, fetch: fetchFailed, index: props.source.pages?.indexFailed ?? Math.max(0, failed - fetchFailed) }
})
const failureSummary = computed(() => {
  const counts = failureCounts.value
  return [
    t('aiTraining.ui.failureSummary', counts),
    counts.fetch > 0 ? t('aiTraining.ui.fetchFailureSummary', counts) : null,
    counts.index > 0 ? t('aiTraining.ui.indexFailureSummary', counts) : null,
  ].filter(Boolean).join(' · ')
})
const sourceLabel = computed(() => sourceDisplayStatus.value === 'partial' ? t('aiTraining.ui.partialFailure', failureCounts.value)
  : sourceDisplayStatus.value === 'failed' ? t('aiTraining.ui.syncFailed', failureCounts.value) : undefined)
</script>
<template>
  <section class="border-b border-border last:border-b-0" :class="aiTrainingListLayout.root" data-ai-training-website :data-source-id="source.id">
    <div class="group grid grid-cols-[1.25rem_minmax(0,1fr)_auto_88px] items-center gap-x-3.5 py-3 pr-4 sm:pr-5" :class="aiTrainingListLayout.header">
      <AiTrainingSelection v-if="canManage" :checked="checked" :selecting="!!selected.size" :pending="scope.pending.value" :disabled="busy || !(source.pages?.total ?? eligible.length)" :label="statusFilter !== 'all' || pageQuery ? $t('aiTraining.manage.selectResults', { count: eligible.length }) : $t('aiTraining.manage.selectSource', { name: source.name })" @change="chooseAll" /><span v-else class="size-5 shrink-0" aria-hidden="true" />
      <button type="button" class="flex min-w-0 flex-1 items-center gap-3.5 text-left" :aria-expanded="expanded" :aria-controls="'web-source-' + source.id" data-ai-training-source-toggle @click="expanded = !expanded"><Icon name="lucide:chevron-right" size="16" class="shrink-0 text-muted-foreground transition-transform" :class="expanded && 'rotate-90'" /><span class="min-w-0 flex-1"><span class="flex flex-wrap items-center gap-2"><strong class="truncate text-sm font-bold">{{ source.name }}</strong><AiTrainingStatusBadge :status="sourceDisplayStatus" :label="sourceLabel" :title="sourceDisplayStatus === 'partial' ? $t('aiTraining.ui.somePagesFailedToSyncSuccessfully') : undefined" /></span><span class="mt-1 flex min-w-0 gap-x-3 text-xs text-muted-foreground" :title="failureCounts.failed ? failureSummary : undefined"><span class="max-w-[40%] shrink-0 truncate">{{ source.url }}</span><span class="min-w-0 truncate">{{ $t('aiTraining.list.pageCount', { count: source.pages?.total ?? summaryItems.length }) }} · {{ showProgress ? $t('aiTraining.list.processedPages', progress) : $t('aiTraining.list.lastSync') + ' ' + format(source.lastSuccess) }}</span><span v-if="failureCounts.failed && source.status !== 'syncing'" class="min-w-0 truncate" :title="failureSummary" data-ai-training-failure-summary>{{ failureSummary }}</span><span v-else-if="source.lastRun && source.status !== 'syncing'" class="min-w-0 truncate" :title="$t('aiTraining.runs.full') + ' · ' + format(source.lastFullSuccess ?? null)">{{ $t('aiTraining.runs.' + source.lastRun.scope) }} · {{ $t('aiTraining.runs.' + aiTrainingRunStatus(source.lastRun)) }}</span></span></span></button>
      <AiTrainingAiSwitch :enabled="source.aiEnabled !== false" :name="source.name" :disabled="busy || !canManage" @change="emit('reference', $event)" />
      <div class="flex w-[88px] shrink-0 items-center justify-end gap-1" data-ai-training-source-actions><Button v-if="canManage" size="icon-sm" variant="ghost" :disabled="busy || source.status === 'syncing'" :aria-label="$t('aiTraining.list.updateWebsite', { name: source.name })" :title="$t('aiTraining.ui.updateNow')" data-ai-training-source-sync @click="emit('sync')"><Icon name="lucide:refresh-cw" size="16" :class="source.status === 'syncing' && 'motion-safe:animate-spin'" /></Button><DropdownMenu><DropdownMenuTrigger as-child><Button size="icon-sm" variant="ghost" :aria-label="$t('aiTraining.list.websiteActions', { name: source.name })" data-ai-training-source-menu><Icon name="lucide:ellipsis" size="16" data-ai-training-source-menu-icon /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem v-if="canManage" @select="emit('settings')"><Icon name="lucide:settings-2" size="15" />{{ $t('aiTraining.manage.syncSettings') }}</DropdownMenuItem><DropdownMenuItem @select="emit('history')"><Icon name="lucide:history" size="15" />{{ $t('aiTraining.ui.syncHistory') }}</DropdownMenuItem><DropdownMenuSeparator v-if="canManage" /><DropdownMenuItem v-if="canManage" class="text-destructive" @select="emit('remove')"><Icon name="lucide:trash-2" size="15" />{{ $t('aiTraining.list.removeWebsite') }}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>
      <div v-if="showProgress" class="col-start-2 col-end-5 mt-3 min-w-0 pr-2 pl-[calc(16px_+_0.875rem)]" data-ai-training-source-progress>
        <div class="h-1 overflow-hidden rounded-full bg-secondary" role="progressbar" :aria-label="$t('aiTraining.list.syncProgress', { name: source.name })" :aria-valuenow="progress.done" :aria-valuemax="progress.total" aria-valuemin="0"><div class="h-full rounded-full bg-primary" :style="{ width: progress.percent + '%' }" /></div>
      </div>
    </div>
    <p v-if="scope.error.value" role="alert" class="px-5 py-3 text-sm text-destructive">{{ scope.error.value }}</p>

    <div v-if="expanded" :id="'web-source-' + source.id" class="border-t border-border" data-ai-training-webpages>
      <div class="flex flex-wrap items-center justify-between gap-3 py-3 pr-4 sm:pr-5" :class="aiTrainingListLayout.content" data-ai-training-website-filters>
        <div class="flex flex-wrap items-center gap-2"><FilterTag v-model="statusFilter" :label="$t('aiTraining.manage.indexStatus')" icon="lucide:list-filter" :options="statusOptions" :removable="false" data-ai-training-status-filter /><Button v-if="canManage && (loadPage ? source.pages?.failed : failedItems.length)" variant="ghost" size="sm" class="text-xs" :disabled="busy || source.status === 'syncing'" data-ai-training-retry-failed @click="loadPage ? emit('retrySource') : emit('retryPages', failedItems)"><Icon name="lucide:rotate-cw" size="13" />{{ $t('aiTraining.browse.retryFailed') }}</Button></div>
        <div class="relative w-full text-muted-foreground sm:w-64"><Icon name="lucide:search" size="14" class="absolute left-3 top-1/2 -translate-y-1/2" /><Input v-model="pageQuery" class="h-9 pl-9" :placeholder="$t('aiTraining.browse.searchPages')" :aria-label="$t('aiTraining.browse.searchPages')" data-ai-training-website-search /></div>
      </div>
      <p v-if="remote.error.value" role="alert" class="px-5 py-3 text-sm text-destructive">{{ remote.error.value }}</p>
      <div class="border-t border-border" data-ai-training-page-manager :aria-busy="remote.pending.value">
        <p v-if="remote.pending.value && !pageItems.length" role="status" class="flex min-h-24 items-center gap-2 py-6 text-sm text-muted-foreground" :class="aiTrainingListLayout.content" data-ai-training-list-loading><Icon name="lucide:loader-circle" size="16" class="motion-safe:animate-spin" />{{ $t('aiTraining.loading') }}</p>
          <div v-for="item in pageItems" :key="item.id" class="group flex flex-wrap items-center gap-3.5 border-b border-border py-3 pr-4 hover:bg-secondary/30 sm:pr-5" :class="[aiTrainingListLayout.row, selected.has(item.id) && 'bg-primary/5']" data-ai-training-document :data-document-id="item.id">
            <AiTrainingSelection v-if="canManage" :checked="selected.has(item.id)" :selecting="!!selected.size" :disabled="busy" :label="$t('aiTraining.manage.selectItem', { title: item.title })" @change="choose(item.id, $event)" /><span v-else class="size-5 shrink-0" />
            <button type="button" class="min-w-0 flex-1 text-left" :disabled="!item.indexedAt && item.status !== 'ready'" data-ai-training-content-title @click="emit('preview', item)"><strong class="block truncate text-sm font-semibold">{{ item.title || item.url }}</strong><span class="mt-1 block truncate text-xs text-muted-foreground">{{ item.url }}</span><span v-if="item.error" class="mt-1 block whitespace-normal text-xs leading-relaxed text-destructive">{{ item.error }}</span></button>
            <div class="ml-auto flex shrink-0 items-center gap-2 max-sm:basis-full max-sm:flex-wrap max-sm:justify-end"><AiTrainingStatusBadge appearance="inline" :status="item.syncStatus === 'pending' ? 'pending' : aiTrainingProcessingStatus(item)" :label="aiTrainingProcessingStatus(item) === 'failed' ? $t(webSourceFailureStage(item.errorCode ?? '', item.errorStage) === 'fetch' ? 'aiTraining.ui.fetchFailed' : 'aiTraining.ui.indexFailed') : undefined" />
              <Button v-if="canManage && aiTrainingProcessingStatus(item) === 'failed'" variant="ghost" size="icon-sm" :disabled="busy || source.status === 'syncing'" :aria-label="$t('aiTraining.browse.retryPage', { title: item.title })" :title="$t('aiTraining.retry')" @click="emit('syncPage', item)"><Icon name="lucide:rotate-cw" size="16" /></Button><Button v-else-if="canManage" size="icon-sm" variant="ghost" :disabled="busy || source.status === 'syncing' || aiTrainingProcessingStatus(item) === 'indexing'" :aria-label="$t('aiTraining.manage.syncPage', { title: item.title })" :title="$t('aiTraining.ui.updateNow')" @click="emit('syncPage', item)"><Icon name="lucide:refresh-cw" size="16" :class="aiTrainingProcessingStatus(item) === 'indexing' && 'motion-safe:animate-spin'" /></Button><Button size="icon-sm" variant="ghost" :disabled="!item.indexedAt && item.status !== 'ready'" :aria-label="$t('aiTraining.manage.previewItem', { title: item.title })" :title="$t('aiTraining.manage.preview')" @click="emit('preview', item)"><Icon name="lucide:eye" size="16" /></Button><Button v-if="canManage" size="icon-sm" variant="ghost" class="text-muted-foreground hover:text-destructive" :disabled="busy || source.status === 'syncing'" :aria-label="$t('aiTraining.manage.removePage', { title: item.title })" :title="$t('aiTraining.manage.deletePage')" @click="emit('removePage', item)"><Icon name="lucide:trash-2" size="16" /></Button><AiTrainingItemTime :value="item.lastSyncedAt" kind="sync" />
            </div>
          </div>
        <AiTrainingPagination v-if="total" v-model:page="page" :total="total" :page-count="pageCount" /><p v-else-if="!remote.pending.value && !remote.error.value" class="py-12 text-center text-sm text-muted-foreground">{{ $t('aiTraining.ui.noMatchingPages') }}</p>
      </div>
    </div>
  </section>
</template>

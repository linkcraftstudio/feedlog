<script setup lang="ts">
import type { TrainingPageLoader } from '#layers/feedlog/shared/types/ai-training-api'
import type { AiTrainingItem } from '#layers/feedlog/shared/types/ai-training'
import { aiTrainingAiEligible, aiTrainingMatchesHelpPublication } from '#layers/feedlog/shared/utils/ai-training'
import { Button } from '~/components/ui/button'
import { Switch } from '~/components/ui/switch'
import AiTrainingAiSwitch from './AiTrainingAiSwitch.vue'
import AiTrainingSelection from './AiTrainingSelection.vue'
import AiTrainingPagination from './AiTrainingPagination.vue'
import AiTrainingItemTime from './AiTrainingItemTime.vue'
import AiTrainingStatusBadge from './AiTrainingStateBadge.vue'
import type { AiTrainingSelectionState } from '~/composables/useAiTrainingSelection'
import { aiTrainingListLayout } from '~/lib/ai-training-layout'
const props = defineProps<{ id: string; loadPage?: TrainingPageLoader; revision?: number; articleCount?: number; aiUsableCount?: number; name: string; aiEnabled: boolean; items: AiTrainingItem[]; selection: AiTrainingSelectionState; query?: string; openRequest?: boolean; canManage: boolean; busy: boolean; changeVisibility: (items: AiTrainingItem[], enabled: boolean) => Promise<boolean | undefined> }>()
const emit = defineEmits<{ preview: [item: AiTrainingItem]; reference: [enabled: boolean] }>()
const expanded = defineModel<boolean>('expanded', { default: false })
const { t } = useI18n()
const publicationFilter = ref('all')
const filteredItems = computed(() => props.items.filter(item => aiTrainingMatchesHelpPublication(item, publicationFilter.value)))
const local = useAiTrainingPagination(() => filteredItems.value, () => !props.loadPage)
const page = local.page
const remote = useAiTrainingRemotePage({ id: () => props.id, expanded: () => expanded.value, page, query: () => props.query || '', status: () => publicationFilter.value, revision: () => props.revision, loader: () => props.loadPage })
const pageItems = computed(() => props.loadPage ? remote.result.value.data : local.pageItems.value)
const total = computed(() => props.loadPage ? remote.result.value.pagination.total : filteredItems.value.length)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / 10)))
const publicationOptions = computed(() => [
  { value: 'all', label: t('aiTraining.ui.allStatuses') },
  { value: 'published', label: t('help.admin.status.published') },
  { value: 'unpublished', label: t('aiTraining.manage.unpublished') },
])
watch(publicationFilter, () => { page.value = 1; props.selection.chooseItems(props.items, false) })
watch(() => props.query, () => { page.value = 1 })
watch(() => props.openRequest, value => { if (value) expanded.value = true }, { immediate: true })
const selected = computed(() => props.selection.selected.value)
const eligible = computed(() => (props.loadPage ? pageItems.value : filteredItems.value).filter(aiTrainingAiEligible))
const scope = useAiTrainingScopeSelection({ id: () => props.id, items: () => filteredItems.value, total: () => props.articleCount ?? filteredItems.value.length, query: () => props.query || '', status: () => publicationFilter.value, revision: () => props.revision, loader: () => props.loadPage, selection: props.selection })
const checked = scope.checked
const choose = (id: string, value: boolean) => props.selection.choose(id, value)
async function chooseAll(value: boolean) {
  if (value) expanded.value = true
  await scope.choose(value)
}
const used = computed(() => props.aiEnabled ? (props.aiUsableCount ?? props.items.filter(item => aiTrainingAiEligible(item) && item.enabled).length) : 0)
</script>
<template>
  <section class="border-b border-border last:border-b-0" :class="aiTrainingListLayout.root" data-ai-training-collection :data-collection-id="id">
    <div class="group flex items-center gap-3.5 py-3 pr-4 sm:pr-5" :class="aiTrainingListLayout.header">
      <AiTrainingSelection v-if="canManage" :checked="checked" :selecting="!!selected.size" :pending="scope.pending.value" :disabled="busy || !(articleCount ?? eligible.length)" :label="publicationFilter !== 'all' ? $t('aiTraining.manage.selectResults', { count: eligible.length }) : $t('aiTraining.manage.selectSource', { name })" @change="chooseAll" /><span v-else class="size-5 shrink-0" aria-hidden="true" />
      <button type="button" class="flex min-w-0 flex-1 items-center gap-3.5 text-left" :aria-expanded="expanded" :aria-controls="'ai-training-collection-' + id" data-ai-training-collection-toggle @click="expanded = !expanded"><Icon name="lucide:chevron-right" size="16" class="shrink-0 text-muted-foreground transition-transform" :class="expanded && 'rotate-90'" /><span class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"><strong class="text-sm font-bold">{{ name }}</strong><span class="text-xs text-muted-foreground">{{ $t('aiTraining.list.articleCount', { count: articleCount ?? items.length }) }} · {{ $t('aiTraining.manage.enabledArticles', { count: used }) }}</span></span></button>
      <AiTrainingAiSwitch :enabled="aiEnabled" :name="name" :disabled="busy || !canManage" @change="emit('reference', $event)" /><span class="w-[88px] shrink-0" aria-hidden="true" />
    </div>

    <p v-if="scope.error.value" role="alert" class="px-5 py-3 text-sm text-destructive">{{ scope.error.value }}</p>
    <div v-if="expanded" :id="'ai-training-collection-' + id" class="border-t border-border" :aria-busy="remote.pending.value" data-ai-training-collection-articles>
      <div class="flex flex-wrap items-center gap-2 border-b border-border py-3 pr-4 sm:pr-5" :class="aiTrainingListLayout.content" data-ai-training-article-filters><FilterTag v-model="publicationFilter" :label="$t('aiTraining.manage.publicationStatus')" icon="lucide:book-open-check" :options="publicationOptions" :removable="false" data-ai-training-publication-filter /></div>
      <p v-if="remote.error.value" role="alert" class="px-5 py-3 text-sm text-destructive">{{ remote.error.value }}</p>
      <p v-if="remote.pending.value && !pageItems.length" role="status" class="flex min-h-24 items-center gap-2 py-6 text-sm text-muted-foreground" :class="aiTrainingListLayout.content" data-ai-training-list-loading><Icon name="lucide:loader-circle" size="16" class="motion-safe:animate-spin" />{{ $t('aiTraining.loading') }}</p>
      <div v-for="item in pageItems" :key="item.id" class="group flex flex-wrap items-center gap-3.5 border-b border-border py-3 pr-4 last:border-b-0 hover:bg-secondary/30 sm:pr-5" :class="[aiTrainingListLayout.row, selected.has(item.id) && 'bg-primary/5']" data-ai-training-article :data-document-id="item.id">
        <AiTrainingSelection v-if="canManage" :checked="selected.has(item.id)" :selecting="!!selected.size" :disabled="busy" :label="$t('aiTraining.manage.selectItem', { title: item.title })" @change="choose(item.id, $event)" /><span v-else class="size-5 shrink-0" aria-hidden="true" />
        <button type="button" class="min-w-0 flex-1 truncate text-left text-sm font-semibold hover:text-primary" data-ai-training-content-title @click="emit('preview', item)">{{ item.title }}</button><div class="ml-auto flex shrink-0 items-center gap-2 max-sm:basis-full max-sm:flex-wrap max-sm:justify-end"><HelpStatusBadge v-if="item.publicationStatus" :status="item.publicationStatus" /><AiTrainingStatusBadge v-if="item.indexStatus" :status="item.indexStatus === 'failed' ? 'index_failed' : item.indexStatus" />
        <Switch :model-value="aiEnabled && item.enabled && aiTrainingAiEligible(item)" :disabled="!canManage || busy || !aiEnabled" :aria-label="$t('aiTraining.list.togglePage', { title: item.title })" :title="$t('aiTraining.ui.useForAi')" @update:model-value="changeVisibility([item], $event)" />
        <Button size="icon-sm" variant="ghost" :aria-label="$t('aiTraining.manage.previewItem', { title: item.title })" :title="$t('aiTraining.manage.preview')" @click="emit('preview', item)"><Icon name="lucide:eye" size="16" /></Button><AiTrainingItemTime :value="item.publishedAt" kind="published" /></div>
      </div>
      <AiTrainingPagination v-if="total" v-model:page="page" :total="total" :page-count="pageCount" />
      <p v-if="!total && !remote.pending.value && !remote.error.value" class="py-8 text-center text-sm text-muted-foreground">{{ $t('aiTraining.ui.noMatchingPages') }}</p>
    </div>
  </section>
</template>

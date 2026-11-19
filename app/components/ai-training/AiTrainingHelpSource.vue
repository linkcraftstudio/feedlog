<script setup lang="ts">
import type { TrainingHelpCollection, TrainingPageLoader } from '#layers/feedlog/shared/types/ai-training-api'
import type { AiTrainingItem } from '#layers/feedlog/shared/types/ai-training'
import { Button } from '~/components/ui/button'
import { aiTrainingAiEligible } from '#layers/feedlog/shared/utils/ai-training'
import AiTrainingHelpCollection from './AiTrainingHelpCollection.vue'
import AiTrainingBulkActions from './AiTrainingBulkActions.vue'
const props = defineProps<{ items: AiTrainingItem[]; nativeCollections?: TrainingHelpCollection[]; loadPage?: TrainingPageLoader; revision?: number; query?: string; openRequest?: boolean; canManage: boolean; busy: boolean; changeVisibility: (items: AiTrainingItem[], enabled: boolean) => Promise<boolean | undefined> }>()
const emit = defineEmits<{ preview: [item: AiTrainingItem]; collectionReference: [id: string, enabled: boolean] }>()
const { t } = useI18n()
const localePath = useLocalePath()
const selection = useAiTrainingSelection(() => props.items)
watch(() => props.canManage, value => { if (!value) selection.chooseAll(false) })
watch(() => props.query, () => selection.chooseAll(false))
async function applyVisibility(enabled: boolean) {
  if (await props.changeVisibility(selection.selectedItems.value, enabled)) selection.chooseAll(false)
}
const expanded = defineModel<boolean>('expanded', { default: false })
watch(() => props.openRequest, value => { if (value) expanded.value = true }, { immediate: true })
const articleCount = computed(() => props.nativeCollections?.reduce((sum, c) => sum + c.articleCount, 0) ?? props.items.length)
const used = computed(() => props.nativeCollections?.reduce((sum, c) => sum + c.aiUsableCount, 0) ?? props.items.filter(item => aiTrainingAiEligible(item) && item.enabled && item.collectionAiEnabled !== false).length)
const collections = computed(() => {
  if (props.nativeCollections) return props.nativeCollections.map(c => ({ ...c, items: props.items.filter(a => a.collectionId === c.id) }))
  const groups = new Map<string, { id: string; name: string; aiEnabled: boolean; articleCount?: number; aiUsableCount?: number; items: AiTrainingItem[] }>()
  for (const item of props.items) {
    const id = item.collectionId || 'unclassified'
    if (!groups.has(id)) groups.set(id, { id, name: item.collectionName || t('aiTraining.list.unclassified'), aiEnabled: item.collectionAiEnabled !== false, items: [] })
    groups.get(id)!.items.push(item)
  }
  return [...groups.values()]
})
</script>
<template>
  <section class="overflow-hidden rounded-xl border border-border bg-card shadow-sm" data-ai-training-help>
    <div class="flex items-center gap-3.5 px-4 py-3 sm:px-5">

      <button type="button" class="flex min-w-0 flex-1 items-center gap-3.5 text-left" :aria-expanded="expanded" aria-controls="ai-training-help-collections" data-ai-training-help-toggle @click="expanded = !expanded"><Icon name="lucide:chevron-right" size="16" class="shrink-0 text-muted-foreground transition-transform" :class="expanded && 'rotate-90'" /><span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-primary"><Icon name="lucide:book-open" size="16" /></span><span class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"><strong class="text-sm font-bold">{{ $t('nav.helpCenter') }}</strong><span class="text-xs text-muted-foreground">{{ $t('aiTraining.list.articleCount', { count: articleCount }) }} · {{ $t('aiTraining.manage.enabledArticles', { count: used }) }}</span></span></button>
      <div class="flex w-[88px] shrink-0 justify-end"><Button variant="outline" size="sm" as-child><NuxtLink :to="localePath('/dashboard/help')" target="_blank" rel="noopener noreferrer" :aria-label="$t('aiTraining.list.viewHelpCenter')" :title="$t('aiTraining.list.viewHelpCenter')">{{ $t('aiTraining.training.open') }}<Icon name="lucide:arrow-up-right" size="16" /></NuxtLink></Button></div>
    </div>
    <AiTrainingBulkActions v-if="canManage && selection.selectedItems.value.length" kind="help" :label="$t('help.admin.selected', { n: selection.selectedItems.value.length }, selection.selectedItems.value.length)" :busy="busy" @clear="selection.chooseAll(false)" @visibility="applyVisibility" />
    <div v-show="expanded" id="ai-training-help-collections" class="border-t border-border" data-ai-training-help-collections>
      <AiTrainingHelpCollection v-for="collection in collections" :id="collection.id" :key="collection.id" :load-page="loadPage" :revision="revision" :article-count="collection.articleCount" :ai-usable-count="collection.aiUsableCount" :name="collection.name" :items="collection.items" :query="query" :open-request="openRequest" :can-manage="canManage" :busy="busy" :selection="selection" :change-visibility="changeVisibility" :ai-enabled="collection.aiEnabled" @reference="emit('collectionReference', collection.id, $event)" @preview="emit('preview', $event)" />
      <p v-if="!collections.length" class="py-10 text-center text-sm text-muted-foreground" data-ai-training-help-empty>{{ $t(query?.trim() ? 'aiTraining.ui.noMatchingPages' : 'help.portal.emptyTitle') }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogDescription } from '~/components/ui/dialog'
import WebsiteSourceDialog from './WebSourceDialog.vue'
import AiTrainingHelpSource from './AiTrainingHelpSource.vue'
import WebSourceList from './WebSourceList.vue'
import AiTrainingBulkActions from './AiTrainingBulkActions.vue'
import AiTrainingContentPreview from './AiTrainingContentPreview.vue'
import WebSourceMaintenance from './WebSourceMaintenance.vue'
import { useAiTraining } from '~/composables/useAiTraining'
import type { AiTrainingSource } from '#layers/feedlog/shared/types/ai-training'
const { t } = useI18n()
const expandedSources = ref<Record<string, boolean>>({})
const websitesExpanded = ref(false)
const {
  helpCollections, revision, loadWebsitePage, loadHelpPage, state, search, typeFilter, addOpen, initialUrl, activeSource, detailView,
  previewId, previewItem, previewContent, previewLoading, previewError, loadPreview,
  loading, busy, syncingPageIds, errorMessage, canManage, filteredSources,
  sourceItems, sourceProgress, format, load, openAdd, openSource, closeSource,
  setVisibility, setAiReference, syncPages, removePages, syncPage, removePage, syncSource, retrySource, addSource, importPages, saveSource, requestRemoveSource,
} = useAiTraining()
const showHelp = computed(() => typeFilter.value !== 'website')
const showWebsites = computed(() => typeFilter.value !== 'help')
const websiteSelection = useAiTrainingSelection(() => state.value.items.filter(item => item.sourceId !== 'help'), () => true)
const websiteSyncBlocked = computed(() => websiteSelection.selectedItems.value.some(item => state.value.sources.some(source => source.id === item.sourceId && source.status === 'syncing')))
watch(canManage, value => { if (!value) websiteSelection.chooseAll(false) })
watch([search, typeFilter], () => websiteSelection.chooseAll(false))
async function syncSelectedPages() {
  if (await syncPages(websiteSelection.selectedItems.value)) websiteSelection.chooseAll(false)
}
async function removeSelectedPages() {
  if (await removePages(websiteSelection.selectedItems.value)) websiteSelection.chooseAll(false)
}
watch(search, value => { if (value.trim()) websitesExpanded.value = true })
watch(() => state.value.sources, sources => {
  const next = { ...expandedSources.value }
  for (const source of sources) if (!(source.id in next)) next[source.id] = false
  expandedSources.value = next
}, { immediate: true })
const websiteSources = computed(() => filteredSources.value.filter(source => source.kind === 'website'))
const websiteCount = computed(() => websiteSources.value.length)
const sourceOptions = computed(() => [
  { value: 'all', label: t('aiTraining.ui.allSources') }, { value: 'help', label: t('nav.helpCenter') }, { value: 'website', label: t('aiTraining.list.websiteSources') },
])
function displayItems(source: AiTrainingSource) {
  const q = search.value.trim().toLowerCase(), items = sourceItems(source.id)
  const matched = !q || `${source.name} ${source.url}`.toLowerCase().includes(q) ? items : items.filter(item => `${item.title} ${item.url} ${item.collectionName || ''}`.toLowerCase().includes(q))
  return matched
}
function focusPreview(event: Event) {
  event.preventDefault()
  ;(event.target as HTMLElement | null)?.focus()
}
</script>
<template>
  <div class="flex h-full min-h-0 flex-col" data-ai-training-page>
    <header class="dashboard-panel-page-header justify-between">
      <h2 class="font-heading text-lg font-bold">{{ $t('dashboard.agent.training') }}</h2>

    </header>
    <div v-if="!loading" class="shrink-0 border-b border-border bg-background/30" data-ai-training-toolbar>
      <div class="dashboard-panel-container flex flex-wrap items-center justify-between gap-3 py-4">
        <FilterTag v-model="typeFilter" :label="$t('aiTraining.list.sourceType')" icon="lucide:filter" :options="sourceOptions" :removable="false" />
        <div class="relative w-full text-muted-foreground sm:w-64"><Icon name="lucide:search" size="14" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" /><Input v-model="search" class="h-9 rounded-lg pl-9 pr-8 text-[13px]" :placeholder="$t('aiTraining.manage.searchWebSource')" :aria-label="$t('aiTraining.manage.searchWebSource')" /><button v-if="search" type="button" class="absolute right-2.5 top-1/2 -translate-y-1/2 hover:text-foreground" :aria-label="$t('aiTraining.ui.clearSearch')" @click="search = ''"><Icon name="lucide:x" size="13" /></button></div>
      </div>
    </div>
    <div class="scrollbar-subtle min-h-0 flex-1 overflow-y-auto bg-background/30">
      <div v-if="errorMessage" role="alert" class="flex items-center justify-between gap-3 border-b border-destructive/20 bg-destructive/5 px-6 py-3 text-sm text-destructive"><span>{{ errorMessage }}</span><Button variant="outline" size="sm" @click="load">{{ $t('aiTraining.retry') }}</Button></div>
      <p v-if="loading" role="status" class="py-16 text-center text-sm text-muted-foreground">{{ $t('aiTraining.loading') }}</p>
      <div v-else class="dashboard-panel-container dashboard-panel-stack dashboard-panel-stack--compact" data-ai-training-sources>
        <AiTrainingHelpSource v-if="showHelp" v-model:expanded="expandedSources.help" :items="sourceItems('help')" :native-collections="helpCollections" :load-page="loadHelpPage" :revision="revision" :query="search" :open-request="!!search" :can-manage="canManage" :busy="busy" :change-visibility="setVisibility" @collection-reference="(id, enabled) => setAiReference({ scope: 'collection', id, enabled })" @preview="previewId = $event.id" />
        <section v-if="showWebsites" class="dashboard-panel overflow-hidden" data-ai-training-websites>
          <div class="flex items-center gap-3.5 dashboard-panel-row">

            <button type="button" class="flex min-w-0 flex-1 items-center gap-3.5 text-left" :aria-expanded="websitesExpanded" aria-controls="ai-training-website-sources" data-ai-training-websites-toggle @click="websitesExpanded = !websitesExpanded"><Icon name="lucide:chevron-right" size="16" class="shrink-0 text-muted-foreground transition-transform" :class="websitesExpanded && 'rotate-90'" /><span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-primary"><Icon name="lucide:globe" size="16" /></span><span class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"><strong class="text-sm font-bold">{{ $t('aiTraining.list.websiteSources') }}</strong><span class="text-xs text-muted-foreground">{{ $t('aiTraining.list.sourceCount', { count: websiteCount }) }}</span></span></button>
            <div class="flex w-[88px] shrink-0 justify-end"><Button v-if="canManage" variant="outline" size="sm" :aria-label="$t('aiTraining.ui.addWebsite')" :title="$t('aiTraining.ui.addWebsite')" data-ai-training-add @click="openAdd()">{{ $t('aiTraining.training.add') }}<Icon name="lucide:plus" size="16" /></Button></div>
          </div>
          <AiTrainingBulkActions v-if="canManage && websiteSelection.selectedItems.value.length" kind="website" :label="$t('aiTraining.manage.selectedPages', { count: websiteSelection.selectedItems.value.length })" :busy="busy" :sync-blocked="websiteSyncBlocked" @clear="websiteSelection.chooseAll(false)" @sync="syncSelectedPages" @remove="removeSelectedPages" />
          <div v-show="websitesExpanded" id="ai-training-website-sources" class="border-t border-border" data-ai-training-website-sources>
            <WebSourceList v-for="source in websiteSources" :key="source.id" v-model:expanded="expandedSources[source.id]" :source="source" :load-page="loadWebsitePage" :syncing-page-ids="syncingPageIds" :revision="revision" :items="displayItems(source)" :all-items="sourceItems(source.id)" :query="search" :open-request="!!search" :can-manage="canManage" :busy="busy" :format="format" :progress="sourceProgress(source)" :selection="websiteSelection" @reference="setAiReference({ scope: 'source', id: source.id, enabled: $event })" @preview="previewId = $event.id" @sync="syncSource(source.id)" @sync-page="syncPage" @retry-pages="syncPages" @retry-source="retrySource(source.id)" @remove-page="removePage" @settings="openSource(source.id, 'settings')" @history="openSource(source.id, 'history')" @remove="requestRemoveSource(source.id)" />
            <p v-if="!websiteSources.length" class="py-10 text-center text-sm text-muted-foreground" data-ai-training-websites-empty>{{ $t(search ? 'aiTraining.ui.noMatchingSources' : 'aiTraining.list.noWebsites') }}</p>
          </div>
        </section>
      </div>
    </div>
    <WebsiteSourceDialog v-model:open="addOpen" :existing-sources="state.sources" :initial-url="initialUrl" :create-source="addSource" :import-pages="importPages" />
    <WebSourceMaintenance :source="activeSource" :view="detailView" :can-manage="canManage" :busy="busy" @close="closeSource" @save="saveSource" />
    <Dialog :open="!!previewItem" @update:open="!$event && (previewId = null)"><DialogContent v-if="previewItem" class="flex h-[min(800px,90dvh)] flex-col gap-0 overflow-hidden p-0 focus:outline-none sm:max-w-[960px] max-sm:h-dvh max-sm:w-screen max-sm:max-w-none max-sm:rounded-none" :show-close-button="false" data-ai-training-preview-dialog @open-auto-focus="focusPreview"><DialogTitle class="sr-only">{{ previewItem.title }}</DialogTitle><DialogDescription class="sr-only">{{ $t('aiTraining.manage.preview') }}</DialogDescription><AiTrainingContentPreview :item="previewItem" :content="previewContent" :loading="previewLoading" :error="previewError" :can-manage="canManage" @back="previewId = null" @retry="loadPreview" /><DialogClose type="button" class="absolute right-4 top-4 z-20 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background [&_svg]:pointer-events-none" :aria-label="$t('onboarding.guide.close')" data-ai-training-preview-close><Icon name="lucide:x" size="16" /></DialogClose></DialogContent></Dialog>
  </div>
</template>

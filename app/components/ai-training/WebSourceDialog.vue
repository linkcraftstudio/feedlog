<script setup lang="ts">
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '~/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import AiTrainingSelection from './AiTrainingSelection.vue'
import AiTrainingPagination from './AiTrainingPagination.vue'
import { webSourcePageTree, flattenWebSourcePageTree } from '#layers/feedlog/shared/utils/web-source-pages'
import { normalizeSourceUrl, aiTrainingError } from '~/composables/useAiTraining'
import type { AiTrainingSource } from '#layers/feedlog/shared/types/ai-training'
import type { WebSourceFrequency, WebSourceDraft } from '#layers/feedlog/shared/types/web-source'
const { t } = useI18n()
const props = defineProps<{ open: boolean; existingSources: AiTrainingSource[]; initialUrl?: string; createSource: (draft: WebSourceDraft) => Promise<string>; importPages: (input: { urls: string[]; frequency: WebSourceFrequency }) => Promise<string> }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; created: [id: string] }>()
const mode = ref('crawl'), links = ref('')
const step = ref(1), advanced = ref(false), submitting = ref(false), justCreated = ref(false)
const address = ref(''), name = ref(''), excludes = ref(''), error = ref(''), normalized = ref('')
const frequency = ref<WebSourceFrequency>('weekly')
const pageLimit = ref(200)
const detectedType = ref<AiTrainingSource['inputType']>('website')
const candidates = ref<{ title: string; url: string }[]>([]), selected = ref(new Set<string>())
const query = ref(''), opened = ref(new Set<string>())
const field = 'grid gap-1.5 text-sm', hint = 'text-xs leading-relaxed text-muted-foreground'
const frequencyLabels = computed(() => ({ weekly: t('aiTraining.frequency.weekly'), biweekly: t('aiTraining.frequency.biweekly'), monthly: t('aiTraining.frequency.monthly'), manual: t('aiTraining.frequency.manual') }))
const filtered = computed(() => candidates.value.filter(page => `${page.title} ${page.url}`.toLowerCase().includes(query.value.trim().toLowerCase())))
const treeRows = computed(() => flattenWebSourcePageTree(webSourcePageTree(filtered.value, Infinity), opened.value, !!query.value.trim()))
const { page, pageCount, pageItems } = useAiTrainingPagination(() => treeRows.value)
const allSelected = computed<boolean | 'mixed'>(() => { const count = filtered.value.filter(item => selected.value.has(item.url)).length; return !count ? false : count === filtered.value.length ? true : 'mixed' })
const displayName = computed(() => name.value.trim() || (normalized.value ? new URL(normalized.value).hostname : ''))
watch(query, () => { page.value = 1 })
watch(address, () => { error.value = '' })
watch(() => props.open, value => {
  if (!value) return
  step.value = 1; mode.value = 'crawl'; links.value = ''; advanced.value = false; submitting.value = false; justCreated.value = false
  address.value = props.initialUrl || ''; name.value = ''; excludes.value = ''; error.value = ''; normalized.value = ''
  frequency.value = 'weekly'; pageLimit.value = 200
  candidates.value = []; selected.value = new Set(); query.value = ''; opened.value = new Set(); page.value = 1
})
function choose(url: string, checked: boolean) { const next = new Set(selected.value); if (checked) next.add(url); else next.delete(url); selected.value = next }
function chooseAll(checked: boolean, items = filtered.value) { const next = new Set(selected.value); for (const item of items) { if (checked) next.add(item.url); else next.delete(item.url) } selected.value = next }
function toggleFolder(key: string) { const next = new Set(opened.value); if (next.has(key)) next.delete(key); else next.add(key); opened.value = next }
function folderChecked(items: { url: string }[]): boolean | 'mixed' { const count = items.filter(item => selected.value.has(item.url)).length; return !count ? false : count === items.length ? true : 'mixed' }
async function importLinks() {
  if (submitting.value) return
  submitting.value = true
  try {
    const entries = links.value.split(/\r?\n/).map(url => url.trim()).filter(Boolean)
    if (!entries.length || entries.length > 1000) throw new Error(t('aiTraining.browse.linksLimit'))
    let urls: string[]
    try { urls = [...new Set(entries.map(normalizeSourceUrl))] } catch { throw new Error(t('aiTraining.errors.invalid_url')) }
    const id = await props.importPages({ urls, frequency: frequency.value })
    justCreated.value = true; emit('update:open', false); await nextTick(); if (id) emit('created', id)
  } catch (cause) { error.value = aiTrainingError(cause, t) }
  finally { submitting.value = false }
}
async function discover() {
  if (submitting.value) return
  submitting.value = true
  try {
    let url: string
    try { url = normalizeSourceUrl(address.value) } catch { throw new Error(t('aiTraining.errors.invalid_url')) }
    if (props.existingSources.some(source => source.kind === 'website' && normalizeSourceUrl(source.url) === url)) throw new Error(t('aiTraining.ui.thisUrlIsAlreadyConnectedOpen'))
    if (!Number.isInteger(Number(pageLimit.value)) || pageLimit.value < 1 || pageLimit.value > 1000) throw new Error(t('aiTraining.ui.enterAWholeNumberFrom1'))
    if (excludes.value.split('\n').some(path => path.trim() && !path.trim().startsWith('/'))) throw new Error(t('aiTraining.ui.enterOnePathPrefixPerLine'))
    const result = await useApiFetch<{ url: string; inputType: AiTrainingSource['inputType']; pages: { title: string; url: string }[] }>('/api/admin/ai-training/websites/discover', { method: 'POST', body: { url, excludes: excludes.value, pageLimit: pageLimit.value } })
    if (!result.pages.length) throw new Error(t('aiTraining.ui.noMatchingPagesAdjustTheExclusions'))
    normalized.value = result.url; detectedType.value = result.inputType; candidates.value = result.pages
    selected.value = new Set(result.pages.map(item => item.url)); opened.value = new Set(); query.value = ''; page.value = 1
    error.value = ''; step.value = 2
  } catch (cause) { error.value = aiTrainingError(cause, t) }
  finally { submitting.value = false }
}
async function create() {
  if (submitting.value || !selected.value.size) return
  submitting.value = true
  try {
    const id = await props.createSource({ name: displayName.value, url: normalized.value, inputType: detectedType.value, frequency: frequency.value, excludes: excludes.value.trim(), pageLimit: pageLimit.value, pages: candidates.value.filter(item => selected.value.has(item.url)) })
    justCreated.value = true; emit('update:open', false); await nextTick(); emit('created', id)
  } catch (cause) { error.value = aiTrainingError(cause, t) }
  finally { submitting.value = false }
}
</script>
<template>
  <Dialog :open="open" @update:open="!submitting && emit('update:open', $event)">
    <DialogContent class="flex h-[min(600px,90dvh)] max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]" data-ai-training-add-dialog @close-auto-focus="justCreated && $event.preventDefault()">
      <DialogHeader class="shrink-0 px-6 pt-6 text-left"><DialogTitle class="flex items-center gap-2 text-lg">{{ $t('aiTraining.ui.addWebsite') }}</DialogTitle><DialogDescription>{{ step === 1 ? $t('aiTraining.browse.websiteHint') : normalized }}</DialogDescription></DialogHeader>
      <form v-if="step === 1" class="flex min-h-0 flex-1 flex-col" @submit.prevent="mode === 'crawl' ? discover() : importLinks()">
        <div class="scrollbar-subtle flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-4 pt-5" data-ai-training-import-fields>
        <ToggleGroup type="single" :spacing="1" class="w-full gap-0 rounded-lg border border-border bg-background p-1" :model-value="mode" :aria-label="$t('aiTraining.ui.addWebsite')" @update:model-value="value => { if (value === 'crawl' || value === 'individual') { mode = value; error = '' } }">
          <ToggleGroupItem v-for="option in (['crawl', 'individual'] as const)" :key="option" :value="option" class="h-8 flex-1 rounded-md px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground disabled:cursor-not-allowed">{{ $t(option === 'crawl' ? 'aiTraining.browse.crawlLinks' : 'aiTraining.browse.individualLinks') }}</ToggleGroupItem>
        </ToggleGroup>
        <div v-if="mode === 'individual'" :class="field"><label for="source-links" class="text-xs font-semibold">{{ $t('aiTraining.browse.pageUrls') }}</label><textarea id="source-links" v-model="links" required rows="4" class="scrollbar-subtle w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="https://example.com/getting-started&#10;https://example.com/pricing" /><p :class="hint">{{ $t('aiTraining.browse.oneUrlPerLine') }}</p></div>
        <div v-else :class="field"><label for="source-address" class="text-xs font-semibold">{{ $t('aiTraining.ui.websiteUrl') }}</label><Input id="source-address" v-model="address" required placeholder="https://docs.example.com" autocomplete="url" :aria-invalid="!!error" /></div>
        <div :class="field"><label for="source-frequency" class="text-xs font-semibold">{{ $t('aiTraining.ui.updateFrequency') }}</label><Select v-model="frequency"><SelectTrigger id="source-frequency" class="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="(label, value) in frequencyLabels" :key="value" :value="value">{{ label }}</SelectItem></SelectContent></Select></div>
        <button v-if="mode === 'crawl'" type="button" class="flex items-center gap-1.5 text-left text-xs font-semibold text-muted-foreground hover:text-foreground" :aria-expanded="advanced" aria-controls="source-advanced" @click="advanced = !advanced"><Icon name="lucide:chevron-right" size="14" :class="advanced && 'rotate-90'" />{{ $t('aiTraining.ui.advancedSettings') }}</button>
        <div v-if="advanced && mode === 'crawl'" id="source-advanced" class="grid gap-4 sm:grid-cols-2">
          <div v-if="mode === 'crawl'" :class="field" class="sm:col-span-2"><label for="source-name" class="text-xs font-semibold">{{ $t('aiTraining.ui.sourceName') }} <span class="font-normal text-muted-foreground">({{ $t('aiTraining.ui.optional') }})</span></label><Input id="source-name" v-model="name" :placeholder="$t('aiTraining.ui.forExampleProductDocumentation')" maxlength="80" /></div>

          <div v-if="mode === 'crawl'" :class="field" class="sm:col-span-2"><label for="source-excludes" class="text-xs font-semibold">{{ $t('aiTraining.ui.excludedPaths') }}</label><textarea id="source-excludes" v-model="excludes" class="w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] outline-none focus-visible:border-primary" rows="3" placeholder="/blog&#10;/careers" /><p :class="hint">{{ $t('aiTraining.ui.onePathPrefixPerLineThat') }}</p></div>
          <div v-if="mode === 'crawl'" :class="field"><label for="source-limit" class="text-xs font-semibold">{{ $t('aiTraining.ui.maximumPagesForThisSync') }}</label><Input id="source-limit" v-model.number="pageLimit" type="number" min="1" max="1000" /></div>

        </div>
        <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
        </div>
        <div class="flex shrink-0 justify-end gap-2 border-t border-border px-6 py-4"><Button type="button" variant="outline" :disabled="submitting" @click="emit('update:open', false)">{{ $t('aiTraining.ui.cancel') }}</Button><Button type="submit" :disabled="submitting"><Icon v-if="submitting" name="lucide:loader-circle" size="14" class="motion-safe:animate-spin" />{{ $t(mode === 'crawl' ? 'aiTraining.ui.discoverPages' : 'aiTraining.browse.importLinks') }}<Icon v-if="!submitting && mode === 'crawl'" name="lucide:arrow-right" size="14" /></Button></div>
      </form>
      <template v-else>
        <div class="flex shrink-0 flex-wrap items-center justify-between gap-3 px-6 py-4"><span class="text-xs text-muted-foreground">{{ $t('aiTraining.browse.selectedCount', { count: selected.size, total: candidates.length }) }}</span><div class="relative w-full text-muted-foreground sm:w-64"><Icon name="lucide:search" size="14" class="absolute left-3 top-1/2 -translate-y-1/2" /><Input v-model="query" class="h-9 pl-9" :placeholder="$t('aiTraining.browse.searchPages')" :aria-label="$t('aiTraining.browse.searchPages')" data-ai-training-discovery-search /></div></div>
        <div class="scrollbar-subtle mx-6 min-h-0 flex-1 overflow-y-auto rounded-lg border border-border [--ai-training-content-start:3.25rem]" data-ai-training-discovered>
          <div class="flex items-center gap-3 border-b border-border bg-background/30 px-4 py-2.5"><AiTrainingSelection :checked="allSelected" :disabled="!filtered.length" :selecting="true" :label="$t('aiTraining.ui.selectAllPages')" @change="chooseAll($event)" /><span class="text-xs font-semibold">{{ $t('aiTraining.browse.allPages') }}</span><span class="ml-auto text-xs text-muted-foreground">{{ filtered.length }}</span></div>
          <div v-for="node in pageItems" :key="node.key" class="flex items-center gap-3 border-b border-border py-3 pr-4 last:border-b-0 hover:bg-background/50" :style="{ paddingLeft: 16 + node.depth * 20 + 'px' }" :data-ai-training-candidate="node.kind === 'page' ? '' : undefined" :data-ai-training-folder="node.kind === 'folder' ? node.key : undefined">
            <button v-if="node.kind === 'folder'" type="button" class="flex size-4 shrink-0 items-center justify-center text-muted-foreground" :aria-label="$t('aiTraining.browse.toggleDirectory', { path: node.key })" :aria-expanded="opened.has(node.key) || !!query.trim()" @click="toggleFolder(node.key)"><Icon name="lucide:chevron-right" size="14" :class="(opened.has(node.key) || query.trim()) && 'rotate-90'" /></button><span v-else class="w-4 shrink-0" />
            <AiTrainingSelection :checked="node.kind === 'folder' ? folderChecked(node.pages) : selected.has(node.page.url)" :selecting="true" :label="$t('aiTraining.manage.selectItem', { title: node.label })" @change="node.kind === 'folder' ? chooseAll($event, node.pages) : choose(node.page.url, $event)" />
            <button v-if="node.kind === 'folder'" type="button" class="flex min-w-0 flex-1 items-center gap-3 text-left text-sm font-semibold" @click="toggleFolder(node.key)"><span class="truncate">{{ node.label }}</span><span class="text-xs font-normal text-muted-foreground">{{ node.pages.length }}</span></button>
            <span v-else class="min-w-0"><strong class="block truncate text-sm font-semibold">{{ node.label }}</strong><small v-if="node.page.title" class="mt-1 block truncate text-xs text-muted-foreground">{{ node.page.title }}</small></span>
          </div>
          <AiTrainingPagination v-if="treeRows.length" v-model:page="page" :total="treeRows.length" :page-count="pageCount" /><p v-else class="py-12 text-center text-sm text-muted-foreground">{{ $t('aiTraining.ui.noMatchingPages') }}</p>
        </div>
        <p v-if="error" role="alert" class="shrink-0 px-6 py-3 text-sm text-destructive">{{ error }}</p><div class="mt-4 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border px-6 py-4"><Button variant="outline" :disabled="submitting" @click="step = 1"><Icon name="lucide:arrow-left" size="14" />{{ $t('aiTraining.ui.back') }}</Button><div class="flex items-center gap-3"><Button :disabled="submitting || !selected.size" @click="create"><Icon v-if="submitting" name="lucide:loader-circle" size="14" class="motion-safe:animate-spin" />{{ $t('aiTraining.ui.addAndStartSync') }}</Button></div></div>
      </template>
    </DialogContent>
  </Dialog>
</template>

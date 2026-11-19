import type { z } from 'zod'
import { webSourceFailureCode } from '#layers/feedlog/shared/utils/web-source-failure'
import type { aiTrainingReference } from '#layers/feedlog/shared/schemas/ai-training'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { aiTrainingAiEligible } from '#layers/feedlog/shared/utils/ai-training'
import type { AiTrainingItem, AiTrainingSource } from '#layers/feedlog/shared/types/ai-training'
import type { AiTrainingOverview, TrainingHelpCollection, TrainingPageLoader, TrainingPageQuery, TrainingPageResult } from '#layers/feedlog/shared/types/ai-training-api'
import type { WebSourceDraft, WebSourceFrequency } from '#layers/feedlog/shared/types/web-source'

export function normalizeSourceUrl(value: string) {
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Enter a public HTTP or HTTPS address.')
  url.hash = ''
  return url.pathname === '/' ? url.href.replace(/\/$/, '') : url.href
}
export function aiTrainingError(error: unknown, translate?: (key: string, params?: Record<string, string>) => string) {
  const e = error as { data?: { data?: { code?: string }; message?: string }; message?: string }
  const code = e.data?.data?.code
  if (translate && code) {
    const status = /^(http|provider|cleanup_provider)_(\d{3})$/.exec(code)
    const key = 'aiTraining.errors.' + (status ? status[1] : code)
    const message = translate(key, status ? { status: status[2]! } : undefined)
    if (message !== key) return message
  }
  if (!e.data && error instanceof Error && error.name !== 'FetchError') return error.message
  return e.data?.message || (translate ? translate('aiTraining.errors.operation_failed') : e.message || 'Unable to complete the operation.')
}
export function useAiTraining() {
  const { t } = useI18n()
  const { confirm } = useConfirmDialog()
  const { canModerate: canManage } = usePermission(computed(() => undefined), 'post')
  const route = useRoute(), router = useRouter()
  const state = ref<{ sources: AiTrainingSource[]; items: AiTrainingItem[] }>({ sources: [], items: [] })
  const helpCollections = ref<TrainingHelpCollection[]>([]), revision = ref(0)
  const runHistory = ref<Record<string, AiTrainingSource['runs']>>({})
  const loading = ref(true), busy = ref(false), errorMessage = ref('')
  const syncingPageIds = ref(new Set<string>())
  const search = ref(''), typeFilter = ref('all')
  const addOpen = ref(false), initialUrl = ref('')
  const activeSourceId = ref<string | null>(null)
  const detailView = ref<'settings' | 'history'>('settings')
  const previewId = ref<string | null>(null)
  const previewContent = ref(''), previewLoading = ref(false), previewError = ref('')
  let poll: ReturnType<typeof setInterval> | undefined
  let disposed = false, previewRequest = 0
  let loadingRequest: Promise<void> | undefined
  let firstPages = new Map<string, Promise<TrainingPageResult>>()

  const activeSource = computed(() => state.value.sources.find(source => source.id === activeSourceId.value) || null)
  const itemsBySource = computed(() => {
    const groups = new Map<string, AiTrainingItem[]>()
    for (const item of state.value.items) {
      const group = groups.get(item.sourceId) ?? []
      group.push(item); groups.set(item.sourceId, group)
    }
    return groups
  })
  const emptyItems: AiTrainingItem[] = []
  const sourceItems = (id: string) => itemsBySource.value.get(id) ?? emptyItems
  const previewItem = computed(() => state.value.items.find(item => item.id === previewId.value) || null)
  const filteredSources = computed(() => state.value.sources.filter(source => {
    const q = search.value.trim().toLowerCase()
    return (!q || `${source.name} ${source.url}`.toLowerCase().includes(q) || sourceItems(source.id).some(item => `${item.title} ${item.url} ${item.collectionName || ''}`.toLowerCase().includes(q)))
      && (typeFilter.value === 'all' || source.kind === typeFilter.value)
  }))
  const sourceProgress = (source: AiTrainingSource) => {
    const run = source.activeRun ?? source.runs[0]
    const total = run?.total ?? 0
    const done = run?.processed ?? 0
    return { total, done: Math.min(done, total), percent: total ? Math.min(100, done / total * 100) : 0 }
  }
  const format = (value: string | null) => value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value)) : t('aiTraining.noSuccessfulUpdate')

  async function load() {
    if (disposed) return
    if (loadingRequest) return loadingRequest
    loadingRequest = (async () => {
      try {
        const [websites, help] = await Promise.all([
          useApiFetch<AiTrainingOverview>('/api/admin/ai-training'),
          useApiFetch<{ data: TrainingHelpCollection[] }>('/api/admin/help/collections', { query: { flat: 1 } }),
        ])
        if (disposed) return
        helpCollections.value = help.data
        // Presentation adapters stay in the UI; the server does not invent a help website.
        const helpSection: AiTrainingSource = { id: 'help', name: t('nav.helpCenter'), kind: 'help', url: '', inputType: 'website', status: 'ready', frequency: 'manual', paused: false, excludes: '', aiEnabled: true, lastSuccess: null, nextRun: null, runs: [] }
        state.value = { sources: [helpSection, ...websites.sources.websites.map(website => ({ ...website, kind: 'website' as const,
          lastSuccess: website.lastSyncedAt, runs: runHistory.value[website.id] ?? (website.activeRun ? [{ ...website.activeRun, result: website.activeRun.status }] : []),
        }))], items: state.value.items.filter(item => item.sourceId === 'help' ? help.data.some(collection => collection.id === item.collectionId) : websites.sources.websites.some(website => website.id === item.sourceId)) }
        firstPages = new Map()
        // Prepare list previews before showing headings, just like Help Center.
        const previews = [
          ...websites.sources.websites.map(website => () => loadWebsitePage(website.id, { page: 1 })),
          ...help.data.map(collection => () => loadHelpPage(collection.id, { page: 1 })),
        ]
        let nextPreview = 0
        await Promise.all(Array.from({ length: Math.min(4, previews.length) }, async () => {
          while (!disposed && nextPreview < previews.length) {
            const preview = previews[nextPreview++]!
            // A failed preview must not hide the other sources.
            try { await preview() } catch { /* Keep the other sources available. */ }
          }
        }))
        if (disposed) return
        revision.value++
        errorMessage.value = ''
      } catch (error) { errorMessage.value = aiTrainingError(error, t) }
      finally { loading.value = false }
    })()
    try { await loadingRequest } finally { loadingRequest = undefined }
  }
  onMounted(async () => {
    window.addEventListener('focus', load)
    await load()
    if (disposed) return
    if (typeof route.query.connect === 'string' && canManage.value) openAdd(route.query.connect)
    if ('connect' in route.query || 'tab' in route.query) {
      const query = { ...route.query }
      delete query.connect; delete query.tab
      await router.replace({ query })
    }
    poll = setInterval(() => { if (!document.hidden && (state.value.sources.some(s => s.status === 'syncing') || state.value.items.some(item => item.sourceId === 'help' && item.indexStatus === 'indexing'))) void load() }, 3000)
  })
  onBeforeUnmount(() => { disposed = true; clearInterval(poll); previewRequest++; window.removeEventListener('focus', load) })

  async function loadPreview() {
    const item = previewItem.value, request = ++previewRequest
    previewContent.value = ''; previewError.value = ''
    if (!item || item.sourceId !== 'help' && !item.indexedAt && item.status !== 'ready') { previewLoading.value = false; return }
    previewLoading.value = true
    try {
      const url = item.sourceId === 'help' ? `/api/admin/help/articles/${item.id}` : `/api/admin/ai-training/websites/pages/${item.id}`
      const detail = await useApiFetch<{ content: string }>(url)
      if (!disposed && request === previewRequest) previewContent.value = detail.content
    } catch (error) { if (request === previewRequest) previewError.value = aiTrainingError(error, t) }
    finally { if (request === previewRequest) previewLoading.value = false }
  }
  watch([previewId, () => previewItem.value?.updatedAt], loadPreview)
  watch(activeSourceId, () => { previewId.value = null })
  function openAdd(url = '') { initialUrl.value = url; addOpen.value = true }
  function openSource(id: string, view: 'settings' | 'history' = 'settings') {
    previewId.value = null; detailView.value = view; activeSourceId.value = id
    if (view === 'history') void loadHistory(id)
  }
  function closeSource() { activeSourceId.value = null; previewId.value = null }
  async function operation(action: () => Promise<unknown>) {
    if (busy.value) return
    busy.value = true
    try { await action(); if (loadingRequest) await loadingRequest; await load(); return true }
    catch (error) { toast.error(aiTrainingError(error, t)); return false }
    finally { busy.value = false }
  }
  async function syncOperation(items: AiTrainingItem[], action: () => Promise<unknown>) {
    if (busy.value) return
    // Show feedback throughout the request and refresh, without changing stored page results.
    syncingPageIds.value = new Set(items.map(item => item.id))
    try { return await operation(action) }
    finally {
      // Let row loaders consume the refreshed results before removing the pending overlay.
      await nextTick()
      syncingPageIds.value = new Set()
    }
  }
  async function setVisibility(items: AiTrainingItem[], enabled: boolean) {
    if (!canManage.value) return
    const eligible = items.filter(item => item.sourceId === 'help' && (!enabled || aiTrainingAiEligible(item)))
    if (!eligible.length) return
    return operation(async () => {
      const result = await useApiFetch<{ affected: number; skipped: number }>('/api/admin/help/articles/bulk-ai-visibility', {
        method: 'POST', body: { ids: eligible.map(item => item.id), aiEnabled: enabled },
      })
      toast.success(t('aiTraining.manage.visibilityResult', { affected: result.affected, skipped: items.length - eligible.length + result.skipped }))
    })
  }
  async function setAiReference(input: z.infer<typeof aiTrainingReference>) {
    if (!canManage.value) return
    return operation(() => input.scope === 'collection'
      ? useApiFetch(`/api/admin/help/collections/${input.id}`, { method: 'PATCH', body: { aiEnabled: input.enabled } })
      : useApiFetch(`/api/admin/ai-training/websites/${input.id}/ai-reference`, { method: 'PATCH', body: { enabled: input.enabled } }))
  }
  async function syncPages(items: AiTrainingItem[]) {
    if (!canManage.value) return
    const pages = items.filter(item => item.sourceId !== 'help')
    const ids = pages.map(item => item.id)
    if (!ids.length) return
    return syncOperation(pages, async () => {
      const result = await useApiFetch<{ affected: number }>('/api/admin/ai-training/websites/pages/sync', { method: 'POST', body: { ids } })
      toast.success(t('aiTraining.manage.bulkSyncStarted', { count: result.affected }))
    })
  }
  async function removePages(items: AiTrainingItem[]) {
    if (!canManage.value) return
    const ids = items.filter(item => item.sourceId !== 'help').map(item => item.id)
    if (!ids.length) return
    const { confirm } = useConfirmDialog()
    if (!await confirm({ title: t('aiTraining.manage.bulkDeleteTitle', { count: ids.length }), description: t('aiTraining.manage.bulkDeleteDescription'), confirmText: t('aiTraining.manage.deletePage'), cancelText: t('aiTraining.ui.cancel'), variant: 'destructive' })) return
    return operation(async () => {
      await useApiFetch('/api/admin/ai-training/websites/pages/remove', { method: 'POST', body: { ids } })
      const removed = new Set(ids)
      state.value.items = state.value.items.filter(item => !removed.has(item.id))
    })
  }
  async function syncPage(item: AiTrainingItem) {
    if (!canManage.value || item.sourceId === 'help') return
    return syncOperation([item], () => useApiFetch(`/api/admin/ai-training/websites/pages/${item.id}/sync`, { method: 'POST' }))
  }
  async function removePage(item: AiTrainingItem) {
    if (!canManage.value || item.sourceId === 'help') return
    const { confirm } = useConfirmDialog()
    if (!await confirm({ title: t('aiTraining.manage.deletePage'), description: t('aiTraining.manage.deletePageDescription', { title: item.title }), confirmText: t('aiTraining.manage.deletePage'), cancelText: t('aiTraining.ui.cancel'), variant: 'destructive' })) return
    return operation(async () => {
      await useApiFetch(`/api/admin/ai-training/websites/pages/${item.id}`, { method: 'DELETE' })
      state.value.items = state.value.items.filter(cached => cached.id !== item.id)
      if (previewId.value === item.id) previewId.value = null
    })
  }
  async function retrySource(id: string) {
    if (!canManage.value) return
    return syncOperation(sourceItems(id).filter(item => item.syncStatus === 'failed' || item.status === 'failed'), () => useApiFetch(`/api/admin/ai-training/websites/${id}/retry`, { method: 'POST' }))
  }
  async function syncSource(id: string) {
    if (!canManage.value) return
    return syncOperation(sourceItems(id), () => useApiFetch(`/api/admin/ai-training/websites/${id}/sync`, { method: 'POST' }))
  }
  async function addSource(draft: WebSourceDraft) {
    const result = await useApiFetch<{ id: string }>('/api/admin/ai-training/websites', { method: 'POST', body: draft })
    await load()
    // Open the website after the creation dialog has closed, so focus transfers once.
    return result.id
  }
  async function importPages(input: { urls: string[]; frequency: WebSourceFrequency }) {
    const result = await useApiFetch<{ sourceIds: string[]; added: number; skipped: number }>('/api/admin/ai-training/websites/pages/import', { method: 'POST', body: input })
    await load()
    toast.success(t('aiTraining.browse.importResult', { added: result.added, skipped: result.skipped }))
    return result.sourceIds[0] || ''
  }
  async function saveSource(id: string, settings: { frequency: WebSourceFrequency; excludes: string; paused: boolean }) {
    if (!canManage.value) return
    const saved = await operation(() => useApiFetch(`/api/admin/ai-training/websites/${id}`, { method: 'PATCH', body: settings }))
    if (saved) closeSource()
  }
  async function requestRemoveSource(id: string) {
    if (!canManage.value || busy.value) return
    const source = state.value.sources.find(source => source.id === id)
    if (!source) return
    const confirmed = await confirm({
      title: t('aiTraining.list.removeWebsiteQuestion'),
      description: t('aiTraining.list.removeWebsiteDescription', { name: source.name, count: source.pages?.total ?? sourceItems(id).length }),
      cancelText: t('aiTraining.ui.cancel'),
      confirmText: t('aiTraining.ui.removeSourceAndWebSource'),
      variant: 'destructive',
    })
    if (!confirmed || !canManage.value || busy.value) return
    const removed = await operation(() => useApiFetch(`/api/admin/ai-training/websites/${id}`, { method: 'DELETE' }))
    if (removed && activeSourceId.value === id) closeSource()
  }
  function rememberPage(items: AiTrainingItem[]) {
    // Keep loaded pages available to selection when another page or collection loads.
    const cached = new Map(state.value.items.map(item => [item.id, item]))
    for (const item of items) cached.set(item.id, item)
    state.value.items = [...cached.values()]
  }
  function loadPage(kind: 'website' | 'help', id: string, query: TrainingPageQuery, fetcher: TrainingPageLoader): Promise<TrainingPageResult> {
    const cache = firstPages
    const key = JSON.stringify([kind, id, query.q || '', query.status || 'all'])
    const first = query.page === 1 && (query.pageSize ?? 10) === 10
    const cached = first ? cache.get(key) : undefined
    if (cached) return cached
    const request = fetcher(id, query).then(result => {
      if (!disposed && cache === firstPages) rememberPage(result.data)
      return result
    })
    if (first) {
      cache.set(key, request)
      void request.catch(() => { if (cache.get(key) === request) cache.delete(key) })
    }
    return request
  }
  function loadWebsitePage(id: string, query: TrainingPageQuery) { return loadPage('website', id, query, fetchWebsitePage) }
  function loadHelpPage(id: string, query: TrainingPageQuery) { return loadPage('help', id, query, fetchHelpPage) }
  async function fetchWebsitePage(id: string, query: TrainingPageQuery): Promise<TrainingPageResult> {
    const result = await useApiFetch<{ data: { id: string; websiteId: string; title: string; url: string; status: AiTrainingItem['status']; syncStatus: AiTrainingItem['syncStatus']; indexedAt: string | null; lastSyncedAt: string | null; updatedAt: string; errorCode?: string; errorStage?: 'fetch' | 'index' | null }[]; pagination: TrainingPageResult['pagination'] }>(`/api/admin/ai-training/websites/${id}/pages`, { query: { ...query, pageSize: query.pageSize ?? 10 } })
    const data = result.data.map(item => ({ ...item, sourceId: item.websiteId, enabled: true, content: '', error: item.errorCode ? aiTrainingError({ data: { data: { code: webSourceFailureCode(item.errorCode) } } }, t) : undefined }))
    return { ...result, data }
  }
  async function fetchHelpPage(id: string, query: TrainingPageQuery): Promise<TrainingPageResult> {
    const result = await useApiFetch<{ data: { id: string; title: string; shortId: string; slug: string; status: 'draft' | 'published' | 'archived'; aiEnabled: boolean; indexStatus?: AiTrainingItem['indexStatus']; updatedAt: string; publishedAt: string | null; collection: { id: string; name: string; aiEnabled: boolean } }[]; pagination: TrainingPageResult['pagination'] }>('/api/admin/help/articles', { query: { ...query, status: query.status === 'all' ? undefined : query.status, collectionId: id, pageSize: query.pageSize ?? 10 } })
    const data = result.data.map(article => ({ id: article.id, title: article.title, url: `/help/${article.shortId}-${article.slug}`, sourceId: 'help', enabled: article.aiEnabled, status: 'ready' as const, content: '', updatedAt: article.updatedAt, publishedAt: article.publishedAt, publicationStatus: article.status, indexStatus: article.indexStatus, collectionId: article.collection.id, collectionName: article.collection.name, collectionAiEnabled: article.collection.aiEnabled }))
    return { ...result, data }
  }
  async function loadHistory(id: string) {
    try {
      const result = await useApiFetch<{ data: AiTrainingSource['runs'] }>(`/api/admin/ai-training/websites/${id}/runs`)
      const source = state.value.sources.find(s => s.id === id)
      runHistory.value[id] = result.data
      if (source) source.runs = result.data
    } catch (error) { toast.error(aiTrainingError(error, t)) }
  }
  return {
    helpCollections, revision, loadWebsitePage, loadHelpPage,
    state, search, typeFilter, addOpen, initialUrl, activeSource, activeSourceId, detailView,
    previewId, previewItem, previewContent, previewLoading, previewError, loadPreview,
    loading, busy, syncingPageIds, errorMessage, canManage, filteredSources,
    sourceItems, sourceProgress, format, load, openAdd, openSource, closeSource,
    setVisibility, setAiReference, syncPages, removePages, syncPage, removePage, syncSource, retrySource, addSource, importPages, saveSource, requestRemoveSource,
  }
}

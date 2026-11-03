<script setup lang="ts">
import WidgetEmbedImage from './WidgetEmbedImage.vue'
import { prepareChatImage } from '#layers/feedlog/app/utils/chat-image'
import { ChatImageError, CHAT_IMAGE_MAX_COUNT, CHAT_IMAGE_TOTAL_BYTES } from '#layers/feedlog/shared/agent/images'
import type { ChatInput, Content, Detail, Item, Run } from '#layers/feedlog/shared/agent/content'
import { readAgentEvents } from '#layers/feedlog/shared/agent/sse'
import { widgetEmbedKey } from '#layers/feedlog/app/composables/useWidgetEmbed'
import { widgetProtocolKey } from '#layers/feedlog/app/composables/useWidgetProtocol'
import type { WidgetChatResume } from '#layers/feedlog/app/composables/useWidgetResume'


const props = defineProps<{
  productName: string; openId: string | null; resumeState?: WidgetChatResume | null
}>()
const emit = defineEmits<{ authRequired: []; filed: []; replied: [id: string, lastSeq: number]; started: [id: string]; busy: [value: boolean]; stateChange: [state: WidgetChatResume] }>()
const { t } = useI18n()
const messageTime = useConversationTime()
const messageAuthor = (item: Item) => item.authorType === 'customer' ? t('widget.messageYou') : item.authorType === 'agent' ? t('widget.messageAI') : item.author?.name ? t('widget.messageStaffNamed', { name: item.author.name }) : t('widget.messageStaff')
const { user, widgetFetch, widgetRequest, ensureIdentity, imageMaxBytes } = inject(widgetEmbedKey)!
const protocol = inject(widgetProtocolKey, null)
const apiBase = '/api/widget/conversations'
const conversationId = ref<string | null>(null)
const items = ref<Item[]>([])
const runs = ref<Run[]>([])
const nextBeforeSeq = ref<number | null>(null)
const draft = ref('')
const sending = ref(false)
const retrying = ref(false)
const awaitingRun = ref(false)
const loadingThread = ref(false)
const transient = ref('')
const failure = ref('')
const pending = ref<ChatInput | null>(null)
const articleSlug = ref<string | null>(null)
const observedSeq = ref(0)
let chatActive = true
function reportRead(id: string) {
  if (chatActive && !document.hidden && !articleSlug.value && observedSeq.value > 0) emit('replied', id, observedSeq.value)
}
const handlingMode = ref<'ai' | 'human' | 'closed'>('ai')
const bodyEl = ref<HTMLElement | null>(null)
const draftEl = ref<HTMLTextAreaElement | null>(null)
const latestRun = computed(() => runs.value.at(-1))
const busy = computed(() => sending.value || (handlingMode.value === 'ai' && latestRun.value?.status === 'running'))
const silentHandoff = computed(() => latestRun.value?.error === 'support_unavailable')
const failedReply = computed(() => !sending.value && handlingMode.value === 'ai' && latestRun.value?.status === 'failed' && !silentHandoff.value)
const canRetry = computed(() => !silentHandoff.value && (!!pending.value || (handlingMode.value === 'ai' && items.value.at(-1)?.authorType === 'customer' && latestRun.value?.status !== 'running' && !latestRun.value?.error?.startsWith('image_'))))
const resumeKey = 'feedlog:widget:agent-pending'
const hasFeedbackCard = (content: Content) => content.parts.some(part => 'feedback_id' in part)
let version = 0

function savePending() {
  try {
    if (pending.value) sessionStorage.setItem(resumeKey, JSON.stringify({ owner: user.value?.id, conversationId: conversationId.value, pending: pending.value }))
    else sessionStorage.removeItem(resumeKey)
  } catch { /* The request can still be retried while this frame remains open. */ }
}
watch(draft, () => {
  if (!draftEl.value) return
  draftEl.value.style.height = 'auto'
  draftEl.value.style.height = `${draftEl.value.scrollHeight}px`
}, { flush: 'post' })
interface Attachment { key: string, name: string, order?: number, bytes?: number }
const attachments = ref<Attachment[]>([])
let attachmentOrder = 0
interface ImagePreview { id: string; preview: string; previewFailed: boolean }
interface PendingImage extends ImagePreview { order: number; file: File; bytes?: number }
const uploadedPreviews = ref<Record<string, ImagePreview>>({})
const uploadQueue = ref<PendingImage[]>([])
const pendingImages = ref<PendingImage[]>([])
let uploadWorkers = 0
let uploadsDisposed = false
const stagedImages = computed(() => [
  ...attachments.value.map(file => ({ id: uploadedPreviews.value[file.key]?.id ?? file.key, name: file.name,
    order: file.order ?? -1, key: file.key, preview: uploadedPreviews.value[file.key], uploading: false })),
  ...pendingImages.value.map(image => ({ id: image.id, name: image.file.name, order: image.order,
    key: undefined, preview: image, uploading: true })),
].sort((a, b) => a.order - b.order))
watch(attachments, files => {
  const keys = new Set(files.map(file => file.key))
  for (const [key, image] of Object.entries(uploadedPreviews.value)) {
    if (keys.has(key)) continue
    URL.revokeObjectURL(image.preview)
    Reflect.deleteProperty(uploadedPreviews.value, key)
  }
}, { deep: true })
const pendingUploads = computed(() => pendingImages.value.length)
const uploading = computed(() => pendingUploads.value > 0)
watch(() => busy.value || uploading.value || loadingThread.value, value => emit('busy', value), { immediate: true })
const uploadError = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const articleScrollTop = ref(0)
let scrollTop = 0

function reportState() {
  emit('stateChange', {
    conversationId: conversationId.value,
    draft: draft.value,
    attachments: attachments.value.map(file => ({ ...file })),
    pending: pending.value,
    articleSlug: articleSlug.value,
    articleScrollTop: articleScrollTop.value,
    firstSeq: items.value.find(item => item.seq > 0)?.seq ?? null,
    scrollTop,
  })
}
function rememberScroll() {
  if (bodyEl.value?.clientHeight) scrollTop = bodyEl.value.scrollTop
  reportState()
}
watch([draft, attachments, conversationId, pending, articleSlug, articleScrollTop, items], reportState, { deep: true })

async function restoreState(state: WidgetChatResume) {
  const current = version + 1
  await openConversation(state.conversationId)
  if (current !== version) return
  // Restore the loaded history range before applying its scroll offset.
  while (state.firstSeq && nextBeforeSeq.value && (items.value[0]?.seq ?? 0) > state.firstSeq) {
    try { await loadHistory(true) } catch { break }
    if (current !== version) return
  }
  draft.value = state.draft
  attachments.value = state.attachments.map(file => ({ ...file }))
  pending.value = state.pending
  const request = pending.value
  if (request?.action === 'send' && items.value.some(item => item.id === request.message.id)) confirmInput(request)
  savePending()
  articleScrollTop.value = state.articleScrollTop
  articleSlug.value = state.articleSlug
  await nextTick()
  await document.fonts.ready
  if (current !== version) return
  scrollTop = state.scrollTop
  if (bodyEl.value) bodyEl.value.scrollTop = scrollTop
  reportState()
}
watch(() => props.resumeState, state => { if (state) void restoreState(state) })

function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  void uploadFiles(files)
}

function onPaste(e: ClipboardEvent) {
  const images = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'))
  if (!images.length) return
  // A copied file carries its name as text/plain; without this it lands in the draft.
  e.preventDefault()
  void uploadFiles(images)
}

async function uploadFiles(files: File[]) {
  if (!files.length || awaitingRun.value || busy.value) return
  if (attachments.value.length + pendingImages.value.length + files.length > CHAT_IMAGE_MAX_COUNT) {
    uploadError.value = t('widget.tooManyParts')
    return
  }
  uploadError.value = ''
  const selected = files.map(file => ({ id: crypto.randomUUID(), order: attachmentOrder++, file, preview: URL.createObjectURL(file), previewFailed: false }))
  pendingImages.value.push(...selected)
  uploadQueue.value.push(...selected)
  while (uploadWorkers < 3 && uploadQueue.value.length) void drainUploads()
}

async function drainUploads() {
  uploadWorkers++
  try {
    while (!uploadsDisposed && uploadQueue.value.length) {
      const image = uploadQueue.value.shift()!
      let uploaded = false
      try {
        if (!await ensureIdentity()) throw new Error('Authentication required')
        const prepared = await prepareChatImage(image.file, imageMaxBytes.value)
        if (uploadsDisposed) return
        const usedBytes = attachments.value.reduce((sum, item) => sum + (item.bytes ?? 0), 0)
          + pendingImages.value.reduce((sum, item) => sum + (item.bytes ?? 0), 0)
        if (usedBytes + prepared.size > CHAT_IMAGE_TOTAL_BYTES) throw new ChatImageError('image_total_too_large')
        image.bytes = prepared.size
        // Keep an already visible image stable. HEIC gets its first readable preview here.
        if (image.previewFailed) {
          URL.revokeObjectURL(image.preview)
          image.preview = URL.createObjectURL(prepared)
          image.previewFailed = false
        }
        const form = new FormData()
        form.append('file', prepared)
        const res = await widgetFetch<{ key: string }>('/api/upload', { method: 'POST', body: form })
        if (!uploadsDisposed) {
          uploadedPreviews.value[res.key] = { id: image.id, preview: image.preview, previewFailed: image.previewFailed }
          uploaded = true
          attachments.value.push({ key: res.key, name: image.file.name, order: image.order, bytes: prepared.size })
          attachments.value.sort((a, b) => (a.order ?? -1) - (b.order ?? -1))
        }
      } catch (err) {
        if (uploadsDisposed) return
        if ((err as { statusCode?: number })?.statusCode === 401) {
          savePending()
          emit('authRequired')
        }
        const reason = err instanceof ChatImageError ? t(`widget.imageErrors.${err.code}`) : t('widget.uploadFailed')
        const message = t('widget.imageUploadFailed', { number: image.order + 1, name: image.file.name, message: reason })
        uploadError.value = [uploadError.value, message].filter(Boolean).join('\n')
      } finally {
        if (!uploaded) URL.revokeObjectURL(image.preview)
        pendingImages.value = pendingImages.value.filter(item => item.id !== image.id)
      }
    }
  } finally { uploadWorkers-- }
}


function scrollToBottom() {
  nextTick(() => { if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight })
}
function onEnterKey(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  void send()
}
async function loadHistory(older = false) {
  if (!conversationId.value) return
  const current = version
  const id = conversationId.value
  const suffix = older && nextBeforeSeq.value ? `?beforeSeq=${nextBeforeSeq.value}` : ''
  const data = await widgetFetch<Detail>(`${apiBase}/${id}/items${suffix}`, { signal: AbortSignal.timeout(10000) })
  if (current !== version) return
  handlingMode.value = data.conversation.handling ?? 'ai'
  if (handlingMode.value !== 'ai') transient.value = ''
  items.value = older ? [...data.items, ...items.value] : data.items
  const merged = new Map((older ? runs.value : []).map(run => [run.id, run]))
  for (const run of data.runs) merged.set(run.id, run)
  runs.value = [...merged.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
  nextBeforeSeq.value = data.nextBeforeSeq

  if (!older) {
    observedSeq.value = data.nextAfterSeq ?? data.conversation.lastSeq
    await nextTick()
    reportRead(id)
  }
}
async function refreshStatus() {
  failure.value = ''
  try { await loadHistory() } catch { failure.value = t('widget.loadFailed') }
}
function confirmInput(input: ChatInput) {
  if (input.action === 'send') {
    if (!items.value.some(item => item.id === input.message.id)) {
      items.value.push({ ...input.message, seq: 0, authorType: 'customer', agentRunId: null, createdAt: new Date().toISOString() })
    }
    draft.value = ''
    attachments.value = []
  }
  awaitingRun.value = false
  pending.value = null
  savePending()
  scrollToBottom()
}
async function submit(input: ChatInput) {
  if (!conversationId.value) return
  const id = conversationId.value
  const current = version
  pending.value = input
  savePending()
  sending.value = true
  awaitingRun.value = true
  failure.value = ''
  transient.value = ''
  let finished = false
  let timedOut = false
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const waitForAnswer = () => {
    clearTimeout(timeout)
    timeout = setTimeout(() => { timedOut = true; controller.abort() }, 120_000)
  }
  waitForAnswer()
  try {
    if (!await ensureIdentity()) {
      if (current === version) failure.value = t('widget.sendFailed')
      return
    }
    if (current !== version) return
    if (input.action === 'send' && !input.message.context) {
      input.message.context = await protocol!.requestPageContext()
      if (current !== version) return
    }
    savePending()
    const response = await widgetRequest(`${apiBase}/${id}/chat`, { method: 'POST', body: JSON.stringify(input), signal: controller.signal })
    if (response.headers.get('content-type')?.includes('application/json')) {
      const result: Pick<Detail, 'conversation'> = await response.json()
      if (current !== version) return
      handlingMode.value = result.conversation.handling ?? handlingMode.value
      confirmInput(input)
      emit('started', id)
    } else {
      if (!response.body) throw new Error('Missing response stream')
      await readAgentEvents(response.body, (name, data) => {
        if (current !== version) return
        if (name === 'run') {
          const run: Run = data.run ?? {
            id: data.runId, triggerItemId: input.action === 'send' ? input.message.id : input.trigger_item_id,
            status: 'running', error: null, startedAt: new Date().toISOString(),
            deadlineAt: new Date(Date.now() + 120_000).toISOString(), finishedAt: null,
          }
          runs.value = [...runs.value.filter(existing => existing.id !== run.id), run]
          handlingMode.value = 'ai'
          confirmInput(input)
          emit('started', id)
        }
        if (name === 'reset') transient.value = ''
        if (name === 'text' && data.delta.length) { waitForAnswer(); transient.value += data.delta; scrollToBottom() }
        if (name === 'finish') {
          finished = true
          clearTimeout(timeout)
          if (data.content && !items.value.some(item => item.id === data.itemId)) items.value.push({
            id: data.itemId, seq: data.lastSeq, authorType: 'agent',
            content: data.content,
            context: null, agentRunId: data.runId, createdAt: new Date().toISOString(),
          })
          runs.value = runs.value.map(run => run.id === data.runId ? { ...run, status: 'completed' } : run)
          transient.value = ''
        }
        if (name === 'handoff' || name === 'closed') {
          if (name === 'handoff' && data.noticeItemId && data.reason !== 'ai_error' && !items.value.some(item => item.id === data.noticeItemId)) {
            // The event confirms persistence; render it before the history fetch.
            // Reusing its ID lets history update the same bubble without a gap.
            items.value.push({
              id: data.noticeItemId, seq: data.lastSeq, authorType: 'system', notice: 'handoff', handoffNotice: data.handoffNotice, customerNotice: data.customerNotice,
              content: { parts: [{ type: 'text', text: data.customerNotice ?? t(`widget.conversationNotices.${data.handoffNotice ?? 'handoff'}`) }] },
              context: null, agentRunId: null, createdAt: new Date().toISOString(),
            })
          }
          transient.value = ''
          failure.value = ''
          handlingMode.value = name === 'closed' ? 'closed' : 'human'
          finished = true
          clearTimeout(timeout)
          scrollToBottom()
        }
        if (name === 'superseded') {
          transient.value = ''
          failure.value = ''
          finished = true
          clearTimeout(timeout)
        }
        if (name === 'handoff_unavailable' || (name === 'error' && data.code === 'support_unavailable')) {
          runs.value = runs.value.map(run => run.status === 'running' ? { ...run, status: 'failed', error: 'support_unavailable' } : run)
          finished = true
          clearTimeout(timeout)
          transient.value = ''
          failure.value = ''
          pending.value = null
          savePending()
        } else if (name === 'error') { clearTimeout(timeout); transient.value = ''; failure.value = replyError(data.code) }
      })
      if (!finished && !failure.value) failure.value = t('widget.replyInterrupted')
      if (!finished) runs.value = runs.value.map(run => run.status === 'running' ? { ...run, status: 'failed' } : run)
    }
    if (current === version) {
      if (awaitingRun.value) throw new Error('Missing run acknowledgement')
      // A refresh failure must not override a confirmed terminal result.
      await loadHistory().catch(error => { if (!finished && !failure.value) throw error })
      if (finished) emit('filed')
    }
  } catch (error) {
    if (current !== version) return
    if ((error as { statusCode?: number }).statusCode === 401) { savePending(); emit('authRequired') }
    else {
      const rawCode = (error as { code?: unknown })?.code
      const code = typeof rawCode === 'string' ? rawCode : undefined
      const imageError = code?.startsWith('image_')
      failure.value = timedOut ? t('widget.replyTimeout') : replyError(code)
      runs.value = runs.value.map(run => run.status === 'running' ? { ...run, status: 'failed', error: code ?? (timedOut ? 'ai_timeout' : 'ai_error') } : run)
      if (imageError) { pending.value = null; savePending() }
      await loadHistory().catch(() => {})
      if (current === version && awaitingRun.value && input.action === 'send' && items.value.some(item => item.id === input.message.id)) {
        confirmInput(input)
        emit('started', id)
      }
      // An ambiguous network failure is retried with the same request key.
    }
  } finally {
    clearTimeout(timeout)
    if (current === version) {
      transient.value = ''
      sending.value = false
      awaitingRun.value = false
      scrollToBottom()
    }
  }
}
function replyError(code?: string | null) {
  if (code?.startsWith('image_')) return t(`widget.imageErrors.${code}`)
  if (code === 'support_unavailable') return ''
  return t(code === 'ai_timeout' ? 'widget.replyTimeout' : 'widget.replyInterrupted')
}
async function send() {
  const text = draft.value.trim()
  if ((!text && !attachments.value.length) || busy.value || uploading.value || uploadError.value) return
  if (attachments.value.length > CHAT_IMAGE_MAX_COUNT) { uploadError.value = t('widget.tooManyParts'); return }
  conversationId.value ??= crypto.randomUUID()
  const input: ChatInput = { action: 'send', idempotency_key: crypto.randomUUID(), message: {
    id: crypto.randomUUID(), content: { parts: [...(text ? [{ type: 'text' as const, text }] : []), ...attachments.value.map(file => ({ type: 'image' as const, storage_key: file.key }))] },
    context: null,
  } }
  const previous = pending.value
  await submit(previous?.action === 'send' && JSON.stringify(previous.message.content) === JSON.stringify(input.message.content) ? previous : input)
}
async function retry() {
  if (busy.value) return
  const last = items.value.at(-1)
  const input = pending.value ?? (last?.authorType === 'customer' ? { action: 'retry' as const, idempotency_key: crypto.randomUUID(), trigger_item_id: last.id } : null)
  if (!input) return
  const current = version
  retrying.value = true
  try { await submit(input) }
  finally { if (current === version) retrying.value = false }
}
async function openConversation(id: string | null) {
  version++
  retrying.value = false
  conversationId.value = id
  items.value = []
  runs.value = []
  pending.value = null
  nextBeforeSeq.value = null
  articleSlug.value = null
  transient.value = ''
  failure.value = ''
  sending.value = false
  awaitingRun.value = false
  observedSeq.value = 0
  handlingMode.value = 'ai'
  if (!id) return
  loadingThread.value = true
  try { await loadHistory() } catch { failure.value = t('widget.loadFailed') }
  finally { loadingThread.value = false; scrollToBottom() }
}
watch(() => props.openId, id => { if (id !== conversationId.value) void openConversation(id) })
onMounted(async () => {
  if (props.resumeState) { await restoreState(props.resumeState); return }
  let saved: { owner: string; conversationId: string; pending: ChatInput } | null = null
  try { saved = JSON.parse(sessionStorage.getItem(resumeKey) ?? 'null') } catch { /* Ignore an incomplete local draft. */ }
  if (saved && saved.owner === user.value?.id && !props.openId) {
    await openConversation(saved.conversationId)
    pending.value = saved.pending
    failure.value = t('widget.sendFailed')
    if (saved.pending.action === 'send') {
      const message = saved.pending.message
      if (items.value.some(item => item.id === message.id)) confirmInput(saved.pending)
      else {
        draft.value = message.content.parts.filter(part => part.type === 'text').map(part => part.text).join('\n')
        attachments.value = message.content.parts.filter(part => part.type === 'image').map(part => ({ key: part.storage_key, name: part.storage_key }))
      }
    }
  } else await openConversation(props.openId)
})
let polling: ReturnType<typeof setInterval> | undefined
let pollingBusy = false
onMounted(() => { polling = setInterval(async () => {
  if (!chatActive || articleSlug.value || !conversationId.value || document.hidden || loadingThread.value || sending.value || pollingBusy) return
  const current = version
  const id = conversationId.value
  pollingBusy = true
  try {
    const data = await widgetFetch<Detail>(`${apiBase}/${id}/items?afterSeq=${observedSeq.value}`)
    if (current !== version) return
    const merged = new Map(items.value.map(item => [item.id, item]))
    for (const item of data.items) merged.set(item.id, item)
    items.value = [...merged.values()].sort((a, b) => a.seq - b.seq)
    handlingMode.value = data.conversation.handling ?? 'ai'
    if (handlingMode.value !== 'ai') transient.value = ''
    const runMap = new Map(runs.value.map(run => [run.id, run]))
    for (const run of data.runs) runMap.set(run.id, run)
    runs.value = [...runMap.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    observedSeq.value = data.nextAfterSeq ?? observedSeq.value
    if (data.items.length) { await nextTick(); reportRead(id); scrollToBottom() }
  } catch { /* Preserve the conversation and retry on the next visible interval. */ }
  finally { pollingBusy = false }
}, 5000) })
onBeforeUnmount(() => {
  version++
  clearInterval(polling)
  uploadsDisposed = true
  uploadQueue.value = []
  for (const image of pendingImages.value) URL.revokeObjectURL(image.preview)
  for (const image of Object.values(uploadedPreviews.value)) URL.revokeObjectURL(image.preview)
})
onDeactivated(() => { chatActive = false })
onActivated(() => {
  chatActive = true
  if (conversationId.value && !busy.value && !loadingThread.value) void refreshStatus()
})
function openFeedback(slug: string) {
  protocol!.navigateToFeedback(slug)
}
function openArticle(slug: string) {
  articleScrollTop.value = 0
  articleSlug.value = slug
}
async function closeArticle() {
  articleSlug.value = null
  await nextTick()
  if (conversationId.value) reportRead(conversationId.value)
}
</script>

<template>
  <WidgetEmbedArticle v-if="articleSlug" :slug="articleSlug" :product-name="productName" :initial-scroll-top="articleScrollTop" @close="closeArticle" @article="openArticle" @scroll="articleScrollTop = $event" />
  <div v-show="!articleSlug" ref="bodyEl" class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain bg-background p-3.5 space-y-2.5 [overflow-wrap:anywhere]" @scroll="rememberScroll">
    <div v-if="loadingThread" class="grid place-items-center p-4"><Icon name="lucide:loader-2" size="20" class="animate-spin" /></div>
    <button v-if="nextBeforeSeq" class="block mx-auto text-xs text-primary" @click="loadHistory(true)">{{ t('widget.earlierMessages') }}</button>
    <div v-if="!items.length && !loadingThread" class="max-w-[88%] rounded-lg border bg-card px-3 py-2.5 text-[13.5px]">{{ t('widget.greeting', { product: productName }) }}</div>
    <template v-for="item in items" :key="item.id">
      <div v-if="item.notice === 'handoff'" class="flex justify-start" :data-message-id="item.id" data-author="system">
        <div class="min-w-0 max-w-[82%]">
          <div class="rounded-2xl rounded-bl-sm border border-border bg-card px-3 py-2.5 text-[13.5px] font-normal leading-normal" dir="auto" data-handoff-message>{{ item.customerNotice ?? t(`widget.conversationNotices.${item.handoffNotice ?? 'handoff'}`) }}</div>
          <div class="mt-1.5 flex min-w-0 items-center gap-1 px-1 text-[10px] text-muted-foreground" data-message-meta>
            <span class="truncate font-semibold text-foreground dark:text-white">{{ t('widget.messageAI') }}</span>
            <span aria-hidden="true">·</span>
            <time class="shrink-0" :datetime="item.createdAt">{{ messageTime(item.createdAt) }}</time>
          </div>
        </div>
      </div>
      <div v-else-if="!item.notice && item.authorType !== 'system'" class="flex" :class="item.authorType === 'customer' ? 'justify-end' : 'justify-start'" :data-message-id="item.id" :data-author="item.authorType">
        <div class="min-w-0" :class="hasFeedbackCard(item.content) ? 'max-w-[92%]' : 'max-w-[82%]'">
          <div class="rounded-2xl px-3 py-2.5 text-[13.5px] leading-normal" :class="item.authorType === 'customer' ? 'bg-primary text-primary-foreground rounded-br-sm' : 'bg-card border border-border rounded-bl-sm'">
            <WidgetEmbedParts :content="item.content" :plain-text="item.authorType !== 'agent'" @feedback="openFeedback" @article="openArticle" />
          </div>
          <div class="mt-1.5 flex min-w-0 items-center gap-1 px-1 text-[10px] text-muted-foreground" :class="item.authorType === 'customer' ? 'justify-end' : ''" data-message-meta>
            <span class="truncate font-semibold text-foreground dark:text-white">{{ messageAuthor(item) }}</span>
            <span aria-hidden="true">·</span>
            <time class="shrink-0" :datetime="item.createdAt">{{ messageTime(item.createdAt) }}</time>
          </div>
        </div>
      </div>
    </template>
    <div v-if="transient" class="max-w-[82%] rounded-lg rounded-bl-sm border border-border bg-card px-3 py-2.5 text-[13.5px] leading-normal"><WidgetEmbedMarkdown :text="transient" /></div>
    <div v-else-if="handlingMode === 'ai' && latestRun?.status === 'running' && !awaitingRun" role="status" :aria-label="t('widget.thinking')" class="flex justify-start">
      <div class="px-3.5 py-2.5 rounded-lg rounded-bl-sm bg-card border border-border text-xs text-muted-foreground flex items-center gap-1.5">
        <span class="flex items-center gap-1" aria-hidden="true">
          <span v-for="n in 3" :key="n" class="w-1 h-1 rounded-full bg-current opacity-40 typing-dot" :style="{ animationDelay: `${(n - 1) * 0.16}s` }" />
        </span>
        {{ t('widget.thinking') }}
      </div>
    </div>
    <div v-if="failure || failedReply || (canRetry && !sending) || retrying" class="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs">
      <span v-if="failure || failedReply" role="status" class="text-foreground">{{ failure || replyError(latestRun?.error) }}</span>
      <button
        v-if="(canRetry && !sending) || retrying"
        type="button"
        :disabled="busy"
        :aria-busy="retrying"
        class="-mx-1.5 inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 font-semibold text-primary underline underline-offset-4 transition-colors hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-wait disabled:opacity-60 disabled:no-underline"
        @click="retry"
      >
        <Icon name="lucide:rotate-cw" size="15" aria-hidden="true" :class="{ 'animate-spin motion-reduce:animate-none': retrying }" />
        {{ t('widget.retryReply') }}
      </button>
    </div>
    <button v-if="latestRun?.status === 'running' && !sending" class="text-xs text-primary" @click="refreshStatus">{{ t('widget.refreshStatus') }}</button>
  </div>
  <div v-show="!articleSlug" class="px-3 py-2.5 bg-card shrink-0">
    <p v-if="uploadError" class="mb-2 flex items-start gap-1.5 text-[11px] text-destructive">
      <Icon name="lucide:alert-circle" size="13" class="shrink-0 mt-px" />
      <span class="min-w-0 flex-1 whitespace-pre-line break-words">{{ uploadError }}</span>
      <button
        class="shrink-0 hover:opacity-70 transition-opacity"
        :aria-label="t('widget.close')"
        @click="uploadError = ''"
      >
        <Icon name="lucide:x" size="12" />
      </button>
    </p>

    <!-- Keep the same preview and DOM node until the attachment is sent or removed. -->
    <div v-if="stagedImages.length" class="flex flex-wrap gap-1.5 mb-2">
      <div
        v-for="image in stagedImages"
        :key="image.id"
        class="relative h-12 w-16 rounded-md overflow-hidden border border-border group"
        :title="image.name"
        :aria-busy="image.uploading"
      >
        <template v-if="image.preview">
          <img v-if="!image.preview.previewFailed" :src="image.preview.preview" :alt="image.name" class="h-full w-full object-cover" @error="image.preview.previewFailed = true">
          <span v-else class="block truncate px-1 pt-2 text-[10px]">{{ image.name }}</span>
        </template>
        <WidgetEmbedImage v-else-if="image.key" :storage-key="image.key" />
        <Icon v-if="image.uploading" name="lucide:loader-2" size="14" class="absolute bottom-0.5 right-0.5 animate-spin rounded-full bg-background text-muted-foreground" />
        <button
          v-else
          class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white"
          :aria-label="t('widget.cancel')"
          :disabled="awaitingRun"
          @click="attachments = attachments.filter(file => file.key !== image.key)"
        >
          <Icon name="lucide:x" size="14" />
        </button>
      </div>
    </div>

    <!-- Controls sit on their own row so the textarea can grow into the card
         instead of stretching the buttons beside it. -->
    <div class="rounded-md border border-border bg-card transition-shadow focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/15">
      <input
        ref="fileInput"
        type="file"
        accept="image/*,.heic,.heif"
        multiple
        class="hidden"
        @change="onFilePicked"
      >
      <textarea
        ref="draftEl"
        v-model="draft"
        :disabled="awaitingRun"
        rows="1"
        maxlength="4000"
        :placeholder="t('widget.placeholder')"
        class="w-full min-h-12 max-h-[120px] px-3 py-2 bg-transparent text-[13.5px] leading-normal resize-none overscroll-y-contain focus:outline-none no-scrollbar"
        @keydown.enter.exact="onEnterKey"
        @paste="onPaste"
      />
      <div class="flex items-center justify-between px-1.5 py-1">
        <button
          :disabled="busy || attachments.length + pendingImages.length >= CHAT_IMAGE_MAX_COUNT"
          class="h-6.5 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-secondary hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          :aria-label="t('widget.attachImage')"
          @click="fileInput?.click()"
        >
          <Icon name="lucide:image" size="15" />
        </button>
        <button
          :disabled="(!draft.trim() && !attachments.length) || busy || uploading || !!uploadError"
          class="relative px-3.5 py-1.5 rounded-md bg-primary text-primary-foreground text-[12.5px] font-heading font-semibold hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          @click="send"
        >
          <span :class="{ invisible: awaitingRun }">{{ t('widget.send') }}</span>
          <span v-if="awaitingRun" class="absolute inset-0 grid place-items-center" role="status" :aria-label="t('widget.send')">
            <Icon name="lucide:loader-2" size="14" class="animate-spin" />
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
[data-author='customer'] :deep(.md-editor-preview a) {
  color: var(--primary-foreground);
  text-decoration: underline;
  text-underline-offset: 0.15em;
}
.no-scrollbar { scrollbar-width: none; }
.no-scrollbar::-webkit-scrollbar { display: none; }
.typing-dot { animation: typing 1.2s ease-in-out infinite; }
@keyframes typing {
  0%, 60%, 100% { opacity: 0.25; }
  30% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .typing-dot { animation: none; }
}
</style>

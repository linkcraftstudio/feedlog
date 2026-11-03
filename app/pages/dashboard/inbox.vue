<script setup lang="ts">
import { toast } from 'vue-sonner'
import { handoffNotice as customerNoticeKind, type SystemEventPart } from '#layers/feedlog/shared/inbox/state'
import type { Content } from '#layers/feedlog/shared/agent/content'
import InboxStatusBadge from '#layers/feedlog/app/components/inbox/StatusBadge.vue'
import InboxCustomerDetails from '#layers/feedlog/app/components/inbox/CustomerDetails.vue'
import { INBOX_STATUS_FILTERS, inboxStatusFilter, useInboxStatusCookie, type InboxStatusFilter } from '#layers/feedlog/app/composables/useInboxStatus'
import type {
  InboxConversation,
  InboxCustomer,
  InboxDetail,
  InboxCommandResult,
  EmailResult,
} from '#layers/feedlog/shared/inbox/types'

definePageMeta({ layout: 'dashboard', middleware: 'admin' })
const { t, locale } = useI18n()
const { data: session } = useAuthSession()
const { confirm } = useConfirmDialog()
const { authorName } = useAuthorDisplay()
const time = useConversationTime()
const searchOpen = ref(false)
const timeline = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const replyInput = ref<HTMLTextAreaElement | null>(null)
const draftImages = reactive<Record<string, { key: string }[]>>({})
const uploadCounts = reactive<Record<string, number>>({})
const images = computed(() => selected.value ? draftImages[selected.value] || [] : [])
const uploading = computed(() => !!selected.value && !!uploadCounts[selected.value])
const sendable = computed(() => !!draft.value.trim() || images.value.length > 0)
const statusOptions = INBOX_STATUS_FILTERS
const snoozeChoices = ['hour', 'threeHours', 'tomorrow', 'monday', 'week', 'month']
const emailSending = reactive<Record<string, boolean>>({})
const route = useRoute()
const router = useRouter()
const localePath = useLocalePath()
const { canAccessInbox } = usePermission(
  computed(() => undefined),
  'post',
)
const { refresh: refreshBadge, isUnread, markRead } = useInboxBadge()
const feedbackSlug = ref<string | null>(null)
const feedbackOpen = ref(false)
function openFeedback(slug: string) {
  feedbackSlug.value = slug
  feedbackOpen.value = true
}
// Cited articles open on the public Help Center, outside the dashboard.
function openArticle(slug: string) {
  window.open(localePath(`/help/${encodeURIComponent(slug)}`), '_blank', 'noopener,noreferrer')
}
const rows = ref<(InboxConversation & { customer: InboxCustomer })[]>([])
const nextCursor = ref<string | null>(null)
// A link's `?status=` decides this visit only and is not remembered; otherwise
// the status the user last picked (preset to "all" during onboarding), then "open".
const rememberedStatus = useInboxStatusCookie()
const queryStatus = () => inboxStatusFilter(route.query.status)
const filters = reactive({ q: '', status: queryStatus() ?? inboxStatusFilter(rememberedStatus.value) ?? 'open', priority: 'all', sort: 'newest' })
// The user's own pick is remembered, and a `?status=` still in the address is
// dropped so a reload does not bring the link's view back.
function pickStatus(status: InboxStatusFilter) {
  filters.status = status
  rememberedStatus.value = status
  if (route.query.status !== undefined) {
    const { status: _status, ...query } = route.query
    void router.replace({ query })
  }
}
const hasFilters = computed(() => !!filters.q.trim() || filters.status !== 'all' || filters.priority !== 'all')
const selected = ref<string | null>(null)
const detail = ref<InboxDetail | null>(null)
function showSystemNotice(part: Content['parts'][number]) {
  return part.type === 'system_event' && ((part.kind === 'handoff' && part.reason !== 'ai_error')
    || (part.reason === 'manual' && ['takeover', 'snoozed', 'closed'].includes(part.kind)))
}
function handoffNotice(part: SystemEventPart) {
  const builtin = part.rule?.id
  const key = part.reason === 'support_rule' && builtin && ['builtin-billing', 'builtin-account-access', 'builtin-privacy-legal'].includes(builtin)
    ? builtin : part.reason
  return t(`inbox.handoffNotices.${key}`)
}
function customerConfirmation(content: Content) {
  const part = content.parts.find(part => part.type === 'system_event' && part.kind === 'handoff')
  if (part?.type !== 'system_event') return ''
  return part.customerNotice ?? t(`widget.conversationNotices.${customerNoticeKind(part.reason, part.rule?.id)}`)
}
const visibleItems = computed(() => (detail.value?.items ?? []).filter(item =>
  item.authorType !== 'system' || item.content.parts.some(showSystemNotice),
))
const drafts = reactive<Record<string, string>>({})
const deliveryModes = reactive<Record<string, 'auto' | 'immediate'>>({})
const deliveryMode = computed({
  get: () => selected.value ? deliveryModes[selected.value] ?? 'auto' : 'auto',
  set: (value: 'auto' | 'immediate') => { if (selected.value) deliveryModes[selected.value] = value },
})
const draft = computed({
  get: () => (selected.value ? drafts[selected.value] || '' : ''),
  set: (value) => {
    if (selected.value) drafts[selected.value] = value
  },
})
const emailResults = reactive<Record<string, EmailResult>>({})
const error = ref('')
const loading = ref(true)
const sending = ref(false)
const activeAction = ref<string | null>(null)
const busy = computed(() => sending.value || activeAction.value !== null)
let commandQueue: Promise<void> = Promise.resolve()
const showDetails = ref(true)
const drawer = ref(false)
const feedbacks = ref<{ id: string; slug: string; title: string; status: string }[]>([])
const feedbackPage = ref(0)
const feedbackTotal = ref(0)
const pending = new Map<string, { signature: string; requestId: string; expectedLastSeq: number }>()
const wide = ref(false)
let listVersion = 0
let detailVersion = 0
let polling: ReturnType<typeof setInterval> | undefined
let media: MediaQueryList | undefined
let pollingBusy = false
const date = (value: string | null) => (value ? new Date(value).toLocaleString(locale.value) : '')
const canReply = computed(() => !!detail.value && ['open', 'pending'].includes(detail.value.conversation.status))
const isAiHandling = computed(() => detail.value?.conversation.status === 'ai_handling')
// While the AI handles the chat the reply box cannot take text; clicking it points
// at the button that hands the chat to the user instead of a "not allowed" cursor.
const takeoverButton = ref<{ $el: HTMLElement } | null>(null)
const takeoverPulse = ref(false)
function pointToTakeover() {
  takeoverButton.value?.$el.focus()
  // Restart the animation even if a previous pulse is still running.
  takeoverPulse.value = false
  requestAnimationFrame(() => { takeoverPulse.value = true })
}
// Arriving from the Demo Widget: point once at what that chat needs next, the
// takeover button while the AI handles it, or the reply box once a person has it.
const { state: onboarding } = useOnboarding()
// Also watched on the request itself: the chat may already be the one on screen.
watch([() => detail.value?.conversation, () => onboarding.value.highlightReply], async ([conversation]) => {
  if (!conversation || conversation.id !== onboarding.value.highlightReply) return
  onboarding.value.highlightReply = null
  await nextTick()
  if (isAiHandling.value) pointToTakeover()
  else if (canReply.value) replyInput.value?.focus()
})
const takeoverPending = computed(() => isAiHandling.value && !!detail.value?.conversation.takeoverPending)
const takeoverFocusId = ref<string | null>(null)
watch(canReply, async (available) => {
  if (!available || takeoverFocusId.value !== selected.value) return
  takeoverFocusId.value = null
  await nextTick()
  replyInput.value?.focus()
})
const canClose = computed(() => !!detail.value && detail.value.conversation.status !== 'closed')
const statusHint = computed(() => {
  const conversation = detail.value?.conversation
  if (!conversation) return ''
  const label = t(`inbox.statuses.${conversation.status}`)
  return conversation.stateDueAt
    ? `${label} · ${t(conversation.status === 'snoozed' ? 'inbox.wakeAt' : 'inbox.closeAt')} ${date(conversation.stateDueAt)}`
    : label
})

async function refreshList(more = false) {
  const version = ++listVersion
  loading.value = true
  error.value = ''
  try {
    const cursor = more ? nextCursor.value : null
    const data = await useApiFetch<{ items: typeof rows.value; nextCursor: string | null }>(
      '/api/admin/inbox/conversations',
      { query: { ...filters, ...(cursor ? { cursor } : {}) } },
    )
    if (version !== listVersion) return
    rows.value = more ? [...new Map([...rows.value, ...data.items].map((row) => [row.id, row])).values()] : data.items
    nextCursor.value = data.nextCursor
    void refreshBadge()
  } catch {
    if (version === listVersion) error.value = t('inbox.loadFailed')
  } finally {
    if (version === listVersion) loading.value = false
  }
}
async function loadDetail(id: string, older = false, initial = false) {
  const version = detailVersion
  const query = older
    ? { beforeSeq: detail.value?.nextBeforeSeq }
    : initial
      ? {}
      : { afterSeq: detail.value?.nextAfterSeq ?? 0 }
  const data = await useApiFetch<InboxDetail>(`/api/admin/inbox/conversations/${id}`, { query })
  if (id !== selected.value || version !== detailVersion) return
  Object.assign(emailResults, data.emails)
  const atBottom = !timeline.value || timeline.value.scrollHeight - timeline.value.scrollTop - timeline.value.clientHeight < 80
  const previousHeight = timeline.value?.scrollHeight ?? 0
  if (detail.value && !initial) {
    const items = [...new Map([...detail.value.items, ...data.items].map((item) => [item.id, item])).values()].sort(
      (a, b) => a.seq - b.seq,
    )
    if (data.conversation.lastSeq < detail.value.conversation.lastSeq) return
    detail.value = {
      ...data,
      items,
      nextBeforeSeq: older ? data.nextBeforeSeq : detail.value.nextBeforeSeq,
      nextAfterSeq: older ? detail.value.nextAfterSeq : data.nextAfterSeq,
    }
  } else detail.value = data
  await nextTick()
  if (timeline.value) {
    if (older) timeline.value.scrollTop += timeline.value.scrollHeight - previousHeight
    else if (initial || atBottom) timeline.value.scrollTop = timeline.value.scrollHeight
  }
  if (!older) reportRead()
}
function reportRead() {
  const id = selected.value
  const element = timeline.value
  if (!id || !detail.value || !element || document.hidden || feedbackOpen.value || !element.clientHeight
    || element.scrollHeight - element.scrollTop - element.clientHeight > 8) return
  markRead(id, detail.value.nextAfterSeq)
}
async function loadFeedback(more = false) {
  const id = selected.value
  if (!id) return
  const page = more ? feedbackPage.value + 1 : 1
  const data = await useApiFetch<{ data: typeof feedbacks.value; pagination: { total: number } }>('/api/admin/posts', {
    query: { sourceConversationId: id, merged: 'all', page, pageSize: 20, sort: 'createdAt', order: 'desc' },
  })
  if (id !== selected.value) return
  feedbacks.value = more ? [...feedbacks.value, ...data.data] : data.data
  feedbackPage.value = page
  feedbackTotal.value = data.pagination.total
}
function clearSelection() {
  takeoverFocusId.value = null
  selected.value = null
  detail.value = null
  detailVersion++
}

// Picking from the list also puts the conversation in the address, so a reload
// or a shared link opens it, and a later link to it is a real route change.
function select(id: string) {
  void open(id)
  if (route.query.conversationId !== id) void router.replace({ query: { ...route.query, conversationId: id } })
}
async function open(id: string) {
  if (id !== selected.value) takeoverFocusId.value = null
  detailVersion++
  selected.value = id
  detail.value = null
  feedbacks.value = []
  feedbackTotal.value = 0
  showDetails.value = true
  error.value = ''
  try {
    await Promise.all([loadDetail(id, false, true), loadFeedback()])
  } catch {
    if (id === selected.value) error.value = t('inbox.loadFailed')
  }
}
async function command(action: string, extra: Record<string, unknown> = {}) {
  if (action === 'reply' ? sending.value : activeAction.value !== null) return
  const id = selected.value
  const version = detailVersion
  if (action === 'reply') sending.value = true
  else activeAction.value = action
  const previous = commandQueue
  let release!: () => void
  commandQueue = new Promise<void>(resolve => { release = resolve })
  try {
    // Serialize writes so the next command uses the sequence returned by the previous one.
    await previous
    if (id === selected.value && version === detailVersion) await executeCommand(action, extra)
  } finally {
    if (action === 'reply') sending.value = false
    else activeAction.value = null
    release()
  }
}
async function executeCommand(action: string, extra: Record<string, unknown> = {}) {
  if (!detail.value || !selected.value || (action === 'reply' && (!canReply.value || !sendable.value || uploading.value))) return
  const id = selected.value
  const version = detailVersion
  const content: Content = { parts: [...(draft.value.trim() ? [{ type: 'text' as const, text: draft.value.trim() }] : []), ...images.value.map(image => ({ type: 'image' as const, storage_key: image.key }))] }
  const payload =
    action === 'reply'
      ? { notifyByEmail: deliveryMode.value === 'immediate', content }
      : { action, ...extra }
  const signature = JSON.stringify([action, payload])
  let request = pending.get(id)
  if (!request || request.signature !== signature) {
    request = { signature, requestId: crypto.randomUUID(), expectedLastSeq: detail.value.conversation.lastSeq }
    pending.set(id, request)
  }
  error.value = ''
  try {
    const result = await useApiFetch<InboxCommandResult>(
      `/api/admin/inbox/conversations/${id}/${action === 'reply' ? 'replies' : 'actions'}`,
      {
        method: 'POST',
        retry: 0,
        body: { ...payload, requestId: request.requestId, expectedLastSeq: request.expectedLastSeq },
      },
    )
    pending.delete(id)
    const row = rows.value.find((row) => row.id === id)
    if (row) Object.assign(row, result.conversation)
    if (id === selected.value && detail.value) detail.value.conversation = result.conversation
    if (action === 'takeover' && id === selected.value && version === detailVersion) {
      if (result.conversation.takeoverPending) takeoverFocusId.value = id
      else { await nextTick(); replyInput.value?.focus() }
    }
    if (action === 'reply') {
      drafts[id] = ''
      draftImages[id] = []
      if (result.email) emailResults[result.item.id] = result.email
      if (id === selected.value && version === detailVersion && detail.value) {
        if (!detail.value.items.some(item => item.id === result.item.id)) {
          const user = session.value?.user
          detail.value.items.push({
            ...result.item, content, authorType: 'staff', context: null, agentRunId: null,
            author: user ? { id: user.id, name: user.name, image: user.image, isAnonymous: false } : null,
          })
          detail.value.items.sort((a, b) => a.seq - b.seq)
        }
        sending.value = false
        void nextTick(() => {
          if (id !== selected.value || version !== detailVersion || sending.value) return
          replyInput.value?.focus()
          if (timeline.value) timeline.value.scrollTop = timeline.value.scrollHeight
        })
      }
    }
    void refreshBadge()
    if (id === selected.value) {
      void loadDetail(id).catch(() => {
        if (id === selected.value && version === detailVersion) error.value = t('inbox.loadFailed')
      })
    }
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode
    if (status === 409) pending.delete(id)
    toast.error(status === 409 ? t('inbox.conflict') : t('inbox.operationFailed'))
    if (status === 409 && id === selected.value) await loadDetail(id).catch(() => {})
  }
}
async function retryEmail(itemId: string) {
  if (!selected.value || !emailResults[itemId]?.canRetry) return
  emailResults[itemId]!.canRetry = false
  emailSending[itemId] = true
  try {
    const result = await useApiFetch<{ email: EmailResult }>(
      `/api/admin/inbox/conversations/${selected.value}/items/${encodeURIComponent(itemId)}/email/retry`,
      { method: 'POST', body: {}, retry: 0 },
    )
    emailResults[itemId] = result.email
  } catch {
    emailResults[itemId] = { status: 'failed', canRetry: false }
  } finally { emailSending[itemId] = false }
}
function sendKey(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (sendable.value && !uploading.value && canReply.value) void command('reply')
}
function wakeTime(choice: string) {
  const value = new Date()
  if (choice === 'hour' || choice === 'threeHours')
    value.setHours(value.getHours() + (choice === 'hour' ? 1 : 3))
  else if (choice === 'tomorrow') {
    value.setDate(value.getDate() + 1)
    value.setHours(9, 0, 0, 0)
  } else if (choice === 'monday') {
    value.setDate(value.getDate() + ((8 - value.getDay()) % 7 || 7))
    value.setHours(9, 0, 0, 0)
  } else if (choice === 'week') value.setDate(value.getDate() + 7)
  else {
    const day = value.getDate()
    value.setDate(1)
    value.setMonth(value.getMonth() + 1)
    value.setDate(Math.min(day, new Date(value.getFullYear(), value.getMonth() + 1, 0).getDate()))
    value.setHours(9, 0, 0, 0)
  }
  return value.toISOString()
}
async function closeConversation() {
  const id = selected.value
  if (await confirm({ title: t('inbox.close'), description: t('inbox.confirmClose'), confirmText: t('inbox.close'), cancelText: t('inbox.cancel') })) {
    if (selected.value === id) await command('close')
  }
}
function resetFilters() {
  filters.q = ''
  pickStatus('all')
  filters.priority = 'all'
  filters.sort = 'newest'
  void refreshList()
}
function closeSearch() { searchOpen.value = false; filters.q = ''; void refreshList() }
async function uploadFiles(files: File[]) {
  const id = selected.value
  if (!id || sending.value || !canReply.value || !files.length) return
  uploadCounts[id] = (uploadCounts[id] || 0) + 1
  for (const file of files) {
    if (!file.type.startsWith('image/') || file.size > 16 * 1024 * 1024) {
      toast.error(t('widget.uploadTooLarge', { size: 16 })); continue
    }
    if ((draftImages[id]?.length || 0) >= 9) { toast.error(t('widget.tooManyParts')); break }
    try {
      const body = new FormData()
      body.append('file', file)
      const result = await useApiFetch<{ key: string }>('/api/upload', { method: 'POST', body })
      ;(draftImages[id] ??= []).push({ key: result.key })
    } catch { toast.error(t('widget.uploadFailed')) }
  }
  uploadCounts[id]!--
}
function pickFiles(event: Event) {
  const input = event.target as HTMLInputElement
  void uploadFiles(Array.from(input.files || []))
  input.value = ''
}
function pasteImages(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'))
  if (files.length) { event.preventDefault(); void uploadFiles(files) }
}
watch(
  () => [filters.status, filters.priority, filters.sort],
  () => void refreshList(),
)
watch(
  () => route.query.status,
  () => {
    const status = queryStatus()
    if (status) filters.status = status
  },
)
watch(
  () => route.query.conversationId,
  (id) => {
    if (typeof id !== 'string') return
    // The list does not poll, so an in-page link can point at a conversation that
    // started after it was loaded.
    if (!rows.value.some(row => row.id === id)) void refreshList()
    if (id !== selected.value) void open(id)
  },
)
const updateWidth = () => {
  wide.value = media?.matches ?? false
}
watch(feedbackOpen, () => { void nextTick(reportRead) })
onMounted(() => {
  media = matchMedia('(min-width: 1280px)')
  updateWidth()
  media.addEventListener('change', updateWidth)
  document.addEventListener('visibilitychange', reportRead)
  if (!canAccessInbox.value) return
  void refreshBadge()
  if (typeof route.query.conversationId === 'string') void open(route.query.conversationId)
  polling = setInterval(async () => {
    if (document.hidden || busy.value || pollingBusy || loading.value || !selected.value || !detail.value) return
    pollingBusy = true
    try {
      await loadDetail(selected.value)
    } catch {
      /* Preserve the current view. */
    } finally {
      pollingBusy = false
    }
  }, 5000)
})
onBeforeUnmount(() => {
  detailVersion++
  listVersion++
  clearInterval(polling)
  media?.removeEventListener('change', updateWidth)
  document.removeEventListener('visibilitychange', reportRead)
})

const { data: initialList, error: initialListError } = await useFetch<{ items: typeof rows.value; nextCursor: string | null }>('/api/admin/inbox/conversations', {
  query: { ...filters },
  immediate: canAccessInbox.value,
})
if (initialList.value) {
  rows.value = initialList.value.items
  nextCursor.value = initialList.value.nextCursor
}
if (initialListError.value) error.value = t('inbox.loadFailed')
loading.value = false
</script>

<template>
  <div v-if="!canAccessInbox" class="p-8">{{ t('inbox.forbidden') }}</div>
  <div v-else class="flex h-full min-h-0 flex-col bg-background" data-inbox>
    <div v-if="error" role="alert" class="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">{{ error }}</div>
    <div class="flex min-h-0 flex-1">
      <section class="flex w-full shrink-0 flex-col border-r border-border bg-card md:w-80" :class="selected ? 'hidden md:flex' : ''" data-conversation-list>
        <div class="shrink-0 border-b border-border px-4 py-3">
          <div class="mb-3 flex h-8 items-center justify-between">
            <h1 class="font-heading text-base font-bold">{{ t('inbox.title') }}</h1>
            <div class="flex items-center gap-1">
              <Button variant="ghost" size="icon" class="hover:bg-secondary/50 hover:text-foreground dark:hover:bg-secondary/50 size-8 text-muted-foreground" :class="searchOpen ? 'bg-secondary text-foreground' : ''" :title="t('inbox.search')" :aria-label="t('inbox.search')" @click="searchOpen ? closeSearch() : searchOpen = true"><Icon name="lucide:search" size="16" /></Button>
              <Button variant="ghost" size="icon" class="hover:bg-secondary/50 hover:text-foreground dark:hover:bg-secondary/50 size-8 text-muted-foreground" :title="t('inbox.refresh')" :aria-label="t('inbox.refresh')" :disabled="loading" @click="refreshList()"><Icon name="lucide:refresh-cw" size="15" :class="loading ? 'animate-spin' : ''" /></Button>
            </div>
          </div>
          <form v-if="searchOpen" class="relative mb-3" @submit.prevent="refreshList()" @keydown.esc="closeSearch">
            <Input v-model="filters.q" autofocus :placeholder="t('inbox.search')" :aria-label="t('inbox.search')" class="h-8 pr-8 text-xs" />
            <Button type="button" variant="ghost" size="icon" class="hover:bg-secondary/50 hover:text-foreground dark:hover:bg-secondary/50 absolute right-0 top-0 size-8" :title="t('inbox.cancel')" :aria-label="t('inbox.cancel')" @click="closeSearch"><Icon name="lucide:x" size="13" /></Button>
          </form>
          <div class="flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <button type="button" class="flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-between gap-1 rounded-full border border-border bg-card px-2.5 text-xs font-bold text-primary transition-colors hover:bg-background/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-label="t('inbox.status')"><span class="truncate">{{ filters.status === 'all' ? t('inbox.all') : t(`inbox.statuses.${filters.status}`) }}</span><Icon name="lucide:chevron-down" size="12" /></button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <FilterOptionItem v-for="status in statusOptions" :key="status" :selected="filters.status === status" @select="pickStatus(status)">{{ status === 'all' ? t('inbox.all') : t(`inbox.statuses.${status}`) }}</FilterOptionItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <button type="button" class="flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-between gap-1 rounded-full border border-border bg-card px-2.5 text-xs font-bold text-primary transition-colors hover:bg-background/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-label="t('inbox.priority')"><span class="truncate">{{ filters.priority === 'all' ? t('inbox.allPriorities') : t(`inbox.${filters.priority}`) }}</span><Icon name="lucide:chevron-down" size="12" /></button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <FilterOptionItem :selected="filters.priority === 'all'" @select="filters.priority = 'all'">{{ t('inbox.allPriorities') }}</FilterOptionItem>
                <FilterOptionItem :selected="filters.priority === 'high'" @select="filters.priority = 'high'">{{ t('inbox.high') }}</FilterOptionItem>
                <FilterOptionItem :selected="filters.priority === 'normal'" @select="filters.priority = 'normal'">{{ t('inbox.normal') }}</FilterOptionItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="ghost" size="icon" class="hover:bg-secondary/50 hover:text-foreground dark:hover:bg-secondary/50 size-7 shrink-0 text-muted-foreground" :title="t(filters.sort === 'newest' ? 'inbox.newest' : 'inbox.oldest')" :aria-label="t(filters.sort === 'newest' ? 'inbox.newest' : 'inbox.oldest')" @click="filters.sort = filters.sort === 'newest' ? 'oldest' : 'newest'"><Icon :name="filters.sort === 'newest' ? 'lucide:arrow-down-wide-narrow' : 'lucide:arrow-up-narrow-wide'" size="15" /></Button>
          </div>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <div v-if="loading && !rows.length" role="status" class="flex items-center justify-center py-16">
            <div class="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span class="sr-only">{{ t('inbox.loading') }}</span>
          </div>
          <div v-else-if="!rows.length && !error" class="flex flex-col items-center justify-center px-5 py-16 text-center text-muted-foreground">
            <Icon :name="filters.q.trim() ? 'lucide:search-x' : 'lucide:inbox'" size="48" class="mb-4 opacity-50" />
            <p class="text-lg font-medium">{{ t('inbox.empty') }}</p>
            <p v-if="hasFilters" class="mt-1 text-sm">{{ t(filters.q.trim() ? 'dashboard.feedback.searchNoMatchHint' : 'dashboard.feedback.noResultsHint') }}</p>
            <button v-if="hasFilters" type="button" class="mt-4 h-8 rounded-lg border border-border px-3 text-xs font-bold transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="resetFilters">{{ t('inbox.clearFilters') }}</button>
          </div>
          <button v-for="row in rows" :key="row.id" class="flex w-full items-center gap-3 border-b border-l-2 px-4 py-3.5 text-left transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" :class="selected === row.id ? 'border-l-primary bg-primary/5' : 'border-l-transparent'" :aria-current="selected === row.id ? 'true' : undefined" :aria-label="`${authorName(row.customer)}: ${row.previewText || row.title || t('inbox.title')}`" :title="row.previewText || row.title || undefined" data-inbox-conversation @click="select(row.id)">
            <UserAvatar :author="row.customer" :size="9" />
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 items-center gap-2">
                <span class="min-w-0 flex-1 truncate text-[13px] leading-5" :class="isUnread(row.id) ? 'font-bold' : 'font-medium'" data-inbox-preview>{{ row.previewText || row.title || t('inbox.title') }}</span>
                <time class="shrink-0 text-[10px] text-muted-foreground" :datetime="row.lastMessageAt">{{ time(row.lastMessageAt) }}</time>
                <span class="inline-flex size-2 shrink-0" data-inbox-unread-slot>
                  <span v-if="isUnread(row.id)" class="size-2 rounded-full bg-primary" role="img" :aria-label="t('inbox.unread')" data-inbox-unread />
                </span>
              </div>
              <div class="mt-1.5 flex items-center gap-2" data-inbox-labels>
                <InboxStatusBadge :status="row.status" />
                <span v-if="row.priority === 'high'" class="inline-flex shrink-0 items-center text-primary" role="img" :aria-label="t('inbox.high')" :title="t('inbox.high')" data-inbox-priority>
                  <Icon name="lucide:flag" mode="svg" size="14" class="[&_path]:fill-current" aria-hidden="true" />
                </span>
              </div>
            </div>
          </button>
          <Button v-if="nextCursor" variant="ghost" class="w-full text-xs" :disabled="loading" @click="refreshList(true)">{{ t('inbox.loadMore') }}</Button>
        </div>
      </section>
      <div v-if="!selected" class="hidden flex-1 place-items-center bg-card p-10 md:grid">
        <div class="max-w-[460px] text-center">
          <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-secondary text-primary"><Icon name="lucide:messages-square" size="26" /></div>
          <p class="text-lg font-bold leading-[26px]">{{ t('inbox.title') }}</p>
          <p class="mt-2 text-sm leading-[22px] text-muted-foreground">{{ t('inbox.select') }}</p>
        </div>
      </div>
      <section v-else-if="detail" class="flex min-w-0 flex-1 flex-col" data-inbox-thread>
        <header class="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card px-3 sm:px-4">
          <Button variant="ghost" size="icon" class="hover:bg-secondary/50 hover:text-foreground dark:hover:bg-secondary/50 size-8 shrink-0 md:hidden" :title="t('inbox.back')" :aria-label="t('inbox.back')" @click="clearSelection"><Icon name="lucide:arrow-left" size="16" /></Button>
          <h2 class="min-w-0 flex-1 truncate font-heading text-sm font-semibold" :title="detail.conversation.title || t('inbox.title')">{{ detail.conversation.title || t('inbox.title') }}</h2>
          <span tabindex="0" :title="statusHint" :aria-label="statusHint"><InboxStatusBadge :status="detail.conversation.status" /></span>
          <DropdownMenu v-if="canReply">
            <DropdownMenuTrigger as-child><Button variant="ghost" size="icon" class="hover:bg-secondary/50 hover:text-foreground dark:hover:bg-secondary/50 size-8 shrink-0 text-muted-foreground" :disabled="activeAction !== null" :title="t('inbox.snooze')" :aria-label="t('inbox.snooze')"><Icon name="lucide:clock" size="16" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-72">
              <DropdownMenuLabel class="text-xs">{{ t('inbox.snooze') }}</DropdownMenuLabel>
              <DropdownMenuItem v-for="choice in snoozeChoices" :key="choice" class="group flex justify-between gap-4 py-2 text-xs focus:text-foreground" @select="command('snooze', { wakeAt: wakeTime(choice), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })"><span>{{ t(`inbox.snoozeOptions.${choice}`) }}</span><span class="text-[10px] text-muted-foreground group-focus:text-foreground/80">{{ date(wakeTime(choice)) }}</span></DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button v-if="detail.conversation.status === 'snoozed'" variant="ghost" size="icon" class="hover:bg-secondary/50 hover:text-foreground dark:hover:bg-secondary/50 size-8 shrink-0 text-muted-foreground" :disabled="activeAction !== null" :title="t('inbox.resume')" :aria-label="t('inbox.resume')" @click="command('resume')"><Icon name="lucide:play" size="16" /></Button>
          <Button v-if="canClose" variant="ghost" size="icon" class="hover:bg-secondary/50 hover:text-foreground dark:hover:bg-secondary/50 size-8 shrink-0 text-muted-foreground" :disabled="activeAction !== null" :title="t('inbox.close')" :aria-label="t('inbox.close')" @click="closeConversation"><Icon name="lucide:check-check" size="17" /></Button>
          <Button variant="ghost" size="icon" class="hover:bg-secondary/50 hover:text-foreground dark:hover:bg-secondary/50 size-8 shrink-0 text-muted-foreground" :class="(wide && showDetails) || drawer ? 'bg-primary/10 text-primary' : ''" :title="t((wide && showDetails) || drawer ? 'inbox.hideDetails' : 'inbox.showDetails')" :aria-label="t((wide && showDetails) || drawer ? 'inbox.hideDetails' : 'inbox.showDetails')" @click="wide ? showDetails = !showDetails : drawer = true"><Icon name="lucide:panel-right" size="16" /></Button>
        </header>
        <div ref="timeline" class="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-4 sm:p-5" data-inbox-timeline @scroll.passive="reportRead">
          <div v-if="detail.nextBeforeSeq" class="text-center"><Button variant="ghost" size="sm" class="text-xs" @click="loadDetail(selected!, true)">{{ t('inbox.earlier') }}</Button></div>
          <article v-for="item in visibleItems" :key="item.id" :data-inbox-message="item.id">
            <template v-if="item.authorType === 'system'">
              <div v-if="item.content.parts.some(part => part.type === 'system_event' && part.kind === 'handoff')" class="flex items-start gap-2.5">
                <div class="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"><Icon name="lucide:bot" size="14" /></div>
                <div class="min-w-0 max-w-[85%]">
                  <div class="w-fit max-w-full rounded-xl rounded-tl-sm border border-border bg-secondary/50 px-3.5 py-2.5 text-[13px] font-normal leading-relaxed" dir="auto" data-handoff-message>{{ customerConfirmation(item.content) }}</div>
                  <div class="mt-1.5 flex items-center gap-1 px-0.5 text-[10px] text-muted-foreground">
                    <span class="font-semibold text-foreground dark:text-white">{{ t('widget.messageAI') }}</span><span aria-hidden="true">·</span><time :datetime="item.createdAt">{{ time(item.createdAt) }}</time>
                  </div>
                </div>
              </div>
              <template v-for="(part, index) in item.content.parts" :key="index">
                <div v-if="part.type === 'system_event' && showSystemNotice(part)" class="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 py-1 text-center text-[11px] leading-relaxed text-muted-foreground">
                  <details v-if="part.kind === 'handoff' && part.rule" class="min-w-0 max-w-full">
                    <summary class="cursor-pointer list-none underline decoration-dotted underline-offset-4">{{ handoffNotice(part) }}</summary>
                    <p class="mt-2 max-w-prose whitespace-normal break-words text-left">{{ locale === 'zh' && part.rule.scenarioZh ? part.rule.scenarioZh : part.rule.scenario }}</p>
                  </details>
                  <span v-else-if="part.kind === 'handoff'">{{ handoffNotice(part) }}</span>
                  <span v-else-if="part.kind === 'takeover'">{{ t(item.author?.id && item.author.id === session?.user.id ? 'inbox.noticeTakeoverSelf' : 'inbox.noticeTakeover', { name: item.author?.name || t('widget.messageStaff') }) }}</span>
                  <span v-else>{{ t(part.kind === 'snoozed' ? 'inbox.noticeSnoozed' : 'inbox.noticeClosed', { name: item.author?.name || t('widget.messageStaff'), time: date(part.dueAt ?? null) }) }}</span>
                  <time :datetime="item.createdAt" class="text-[10px] opacity-75">{{ time(item.createdAt) }}</time>
                </div>
              </template>
            </template>
            <div v-else class="flex items-start gap-2.5" :class="item.authorType === 'staff' ? 'flex-row-reverse' : ''">
              <div v-if="item.authorType === 'agent'" class="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"><Icon name="lucide:bot" size="14" /></div>
              <UserAvatar v-else :author="item.author || (item.authorType === 'customer' ? detail.customer : null)" :size="6" />
              <div class="min-w-0 max-w-[85%]">
                <div class="w-fit max-w-full rounded-xl border border-border px-3.5 py-2.5 text-[13px] leading-relaxed" :class="item.authorType === 'staff' ? 'ml-auto rounded-tr-sm bg-primary/5' : item.authorType === 'agent' ? 'rounded-tl-sm bg-secondary/50' : 'rounded-tl-sm bg-card'">
                  <WidgetEmbedParts :content="item.content" :plain-text="item.authorType !== 'agent'" @feedback="openFeedback($event)" @article="openArticle" />
                </div>
                <div class="mt-1.5 flex items-center gap-1 px-0.5 text-[10px] text-muted-foreground" :class="item.authorType === 'staff' ? 'justify-end' : ''">
                  <span class="truncate font-semibold text-foreground dark:text-white">{{ item.authorType === 'agent' ? t('inbox.ai') : item.authorType === 'staff' ? (item.author?.name ? t('widget.messageStaffNamed', { name: item.author.name }) : t('widget.messageStaff')) : authorName(item.author || detail.customer) }}</span><span aria-hidden="true">·</span><time class="shrink-0" :datetime="item.createdAt">{{ time(item.createdAt) }}</time>
                </div>
              </div>
            </div>
            <div v-if="emailResults[item.id]?.status === 'failed'" role="status" class="mt-3 flex flex-wrap items-center justify-center gap-2 text-center text-[11px] text-muted-foreground">
              <Icon name="lucide:mail" size="12" />
              <span>{{ emailSending[item.id] ? t('inbox.emailSending') : t('inbox.emailFailed') }}</span>
              <button v-if="emailResults[item.id]!.canRetry" class="rounded-sm font-semibold text-primary underline underline-offset-4 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" @click="retryEmail(item.id)">{{ t('inbox.retryEmail') }}</button>
            </div>
          </article>
        </div>
        <form v-if="canReply || isAiHandling" class="shrink-0 border-t border-border bg-card p-3 sm:p-4" @submit.prevent="canReply && sendable && !uploading && command('reply')">
          <div class="overflow-hidden rounded-lg border border-border bg-card transition-shadow has-[textarea:focus]:border-primary has-[textarea:focus]:ring-[3px] has-[textarea:focus]:ring-primary/15">
            <div class="flex items-center gap-1.5 px-3 pt-2.5 text-[11px] font-semibold text-foreground"><Icon name="lucide:message-square" size="13" />{{ t('inbox.replyToCustomer') }}</div>
            <p v-if="isAiHandling" id="inbox-reply-unavailable" class="px-3 pt-1.5 text-xs text-muted-foreground">{{ t('inbox.aiReplyUnavailable') }}</p>
            <div class="relative">
              <textarea ref="replyInput" v-model="draft" :disabled="!canReply || sending" :placeholder="t('inbox.replyPlaceholder')" :aria-label="t('inbox.replyPlaceholder')" :aria-describedby="isAiHandling ? 'inbox-reply-unavailable' : undefined" maxlength="4000" rows="3" class="block max-h-32 min-h-16 w-full resize-none bg-transparent px-3 py-2 text-sm leading-relaxed outline-none disabled:cursor-not-allowed disabled:opacity-50" @keydown.enter.exact="sendKey" @paste="pasteImages" />
              <!-- Mouse only: keyboard users reach the takeover button next in order. -->
              <div v-if="isAiHandling" class="absolute inset-0 cursor-default" aria-hidden="true" data-inbox-reply-locked @click="pointToTakeover" />
            </div>
            <div v-if="images.length || uploading" class="flex gap-2 overflow-x-auto px-3 pb-2">
              <div v-for="(image, index) in images" :key="image.key" class="relative size-14 shrink-0 overflow-hidden rounded-md border border-border [&_img]:size-14 [&_img]:object-cover"><WidgetEmbedImage :storage-key="image.key" /><Button type="button" variant="secondary" size="icon" class="absolute right-0 top-0 size-5" :disabled="!canReply || sending" :title="t('inbox.removeImage')" :aria-label="t('inbox.removeImage')" @click="draftImages[selected!]!.splice(index, 1)"><Icon name="lucide:x" size="12" /></Button></div>
              <div v-if="uploading" class="grid size-14 shrink-0 place-items-center rounded-md border border-border"><Icon name="lucide:loader-2" size="16" class="animate-spin text-muted-foreground" /></div>
            </div>
            <div class="flex items-center justify-between gap-2 px-2 pb-2">
              <input ref="fileInput" type="file" accept="image/*" multiple class="hidden" :disabled="!canReply || sending || uploading" @change="pickFiles">
              <Button type="button" variant="ghost" size="icon" class="hover:bg-secondary/50 hover:text-foreground dark:hover:bg-secondary/50 size-8 text-muted-foreground" :disabled="!canReply || sending || uploading" :title="t('widget.attachImage')" :aria-label="t('widget.attachImage')" @click="fileInput?.click()"><Icon name="lucide:image" size="16" /></Button>
              <div class="flex items-center gap-2">
                <span v-if="canReply" class="hidden whitespace-nowrap text-[10px] text-muted-foreground lg:inline">Enter</span>
                <div class="inline-flex w-56 shrink-0 items-stretch rounded-md" :class="[canReply && (sending || uploading || !sendable) ? 'opacity-50' : '', takeoverPulse && 'inbox-takeover-pulse']" data-inbox-send @animationend="takeoverPulse = false">
                  <Button v-if="isAiHandling" ref="takeoverButton" type="button" variant="default" size="sm" class="h-9 min-w-0 flex-1 gap-1.5 text-xs" :disabled="busy || takeoverPending" :aria-busy="activeAction === 'takeover' || takeoverPending" @click="command('takeover')"><Icon :name="activeAction === 'takeover' || takeoverPending ? 'lucide:loader-2' : 'lucide:message-square-reply'" size="14" :class="activeAction === 'takeover' || takeoverPending ? 'animate-spin' : ''" />{{ t(takeoverPending ? 'inbox.takeoverWaiting' : 'inbox.takeover') }}</Button>
                  <Button v-else type="submit" variant="default" size="sm" class="h-9 min-w-0 flex-1 gap-1.5 rounded-r-none text-xs disabled:opacity-100" :disabled="!canReply || sending || uploading || !sendable"><Icon :name="sending ? 'lucide:loader-2' : 'lucide:send'" size="14" :class="sending ? 'animate-spin' : ''" />{{ t(deliveryMode === 'immediate' ? 'inbox.deliveryImmediate' : 'inbox.deliveryAuto') }}</Button>
                  <DropdownMenu v-if="canReply">
                    <DropdownMenuTrigger as-child>
                      <Button type="button" variant="default" size="sm" class="h-9 w-8 rounded-l-none border-l border-primary-foreground/25 px-0 disabled:opacity-100" :disabled="!canReply || sending || uploading" :title="t('inbox.deliveryMode')" :aria-label="t('inbox.deliveryMode')"><Icon name="lucide:chevron-down" size="14" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="top" align="end" class="w-56 max-w-[calc(100vw-2rem)]">
                      <FilterOptionItem :selected="deliveryMode === 'auto'" :description="t('inbox.deliveryAutoDescription')" :text-value="t('inbox.deliveryAuto')" class="py-2.5" @select="deliveryMode = 'auto'">{{ t('inbox.deliveryAuto') }}</FilterOptionItem>
                      <FilterOptionItem :selected="deliveryMode === 'immediate'" :description="t('inbox.deliveryImmediateDescription')" :text-value="t('inbox.deliveryImmediate')" class="py-2.5" @select="deliveryMode = 'immediate'">{{ t('inbox.deliveryImmediate') }}</FilterOptionItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          </div>
        </form>
      </section>
      <div v-else role="status" class="flex flex-1 items-center justify-center bg-card py-16">
        <div class="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <span class="sr-only">{{ t('inbox.loading') }}</span>
      </div>
      <aside v-if="detail && wide && showDetails" class="w-64 shrink-0 overflow-y-auto border-l border-border bg-card 2xl:w-72" data-inbox-details>
        <InboxCustomerDetails :customer="detail.customer" :conversation="detail.conversation" :feedbacks="feedbacks" :busy="activeAction === 'set_priority'" :has-more="feedbacks.length < feedbackTotal" @priority="command('set_priority', { priority: $event })" @feedback="openFeedback($event)" @more="loadFeedback(true)" />
      </aside>
    </div>
    <PostDetailModal v-model:open="feedbackOpen" :slug="feedbackSlug" @updated="loadFeedback()" />
    <Sheet v-model:open="drawer"><SheetContent side="right" class="overflow-y-auto p-0"><SheetTitle class="sr-only">{{ t('inbox.customerDetails') }}</SheetTitle><SheetDescription class="sr-only">{{ t('inbox.customer') }}</SheetDescription><InboxCustomerDetails v-if="detail" :customer="detail.customer" :conversation="detail.conversation" :feedbacks="feedbacks" :busy="activeAction === 'set_priority'" :has-more="feedbacks.length < feedbackTotal" @priority="command('set_priority', { priority: $event })" @feedback="openFeedback($event); drawer = false" @more="loadFeedback(true)" /></SheetContent></Sheet>
  </div>
</template>

<style scoped>
/* One emphasis pulse on the takeover button, then back to none. The gap in card
   colour keeps the ring apart from the primary-coloured button. */
.inbox-takeover-pulse { animation: inbox-takeover-pulse 1.2s ease-in-out; }
@keyframes inbox-takeover-pulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--card), 0 0 0 0 color-mix(in oklab, var(--primary) 0%, transparent); }
  20%, 45% { box-shadow: 0 0 0 2px var(--card), 0 0 0 5px color-mix(in oklab, var(--primary) 55%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  .inbox-takeover-pulse { animation-duration: 0.01s; }
}
</style>

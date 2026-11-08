<script setup lang="ts">
import { resolveAttachmentUrl } from '#layers/feedlog/app/utils/attachment'
import { widgetEmbedKey } from '#layers/feedlog/app/composables/useWidgetEmbed'
import { widgetProtocolKey } from '#layers/feedlog/app/composables/useWidgetProtocol'
import { widgetResumeSchema, type WidgetChatResume } from '#layers/feedlog/app/composables/useWidgetResume'
import type { WidgetFeedbackItem } from '#layers/feedlog/server/api/widget/feedback/index.get'
import type { WidgetConversationItem } from '#layers/feedlog/server/api/widget/conversations/index.get'

// /widget/embed — the FeedLog-hosted page the widget SDK loads in its iframe.
//
// No layout and no auth middleware on purpose: the portal chrome is cookie-backed,
// and identity here comes only from the bearer token in the URL fragment.
definePageMeta({ layout: false, middleware: [] })

const route = useRoute()
const { t } = useI18n()

const embed = useWidgetEmbed()
const { status, allowGuest, widgetFetch, loadSession } = embed
const protocol = useWidgetProtocol()
const widgetLocale = useWidgetLocale(protocol.locale)
provide(widgetEmbedKey, embed)
provide(widgetProtocolKey, protocol)

// ---- theme ---------------------------------------------------------------
// The host picks the theme by query so the very first frame is already correct —
// a widget that flashes white inside a dark app is the reason this isn't
// negotiated over postMessage after load.
const themeParam = computed(() => {
  const raw = protocol.theme.value ?? route.query.theme
  return raw === 'dark' || raw === 'light' ? raw : 'auto'
})
const systemDark = ref(false)
const isDark = computed(() => themeParam.value === 'dark' || (themeParam.value === 'auto' && systemDark.value))

// ---- branding ------------------------------------------------------------
// The SDK applies these to its own launcher and panel but does not pass them
// into the frame, so the page fetches them itself — otherwise a customer with a
// purple brand gets a purple launcher wrapped around a FeedLog-red widget.
//
// setProperty, not an injected <style>: it treats the value as a CSS token that
// cannot break out of the declaration. The endpoint already normalises these to
// hex, but that check lives behind an HTTP boundary in another module, and this
// is the one page any origin may frame — too much to stake on a distant regex.
function applyBrand(brand: { primary: string, primaryForeground: string }) {
  const root = document.documentElement
  root.style.setProperty('--primary', brand.primary)
  root.style.setProperty('--primary-foreground', brand.primaryForeground)
  root.style.setProperty('--ring', brand.primary)
}

const org = ref<{ name: string, logo: string | null }>({ name: '', logo: null })
const orgInitial = computed(() => org.value.name.trim().charAt(0).toUpperCase() || 'F')
// Mirrors the prompt's own fallback, so greeting and model name an unnamed
// workspace the same way.
const productName = computed(() => org.value.name || t('widget.thisProduct'))

useHead(() => ({
  htmlAttrs: { class: `overflow-hidden overscroll-none${isDark.value ? ' dark' : ''}` },
  bodyAttrs: { class: 'overflow-hidden overscroll-none' },
  script: themeParam.value === 'auto'
    ? [{
        key: 'widget-embed-auto-theme',
        innerHTML: "try{document.documentElement.classList.toggle('dark',window.matchMedia('(prefers-color-scheme: dark)').matches)}catch(e){}",
      }]
    : [],
}))

// 'conversations' is the root; the other two both return to it.
const view = ref<'conversations' | 'chat' | 'list'>('chat')
const conversations = ref<WidgetConversationItem[]>([])
const activeConversationId = ref<string | null>(null)
const chatKey = ref(0)
const savedChat = ref<WidgetChatResume | null>(null)
const restoredChat = ref<WidgetChatResume | null>(null)
const widgetRoot = ref<HTMLElement | null>(null)
let scrollTop = 0
let authed = false

function rememberScroll(event: Event) {
  const target = event.target
  if (target instanceof HTMLElement && target.clientHeight > 0) scrollTop = target.scrollTop
}

protocol.onResume(() => ({
  owner: embed.user.value?.email ?? null,
  anonymous: !embed.user.value || embed.user.value.isAnonymous === true,
  view: view.value,
  conversationId: activeConversationId.value,
  chat: savedChat.value ? JSON.parse(JSON.stringify(savedChat.value)) : null,
  scrollTop,
}), async (state) => {
  const parsed = widgetResumeSchema.safeParse(state)
  if (!parsed.success) return
  const saved = parsed.data
  // A guest may claim their own draft on login; a different signed-in account
  // must never inherit the previous account's conversation or composer.
  if (!saved.anonymous && saved.owner !== embed.user.value?.email) return
  activeConversationId.value = saved.view === 'chat'
    ? (saved.chat?.conversationId ?? saved.conversationId)
    : saved.conversationId
  restoredChat.value = saved.chat
  savedChat.value = saved.chat
  view.value = saved.view
  await nextTick()
  await document.fonts.ready
  const body = widgetRoot.value?.querySelector<HTMLElement>('.overflow-y-auto')
  if (body && saved.view !== 'chat') body.scrollTop = saved.scrollTop
})

function panelVisible() {
  return document.body.getBoundingClientRect().height > 0
}

function containWheel(event: WheelEvent) {
  if (event.ctrlKey || !event.deltaY) return
  // Some browsers ignore overscroll containment when iframe content has no scroll range.
  for (const node of event.composedPath()) {
    if (node instanceof HTMLElement) {
      const { overflowY } = getComputedStyle(node)
      if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return
    }
    if (node === event.currentTarget) break
  }
  event.preventDefault()
}

const headerTitle = computed(() => {
  if (view.value === 'conversations') return t('widget.messages')
  if (view.value === 'list') return t('widget.myFeedback')
  return t('widget.agentTitle', { product: productName.value })
})

async function loadConversations() {
  try {
    const res = await widgetFetch<{ data: WidgetConversationItem[] }>('/api/widget/conversations')
    conversations.value = res.data
  }
  catch { /* leave the list as-is */ }
}

// ---- feedback list -------------------------------------------------------
const PAGE_SIZE = 20
const feedback = ref<WidgetFeedbackItem[]>([])
const listLoading = ref(false)
const nextCursor = ref<string | null>(null)
const totalCount = ref(0)
const totalKnown = ref(false)

// Counted by the server, not by the loaded rows: an unread item can sit past the
// page this frame has fetched. unreadCount is the merged badge (posts +
// conversations); feedbackUnread is the posts-only number the UI labels.
const unreadCount = ref(0)
const feedbackUnread = ref(0)

interface BadgeCounts { count: number, feedback: number }

// The SDK owns the badge; it only learns of it from here.
function applyBadge(res: BadgeCounts) {
  unreadCount.value = res.count
  feedbackUnread.value = res.feedback
  protocol.reportUnread(res.count)
}

async function loadUnread() {
  try {
    applyBadge(await widgetFetch<BadgeCounts>('/api/widget/unread'))
  }
  catch { /* keep the last known count */ }
}

async function markConversationRead(id: string, lastSeq: number) {
  try {
    const result = await widgetFetch<BadgeCounts & { cleared: boolean }>(`/api/widget/conversations/${id}/read`, { method: 'POST', body: JSON.stringify({ observed_last_seq: lastSeq }) })
    applyBadge(result)
    const row = conversations.value.find(c => c.id === id)
    if (row && result.cleared) row.unread = false
  }
  catch { /* the dot stays; a later load will correct it */ }
}

async function loadFeedback(append = false) {
  listLoading.value = true
  try {
    const cursor = append && nextCursor.value ? `&cursor=${encodeURIComponent(nextCursor.value)}` : ''
    const pageSize = append ? PAGE_SIZE : Math.max(feedback.value.length, PAGE_SIZE)
    const res = await widgetFetch<{
      data: WidgetFeedbackItem[]
      total: number
      pagination: { nextCursor: string | null }
    }>(`/api/widget/feedback?pageSize=${pageSize}${cursor}`)
    feedback.value = append ? [...feedback.value, ...res.data] : res.data
    nextCursor.value = res.pagination.nextCursor
    totalCount.value = res.total
    totalKnown.value = true
  }
  catch { /* leave the list as-is */ }
  finally {
    listLoading.value = false
  }
}

// The SDK calls takeOver() as it mounts this frame and never releases, so its
// own unread polling is off for the life of the page.
function refreshOnVisible() {
  if (document.visibilityState !== 'visible') return
  void loadUnread()
  if (view.value === 'list') void loadFeedback()
}

// Opening an item clears its dot and hands the SDK the slug — the detail page
// opens as a top-level tab, where cookies work and the full board is available.
async function openItem(item: WidgetFeedbackItem) {
  protocol.navigateToFeedback(item.slug)
  if (!item.unread) return
  try {
    const res = await widgetFetch<BadgeCounts>(`/api/widget/feedback/${item.id}/read`, { method: 'POST' })
    item.unread = false
    applyBadge(res)
  }
  catch { /* the dot stays; a later load will correct it */ }
}

function onAuthRequired() {
  status.value = 'anonymous'
  protocol.requestAuth('expired')
}

function onFiled() {
  void Promise.all([loadFeedback(), loadUnread(), loadConversations()])
}

function onOpenFeedback() {
  view.value = 'list'
  void loadFeedback()
}

function onOpenConversation(id: string) {
  activeConversationId.value = id
  view.value = 'chat'
}

function onReplied(id: string, lastSeq: number) {
  if (view.value !== 'chat') return
  activeConversationId.value = id
  if (!panelVisible()) {
    void loadUnread()
    return
  }
  void markConversationRead(id, lastSeq)
}

function onNewConversation() {
  chatKey.value++
  activeConversationId.value = null
  view.value = 'chat'
}

function onBack() {
  view.value = 'conversations'
  void loadConversations()
}

function resetToRoot() {
  chatKey.value++
  activeConversationId.value = null
  view.value = conversations.value.length || totalCount.value ? 'conversations' : 'chat'
}

async function settleView() {
  await Promise.all([loadConversations(), loadUnread(), loadFeedback()])
  resetToRoot()
}

let panelObserver: ResizeObserver | null = null
const probeArmed = ref(true)

function watchPanelVisibility() {
  let shown = true
  panelObserver = new ResizeObserver(([entry]) => {
    const now = (entry?.contentRect.height ?? 0) > 0
    if (now === shown) return
    shown = now
    if (shown) void Promise.all([loadConversations(), loadUnread(), loadFeedback()])
  })
  panelObserver.observe(document.documentElement)
}

function onFirstRender() {
  probeArmed.value = false
  if (!authed) return
  watchPanelVisibility()
  void Promise.all([loadConversations(), loadUnread(), loadFeedback()])
}

// A guest who just sent their first message now has an identity, so the lists
// and the badge start applying to them. No settleView: they are mid-conversation
// and resetting to the root would throw them out of it.
watch(status, (now, before) => {
  if (now !== 'authenticated' || before !== 'guest') return
  authed = true
  watchPanelVisibility()
  document.addEventListener('visibilitychange', refreshOnVisible)
  void loadUnread()
})

// ---- lifecycle -----------------------------------------------------------
onMounted(async () => {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  systemDark.value = mq.matches
  mq.addEventListener('change', e => { systemDark.value = e.matches })

  protocol.init()

  // Awaited alongside the session because the greeting names the product. A
  // failure costs only the brand colour and the name.
  const config = $fetch<{
    org: { name: string, logo: string | null }
    allowGuest: boolean
    imageMaxBytes?: number
    branding: { primary: string, primaryForeground: string }
  }>('/api/widget/config')
    .then((cfg) => {
      applyBrand(cfg.branding)
      org.value = cfg.org
      allowGuest.value = cfg.allowGuest
      if (cfg.imageMaxBytes) embed.imageMaxBytes.value = cfg.imageMaxBytes
    })
    .catch(() => {})

  const [signedIn] = await Promise.all([loadSession(), config, widgetLocale.init()])
  // Nobody yet, but writing is allowed: open on the composer rather than the
  // wall. The identity appears on the first send, not here.
  if (!signedIn && allowGuest.value) status.value = 'guest'
  authed = signedIn
  if (authed) {
    // Awaited: the SDK hides this frame until ready(), so settling the view
    // here costs a round trip but never flashes the wrong one.
    await settleView()
    document.addEventListener('visibilitychange', refreshOnVisible)
  }

  // ready last, so the SDK drops its loading state only once this frame has
  // settled into one of its states.
  protocol.ready()
})

onUnmounted(() => {
  document.removeEventListener('visibilitychange', refreshOnVisible)
  panelObserver?.disconnect()
})
</script>

<template>
  <div ref="widgetRoot" class="relative h-dvh overflow-hidden flex flex-col bg-background text-foreground" @wheel="containWheel" @scroll.capture="rememberScroll">
    <span v-if="probeArmed" class="render-probe" aria-hidden="true" @animationstart="onFirstRender" />

    <!-- Header -->
    <header class="min-h-16 px-4 pt-[env(safe-area-inset-top)] border-b border-border bg-card flex items-center gap-2.5 shrink-0">
      <button
        v-if="view !== 'conversations'"
        class="w-7 h-7 shrink-0 hover:opacity-70 transition-opacity flex items-center justify-center text-primary"
        :aria-label="t('widget.back')"
        @click="onBack"
      >
        <Icon name="lucide:arrow-left" size="17" />
      </button>
      <img
        v-if="view === 'chat' && org.logo"
        :src="resolveAttachmentUrl(org.logo)!"
        alt=""
        class="w-7 h-7 rounded-md object-cover shrink-0"
      >
      <span
        v-else-if="view === 'chat'"
        class="w-7 h-7 rounded-md shrink-0 grid place-items-center bg-primary text-primary-foreground font-heading font-bold text-[13px]"
      >{{ orgInitial }}</span>
      <div class="flex-1 min-w-0" :class="view === 'conversations' ? 'text-center' : ''">
        <p
          class="font-heading truncate"
          :class="view === 'conversations' ? 'text-lg font-bold leading-6' : 'font-semibold text-[15.5px]'"
        >
          {{ headerTitle }}
        </p>
        <p v-if="view === 'list' && totalCount" class="mt-0.5 text-xs text-muted-foreground truncate">
          {{ t('widget.postCount', { count: totalCount }, totalCount) }}<template v-if="feedbackUnread"> · {{ t('widget.withUpdates', { count: feedbackUnread }, feedbackUnread) }}</template>
        </p>

      </div>
      <button
        class="w-6.5 h-6.5 rounded-full bg-secondary hover:opacity-80 transition-opacity flex items-center justify-center text-primary shrink-0"
        :aria-label="t('widget.close')"
        data-fdl-action="widget_panel_close"
        @click="protocol.requestClose()"
      >
        <Icon name="lucide:x" size="13" />
      </button>
    </header>

    <!-- Signed out, and this org does not accept guests -->
    <div v-if="status === 'anonymous'" class="flex-1 flex flex-col items-center justify-center gap-3 px-8 text-center">
      <Icon name="lucide:message-circle" size="28" class="text-muted-foreground" />
      <p class="font-heading font-bold text-sm">{{ t('widget.loginTitle') }}</p>
      <p class="text-xs text-muted-foreground leading-relaxed">{{ t('widget.loginDesc') }}</p>
      <button
        class="mt-1 h-9 px-5 rounded-md bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 transition-all"
        @click="protocol.requestAuth('user')"
      >
        {{ t('widget.login') }}
      </button>
    </div>

    <div v-else-if="status === 'loading'" class="flex-1 flex items-center justify-center">
      <Icon name="lucide:loader-2" size="20" class="animate-spin text-muted-foreground" />
    </div>

    <!-- Chat only: a trip to the list must not wipe the conversation. -->
    <KeepAlive v-else include="WidgetEmbedChat" :max="1">
      <WidgetEmbedConversationList
        v-if="view === 'conversations'"
        :items="conversations"
        :org-initial="orgInitial"
        :total-count="totalCount"
        :total-known="totalKnown"
        :unread-count="feedbackUnread"
        @open="onOpenConversation"
        @open-feedback="onOpenFeedback"
        @new-conversation="onNewConversation"
      />

      <WidgetEmbedFeedbackList
        v-else-if="view === 'list'"
        :items="feedback"
        :loading="listLoading"
        :has-more="!!nextCursor"
        @load-more="loadFeedback(true)"
        @open="openItem"
      />

      <WidgetEmbedChat
        v-else
        :key="chatKey"
        :product-name="productName"
        :open-id="activeConversationId"
        :resume-state="restoredChat"
        @state-change="savedChat = $event"
        @auth-required="onAuthRequired"
        @filed="onFiled"
        @replied="onReplied"
      />
    </KeepAlive>

    <a
      v-if="status !== 'loading'"
      href="https://feedlog.ai"
      target="_blank"
      rel="noopener"
      class="block pt-1.5 pb-[max(6px,env(safe-area-inset-bottom))] bg-card text-center text-[10.5px] text-muted-foreground shrink-0 hover:text-foreground transition-colors"
    >
      {{ t('board.poweredBy') }}FeedLog
    </a>
  </div>
</template>

<style scoped>
.render-probe {
  position: fixed;
  width: 1px;
  height: 1px;
  pointer-events: none;
  opacity: 0;
  animation: render-probe 1ms linear;
}

@keyframes render-probe {
  from { opacity: 0; }
  to { opacity: 0; }
}
</style>

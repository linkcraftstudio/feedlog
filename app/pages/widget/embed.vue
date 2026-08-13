<script setup lang="ts">
import { resolveAttachmentUrl } from '~/utils/attachment'
import { widgetEmbedKey } from '~/composables/useWidgetEmbed'
import { widgetProtocolKey } from '~/composables/useWidgetProtocol'
import type { WidgetFeedbackItem } from '~~/server/api/widget/feedback/index.get'
import type { WidgetConversationItem } from '~~/server/api/widget/conversations/index.get'

// /widget/embed — the FeedLog-hosted page the widget SDK loads in its iframe.
//
// No layout and no auth middleware on purpose: the portal chrome is cookie-backed,
// and identity here comes only from the bearer token in the URL fragment.
definePageMeta({ layout: false, middleware: [] })

const route = useRoute()
const { t } = useI18n()

const embed = useWidgetEmbed()
const { status, widgetFetch, loadSession } = embed
const protocol = useWidgetProtocol()
provide(widgetEmbedKey, embed)
provide(widgetProtocolKey, protocol)

// ---- theme ---------------------------------------------------------------
// The host picks the theme by query so the very first frame is already correct —
// a widget that flashes white inside a dark app is the reason this isn't
// negotiated over postMessage after load.
const themeParam = computed(() => {
  const raw = route.query.theme
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
  htmlAttrs: { class: isDark.value ? 'dark' : '' },
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
let authed = false

function panelVisible() {
  return document.body.getBoundingClientRect().height > 0
}

const headerTitle = computed(() => {
  if (view.value === 'conversations') return t('widget.messages')
  if (view.value === 'list') return t('widget.myFeedback')
  return t('widget.agentTitle')
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

async function markConversationRead(id: string) {
  try {
    applyBadge(await widgetFetch<BadgeCounts>(`/api/widget/conversations/${id}/read`, { method: 'POST' }))
    const row = conversations.value.find(c => c.id === id)
    if (row) row.unread = false
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
  void markConversationRead(id)
}

function onReplied(id: string) {
  if (!panelVisible()) {
    void loadUnread()
    return
  }
  void markConversationRead(id)
}

function onNewConversation() {
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

function onFirstRender() {
  probeArmed.value = false
  if (!authed) return
  let shown = true
  panelObserver = new ResizeObserver(([entry]) => {
    const now = (entry?.contentRect.height ?? 0) > 0
    if (now === shown) return
    shown = now
    if (shown) void settleView()
    else resetToRoot()
  })
  panelObserver.observe(document.documentElement)
  void settleView()
}

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
    branding: { primary: string, primaryForeground: string }
  }>('/api/widget/config')
    .then((cfg) => {
      applyBrand(cfg.branding)
      org.value = cfg.org
    })
    .catch(() => {})

  const [signedIn] = await Promise.all([loadSession(), config])
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
  <div class="h-screen flex flex-col bg-background text-foreground">
    <span v-if="probeArmed" class="render-probe" aria-hidden="true" @animationstart="onFirstRender" />

    <!-- Header -->
    <header class="h-16 px-4 border-b border-border bg-card flex items-center gap-2.5 shrink-0">
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
        <p v-else-if="view === 'chat' && org.name" class="mt-0.5 text-xs text-muted-foreground leading-snug line-clamp-2">
          {{ t('widget.subtitle', { product: org.name }) }}
        </p>
      </div>
      <button
        class="w-6.5 h-6.5 rounded-full bg-secondary hover:opacity-80 transition-opacity flex items-center justify-center text-primary shrink-0"
        :aria-label="t('widget.close')"
        @click="protocol.requestClose()"
      >
        <Icon name="lucide:x" size="13" />
      </button>
    </header>

    <!-- Signed out -->
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
        @auth-required="onAuthRequired"
        @filed="onFiled"
        @replied="onReplied"
      />
    </KeepAlive>

    <p v-if="status !== 'loading'" class="py-1.5 bg-card text-center text-[10.5px] text-muted-foreground shrink-0">
      {{ t('board.poweredBy') }}FeedLog
    </p>
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

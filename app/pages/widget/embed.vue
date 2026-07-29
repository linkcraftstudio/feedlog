<script setup lang="ts">
import type { WidgetFeedbackItem } from '~~/server/api/widget/feedback/index.get'

// /widget/embed — the FeedLog-hosted page the widget SDK loads in its iframe.
//
// No layout and no auth middleware on purpose: the portal chrome is cookie-backed,
// and identity here comes only from the bearer token in the URL fragment.
definePageMeta({ layout: false, middleware: [] })

const route = useRoute()
const { t } = useI18n()
const { user, status, widgetFetch, loadSession } = useWidgetEmbed()
const protocol = useWidgetProtocol()

// ---- theme ---------------------------------------------------------------
// The host picks the theme by query so the very first frame is already correct —
// a widget that flashes white inside a dark app is the reason this isn't
// negotiated over postMessage after load.
const themeParam = computed(() => {
  const raw = route.query.theme
  return raw === 'light' || raw === 'dark' ? raw : 'auto'
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
function applyBrand(brand: { primary: string; primaryForeground: string }) {
  const root = document.documentElement.style
  root.setProperty('--primary', brand.primary)
  root.setProperty('--ring', brand.primary)
  root.setProperty('--primary-foreground', brand.primaryForeground)
}

useHead(() => ({
  title: 'FeedLog',
  htmlAttrs: { class: isDark.value ? 'dark' : undefined },
  meta: [{ name: 'robots', content: 'noindex, nofollow' }],
  script: themeParam.value === 'auto'
    ? [{
        key: 'widget-embed-auto-theme',
        innerHTML: "try{document.documentElement.classList.toggle('dark',window.matchMedia('(prefers-color-scheme: dark)').matches)}catch(e){}",
      }]
    : [],
}))

// ---- chat ----------------------------------------------------------------
interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  post?: { id: string; slug: string; title: string; board: string | null; status: string }
}

const view = ref<'chat' | 'list'>('chat')
const messages = ref<ChatMessage[]>([])
const draft = ref('')
const sending = ref(false)
const bodyEl = ref<HTMLElement | null>(null)

function scrollToBottom() {
  nextTick(() => { if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight })
}

async function send() {
  const text = draft.value.trim()
  if (!text || sending.value) return
  messages.value.push({ role: 'user', text })
  draft.value = ''
  sending.value = true
  scrollToBottom()
  try {
    const res = await widgetFetch<{ type: string; reply: string; post?: ChatMessage['post'] }>(
      '/api/widget/messages',
      { method: 'POST', body: JSON.stringify({ text }) },
    )
    messages.value.push({ role: 'assistant', text: res.reply, post: res.post })
    // A new post belongs in the list the moment it exists.
    if (res.post) void loadFeedback()
  }
  catch (e) {
    // 401 means the SDK must re-exchange; anything else is a plain failure.
    if ((e as { statusCode?: number })?.statusCode === 401) {
      status.value = 'anonymous'
      protocol.requestAuth('expired')
    }
    else {
      messages.value.push({ role: 'assistant', text: t('widget.sendFailed') })
    }
  }
  finally {
    sending.value = false
    scrollToBottom()
  }
}

// ---- feedback list -------------------------------------------------------
const feedback = ref<WidgetFeedbackItem[]>([])
const listLoading = ref(false)
const unreadCount = computed(() => feedback.value.filter(f => f.unread).length)

// The SDK owns the badge; it only learns of changes from here.
watch(unreadCount, c => protocol.reportUnread(c))

async function loadFeedback() {
  listLoading.value = true
  try {
    const res = await widgetFetch<{ data: WidgetFeedbackItem[] }>('/api/widget/feedback?pageSize=50')
    feedback.value = res.data
  }
  catch {
    // Leave the list as-is; the header count simply doesn't update.
  }
  finally {
    listLoading.value = false
  }
}

// Opening an item clears its dot and hands the SDK the slug — the detail page
// opens as a top-level tab, where cookies work and the full board is available.
async function openItem(item: WidgetFeedbackItem) {
  protocol.navigateToFeedback(item.slug)
  if (!item.unread) return
  try {
    await widgetFetch(`/api/widget/feedback/${item.id}/read`, { method: 'POST' })
    item.unread = false
  }
  catch { /* the dot stays; a later load will correct it */ }
}

// ---- lifecycle -----------------------------------------------------------
onMounted(async () => {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  systemDark.value = mq.matches
  mq.addEventListener('change', e => { systemDark.value = e.matches })

  protocol.init()

  // Anonymous and cheap; failing it only costs the brand colour.
  void $fetch<{ branding: { primary: string; primaryForeground: string } }>('/api/widget/config')
    .then(cfg => applyBrand(cfg.branding))
    .catch(() => {})

  const authed = await loadSession()
  if (authed) {
    messages.value.push({ role: 'assistant', text: t('widget.greeting') })
    await loadFeedback()
  }

  // ready last, so the SDK drops its loading state only once this frame has
  // settled into one of its states.
  protocol.ready()
})
</script>

<template>
  <div class="h-screen flex flex-col bg-background text-foreground">
    <!-- Header -->
    <header class="h-14 px-4 border-b border-border flex items-center gap-3 shrink-0">
      <button
        v-if="view === 'list'"
        class="w-7 h-7 rounded-md hover:bg-secondary transition-colors flex items-center justify-center text-muted-foreground"
        :aria-label="t('widget.back')"
        @click="view = 'chat'"
      >
        <Icon name="lucide:arrow-left" size="16" />
      </button>
      <p class="flex-1 font-heading font-bold text-sm truncate">
        {{ view === 'list' ? t('widget.myFeedback') : 'FeedLog' }}
      </p>
      <button
        class="w-7 h-7 rounded-md hover:bg-secondary transition-colors flex items-center justify-center text-muted-foreground"
        :aria-label="t('widget.close')"
        @click="protocol.requestClose()"
      >
        <Icon name="lucide:x" size="16" />
      </button>
    </header>

    <!-- Signed out -->
    <div v-if="status === 'anonymous'" class="flex-1 flex flex-col items-center justify-center gap-3 px-8 text-center">
      <Icon name="lucide:message-circle" size="28" class="text-muted-foreground" />
      <p class="font-heading font-bold text-sm">{{ t('widget.loginTitle') }}</p>
      <p class="text-xs text-muted-foreground leading-relaxed">{{ t('widget.loginDesc') }}</p>
      <button
        class="mt-1 h-9 px-5 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 transition-all"
        @click="protocol.requestAuth('user')"
      >
        {{ t('widget.login') }}
      </button>
    </div>

    <div v-else-if="status === 'loading'" class="flex-1 flex items-center justify-center">
      <Icon name="lucide:loader-2" size="20" class="animate-spin text-muted-foreground" />
    </div>

    <!-- Feedback list -->
    <div v-else-if="view === 'list'" ref="bodyEl" class="flex-1 overflow-y-auto">
      <p v-if="!feedback.length && !listLoading" class="px-5 py-8 text-xs text-muted-foreground text-center">
        {{ t('widget.noFeedback') }}
      </p>
      <ul v-else class="divide-y divide-border">
        <li v-for="item in feedback" :key="item.id">
          <button class="w-full text-left px-4 py-3 hover:bg-secondary/50 transition-colors" @click="openItem(item)">
            <div class="flex items-start gap-2">
              <span v-if="item.unread" class="mt-1.5 w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
              <div class="flex-1 min-w-0">
                <p class="text-xs font-semibold leading-snug">{{ item.title }}</p>
                <div class="mt-1.5 flex items-center gap-2">
                  <WidgetEmbedStatusBadge :status="item.status" />
                  <span class="text-[10px] text-muted-foreground flex items-center gap-0.5">
                    <Icon name="lucide:chevron-up" size="11" />{{ item.voteCount }}
                  </span>
                </div>
              </div>
            </div>
          </button>
        </li>
      </ul>
    </div>

    <!-- Chat -->
    <template v-else>
      <button
        class="mx-3 mt-3 px-3 py-2.5 rounded-xl border border-border bg-card hover:border-primary/40 transition-colors flex items-center gap-2 shrink-0"
        @click="view = 'list'; loadFeedback()"
      >
        <Icon name="lucide:inbox" size="14" class="text-muted-foreground shrink-0" />
        <span class="flex-1 text-left text-xs font-semibold">{{ t('widget.myFeedback') }}</span>
        <span v-if="unreadCount" class="text-[10px] font-bold text-primary">
          {{ t('widget.withUpdates', { count: unreadCount }) }}
        </span>
        <Icon name="lucide:chevron-right" size="14" class="text-muted-foreground shrink-0" />
      </button>

      <div ref="bodyEl" class="flex-1 overflow-y-auto px-3 py-4 space-y-3">
        <div v-for="(m, i) in messages" :key="i" class="flex" :class="m.role === 'user' ? 'justify-end' : 'justify-start'">
          <div class="max-w-[85%]">
            <div
              class="px-3.5 py-2.5 rounded-2xl text-xs leading-relaxed"
              :class="m.role === 'user'
                ? 'bg-primary text-primary-foreground rounded-br-sm'
                : 'bg-secondary rounded-bl-sm'"
            >
              <WidgetEmbedMessageText :text="m.text" />
            </div>
            <WidgetEmbedFeedbackCard
              v-if="m.post"
              :title="m.post.title"
              :board="m.post.board"
              :status="m.post.status"
              @open="protocol.navigateToFeedback(m.post!.slug)"
            />
          </div>
        </div>

        <div v-if="sending" class="flex justify-start">
          <div class="px-3.5 py-2.5 rounded-2xl rounded-bl-sm bg-secondary text-xs text-muted-foreground flex items-center gap-2">
            <Icon name="lucide:loader-2" size="12" class="animate-spin" />
            {{ t('widget.thinking') }}
          </div>
        </div>
      </div>

      <div class="p-3 border-t border-border shrink-0">
        <div class="flex items-end gap-2">
          <textarea
            v-model="draft"
            rows="1"
            :placeholder="t('widget.placeholder')"
            class="flex-1 max-h-28 px-3 py-2.5 rounded-xl border border-border bg-background text-xs resize-none focus:outline-none focus:border-primary transition-colors"
            @keydown.enter.exact.prevent="send"
          />
          <button
            :disabled="!draft.trim() || sending"
            class="w-9 h-9 rounded-xl bg-primary text-primary-foreground flex items-center justify-center hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all shrink-0"
            :aria-label="t('widget.send')"
            @click="send"
          >
            <Icon name="lucide:arrow-up" size="15" />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

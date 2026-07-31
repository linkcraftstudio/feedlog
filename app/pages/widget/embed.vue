<script setup lang="ts">
import { resolveAttachmentUrl } from '~/utils/attachment'
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

const org = ref<{ name: string; logo: string | null }>({ name: '', logo: null })
const orgInitial = computed(() => org.value.name.trim().charAt(0).toUpperCase() || 'F')
// Mirrors the prompt's own fallback, so greeting and model name an unnamed
// workspace the same way.
const productName = computed(() => org.value.name || t('widget.thisProduct'))

// A plain link, not a `navigate` message: the SDK's handler only builds post
// URLs, so the board root has no route through it. The visitor arrives signed in
// once they have opened any post, which is what mints the cookie on this host.
const boardUrl = computed(() => (import.meta.client ? window.location.origin : '/'))

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
  images?: string[]
  post?: { id: string; slug: string; title: string; board: string | null; status: string }
}

const view = ref<'chat' | 'list'>('chat')
const messages = ref<ChatMessage[]>([])
const draft = ref('')
const sending = ref(false)
const bodyEl = ref<HTMLElement | null>(null)
const draftEl = ref<HTMLTextAreaElement | null>(null)

// rows="1" is the resting height and nothing else grows the box, so it is
// measured against its own content on every change. Resetting to auto first is
// what makes it shrink again: scrollHeight otherwise keeps reporting the taller
// box it already is. max-h-28 caps the growth and hands over to the scrollbar.
watch(draft, () => {
  const el = draftEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}, { flush: 'post' })

// ---- attachments ---------------------------------------------------------
// Uploaded up front rather than on send: the storage key is what the message
// endpoint wants, and uploading early lets a failure surface while the visitor
// is still composing.
// Mirrors `ensure.maxSize` in server/api/upload.post.ts.
const MAX_UPLOAD_MB = 10
interface Attachment { key: string; name: string }
const attachments = ref<Attachment[]>([])
const pendingUploads = ref(0)
const uploading = computed(() => pendingUploads.value > 0)
const uploadError = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

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
  if (!files.length) return
  uploadError.value = ''
  pendingUploads.value++
  for (const file of files) {
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      uploadError.value = t('widget.uploadTooLarge', { size: MAX_UPLOAD_MB })
      continue
    }
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await widgetFetch<{ key: string }>('/api/upload', { method: 'POST', body: form })
      attachments.value.push({ key: res.key, name: file.name })
    }
    catch (err) {
      // Same 401 contract as send(): park before the SDK rebuilds the frame.
      if ((err as { statusCode?: number })?.statusCode === 401) {
        parkForResume(draft.value, attachments.value, messages.value)
        status.value = 'anonymous'
        protocol.requestAuth('expired')
        break
      }
      uploadError.value = t('widget.uploadFailed')
    }
  }
  pendingUploads.value--
}

function scrollToBottom() {
  nextTick(() => { if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight })
}

// An expired session makes the SDK rebuild this frame, wiping everything held in
// memory. Parking in sessionStorage survives that rebuild — and only that: the
// archive is read once and dies with the tab, so a plain reload still starts
// clean rather than becoming the chat persistence the MVP skips.
const RESUME_KEY = 'feedlog:widget:resume'

function parkForResume(text: string, files: Attachment[], log: ChatMessage[]) {
  try {
    const owner = user.value?.email ?? ''
    sessionStorage.setItem(RESUME_KEY, JSON.stringify({ owner, text, files, log }))
  }
  catch { /* storage unavailable — the draft is lost, nothing else breaks */ }
}

function resumeParked(): boolean {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY)
    if (!raw) return false
    sessionStorage.removeItem(RESUME_KEY)
    const saved = JSON.parse(raw) as { owner?: string; text?: string; files?: Attachment[]; log?: ChatMessage[] }
    // A rebuild that never completed leaves the archive for whoever signs in
    // next on this tab; a half-sent message goes back only to its author.
    if (saved.owner !== user.value?.email) return false
    draft.value = saved.text ?? ''
    attachments.value = saved.files ?? []
    if (saved.log?.length) {
      messages.value = saved.log
      return true
    }
  }
  catch { /* ignore malformed leftovers */ }
  return false
}

async function send() {
  const text = draft.value.trim()
  const imageFiles = [...attachments.value]
  const images = imageFiles.map(a => a.key)
  if ((!text && !images.length) || sending.value || uploading.value) return
  messages.value.push({ role: 'user', text, images })
  draft.value = ''
  attachments.value = []
  uploadError.value = ''
  sending.value = true
  scrollToBottom()
  try {
    const res = await widgetFetch<{ type: string; reply: string; post?: ChatMessage['post'] }>(
      '/api/widget/messages',
      { method: 'POST', body: JSON.stringify({ text, images }) },
    )
    messages.value.push({ role: 'assistant', text: res.reply, post: res.post })
    // A new post belongs in the list the moment it exists.
    if (res.post) void loadFeedback()
  }
  catch (e) {
    // 401 means the SDK must re-exchange; anything else is a plain failure.
    if ((e as { statusCode?: number })?.statusCode === 401) {
      // Park before signalling — the SDK rebuilds this frame in response, so
      // anything written after requestAuth() is lost. The bubble goes first: it
      // never reached the server, and replaying it would claim otherwise.
      messages.value.pop()
      parkForResume(text, imageFiles, messages.value)
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
const PAGE_SIZE = 20
const feedback = ref<WidgetFeedbackItem[]>([])
const listLoading = ref(false)
const nextCursor = ref<string | null>(null)
const totalCount = ref(0)

const timeAgo = useTimeAgo()
const formatDate = useFormatDate()
function postedAt(d: string | Date): string {
  return Date.now() - new Date(d).getTime() < 86400000 ? timeAgo(d) : formatDate(d)
}

// Counted by the server, not by the loaded rows: a reply lands on a post of any
// age while the list runs newest-first, so an unread item can sit past the page
// this frame has fetched.
const unreadCount = ref(0)

// The SDK owns the badge; it only learns of changes from here.
watch(unreadCount, c => protocol.reportUnread(c))

async function loadUnread() {
  try {
    const res = await widgetFetch<{ count: number }>('/api/widget/unread')
    unreadCount.value = res.count
  }
  catch { /* keep the last known count */ }
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

// Infinite scroll. The observer is rebuilt whenever the sentinel remounts: the
// list view is torn down every time the visitor goes back to the chat.
const listSentinel = ref<HTMLElement | null>(null)
let listObserver: IntersectionObserver | null = null

watch(listSentinel, (el) => {
  listObserver?.disconnect()
  listObserver = null
  if (!el) return
  listObserver = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting) && nextCursor.value && !listLoading.value) {
      void loadFeedback(true)
    }
  }, { root: bodyEl.value ?? null, rootMargin: '120px' })
  listObserver.observe(el)
}, { flush: 'post' })

// Opening an item clears its dot and hands the SDK the slug — the detail page
// opens as a top-level tab, where cookies work and the full board is available.
async function openItem(item: WidgetFeedbackItem) {
  protocol.navigateToFeedback(item.slug)
  if (!item.unread) return
  try {
    const res = await widgetFetch<{ count: number }>(`/api/widget/feedback/${item.id}/read`, { method: 'POST' })
    item.unread = false
    unreadCount.value = res.count
  }
  catch { /* the dot stays; a later load will correct it */ }
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
    org: { name: string; logo: string | null }
    branding: { primary: string; primaryForeground: string }
  }>('/api/widget/config')
    .then((cfg) => {
      applyBrand(cfg.branding)
      org.value = cfg.org
    })
    .catch(() => {})

  const [authed] = await Promise.all([loadSession(), config])
  if (authed) {
    if (!resumeParked()) {
      messages.value.push({ role: 'assistant', text: t('widget.greeting', { product: productName.value }) })
    }
    await Promise.all([loadFeedback(), loadUnread()])
    document.addEventListener('visibilitychange', refreshOnVisible)
  }

  // ready last, so the SDK drops its loading state only once this frame has
  // settled into one of its states.
  protocol.ready()
})

onUnmounted(() => {
  document.removeEventListener('visibilitychange', refreshOnVisible)
  listObserver?.disconnect()
})
</script>

<template>
  <div class="h-screen flex flex-col bg-background text-foreground">
    <!-- Header -->
    <header class="px-4 py-3 border-b border-border flex items-center gap-3 shrink-0">
      <button
        v-if="view === 'list'"
        class="w-7 h-7 rounded-md hover:bg-secondary transition-colors flex items-center justify-center text-muted-foreground"
        :aria-label="t('widget.back')"
        @click="view = 'chat'"
      >
        <Icon name="lucide:arrow-left" size="16" />
      </button>
      <img
        v-if="view === 'chat' && org.logo"
        :src="resolveAttachmentUrl(org.logo)!"
        alt=""
        class="w-8 h-8 rounded-lg object-cover shrink-0"
      >
      <span
        v-else-if="view === 'chat'"
        class="w-8 h-8 rounded-lg shrink-0 grid place-items-center bg-primary text-primary-foreground font-heading font-bold text-sm"
      >{{ orgInitial }}</span>
      <div class="flex-1 min-w-0">
        <p class="font-heading font-bold text-sm truncate">
          {{ view === 'list' ? t('widget.myFeedback') : t('widget.title') }}
        </p>
        <p v-if="view === 'list' && totalCount" class="text-[11px] text-muted-foreground truncate">
          {{ t('widget.postCount', { count: totalCount }, totalCount) }}<template v-if="unreadCount"> · {{ t('widget.withUpdates', { count: unreadCount }) }}</template>
        </p>
        <p v-else-if="view === 'chat' && org.name" class="text-[11px] text-muted-foreground leading-snug line-clamp-2">
          {{ t('widget.subtitle', { product: org.name }) }}
        </p>
      </div>
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
      <ul v-else class="p-3 space-y-2">
        <li v-for="item in feedback" :key="item.id">
          <button
            class="w-full text-left p-3 rounded-xl border border-border bg-card hover:border-primary/40 transition-colors group"
            @click="openItem(item)"
          >
            <div class="flex items-start gap-2">
              <p class="flex-1 text-xs font-semibold leading-snug">
                {{ item.title }}
                <span v-if="item.unread" class="inline-block align-middle ml-1 w-1.5 h-1.5 rounded-full bg-red-500" />
              </p>
              <WidgetEmbedStatusBadge :status="item.status" class="shrink-0" />
            </div>
            <div class="mt-1.5 text-[10px] text-muted-foreground flex items-center gap-0.5">
              <Icon name="lucide:chevron-up" size="11" />{{ item.voteCount }}
              <span class="mx-1">·</span>{{ postedAt(item.createdAt) }}
            </div>
            <div class="mt-2 flex justify-end">
              <span class="text-[10px] font-semibold text-primary flex items-center gap-0.5">
                {{ t('widget.viewOnBoard') }}<Icon name="lucide:arrow-up-right" size="11" />
              </span>
            </div>
          </button>
        </li>
        <li
          v-if="nextCursor"
          ref="listSentinel"
          class="py-3 grid place-items-center"
          :aria-label="t('widget.loading')"
        >
          <Icon v-if="listLoading" name="lucide:loader-2" size="14" class="animate-spin text-muted-foreground" />
        </li>
      </ul>
    </div>

    <!-- Chat -->
    <template v-else>
      <!-- With nothing filed there is nothing to link to, so the whole bar
           becomes the invitation to go read what others asked for. -->
      <div class="mx-3 mt-3 rounded-xl border border-border bg-card flex items-stretch shrink-0 overflow-hidden">
        <button
          v-if="totalCount"
          class="flex-1 min-w-0 px-3 py-2.5 hover:bg-secondary/50 transition-colors flex items-center gap-2"
          @click="view = 'list'; loadFeedback()"
        >
          <Icon name="lucide:inbox" size="14" class="text-muted-foreground shrink-0" />
          <span class="text-xs font-semibold truncate">{{ t('widget.myFeedback') }}</span>
          <span class="text-[11px] text-muted-foreground shrink-0">({{ totalCount }})</span>
          <span v-if="unreadCount" class="text-[11px] font-semibold text-primary shrink-0 truncate">
            · {{ t('widget.withUpdates', { count: unreadCount }) }}
          </span>
        </button>
        <a
          :href="boardUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="px-3 py-2.5 hover:bg-secondary/50 transition-colors flex items-center gap-1.5 text-muted-foreground"
          :class="totalCount ? 'border-l border-border shrink-0' : 'flex-1'"
        >
          <Icon name="lucide:globe" size="14" class="shrink-0" />
          <span class="text-xs truncate">{{ totalCount ? t('widget.allFeedback') : t('widget.seeOthers') }}</span>
          <Icon name="lucide:arrow-up-right" size="12" class="shrink-0" />
        </a>
      </div>

      <div ref="bodyEl" class="flex-1 overflow-y-auto px-3 py-4 space-y-3">
        <div v-for="(m, i) in messages" :key="i" class="flex" :class="m.role === 'user' ? 'justify-end' : 'justify-start'">
          <div class="max-w-[85%]">
            <div
              class="px-3.5 py-2.5 rounded-2xl text-xs leading-relaxed"
              :class="m.role === 'user'
                ? 'bg-primary text-primary-foreground rounded-br-sm'
                : 'bg-secondary rounded-bl-sm'"
            >
              <WidgetEmbedMessageText v-if="m.text" :text="m.text" />
              <div v-if="m.images?.length" class="flex flex-wrap gap-1.5" :class="m.text ? 'mt-2' : ''">
                <img
                  v-for="k in m.images"
                  :key="k"
                  :src="resolveAttachmentUrl(k)!"
                  alt=""
                  class="w-16 h-16 rounded-lg object-cover border border-black/10"
                >
              </div>
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
            <span class="flex items-center gap-1" aria-hidden="true">
              <span v-for="n in 3" :key="n" class="w-1 h-1 rounded-full bg-current opacity-40 typing-dot" :style="{ animationDelay: `${(n - 1) * 0.16}s` }" />
            </span>
            {{ t('widget.thinking') }}
          </div>
        </div>
      </div>

      <div class="p-3 border-t border-border shrink-0">
        <p v-if="uploadError" class="mb-2 flex items-start gap-1.5 text-[11px] text-destructive">
          <Icon name="lucide:alert-circle" size="13" class="shrink-0 mt-px" />
          <span class="flex-1">{{ uploadError }}</span>
          <button
            class="shrink-0 hover:opacity-70 transition-opacity"
            :aria-label="t('widget.close')"
            @click="uploadError = ''"
          >
            <Icon name="lucide:x" size="12" />
          </button>
        </p>

        <!-- Staged attachments: already uploaded, waiting to ride along with the message. -->
        <div v-if="attachments.length || uploading" class="flex flex-wrap gap-1.5 mb-2">
          <div
            v-for="(a, i) in attachments"
            :key="a.key"
            class="relative w-12 h-12 rounded-lg overflow-hidden border border-border group"
          >
            <img :src="resolveAttachmentUrl(a.key)!" :alt="a.name" class="w-full h-full object-cover">
            <button
              class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white"
              :aria-label="t('widget.cancel')"
              @click="attachments.splice(i, 1)"
            >
              <Icon name="lucide:x" size="14" />
            </button>
          </div>
          <div v-if="uploading" class="w-12 h-12 rounded-lg border border-border grid place-items-center">
            <Icon name="lucide:loader-2" size="14" class="animate-spin text-muted-foreground" />
          </div>
        </div>

        <!-- Controls sit on their own row so the textarea can grow into the card
             instead of stretching the buttons beside it. -->
        <div class="rounded-xl border border-border bg-background focus-within:border-primary transition-colors">
          <input
            ref="fileInput"
            type="file"
            accept="image/*"
            multiple
            class="hidden"
            @change="onFilePicked"
          >
          <textarea
            ref="draftEl"
            v-model="draft"
            rows="1"
            :placeholder="t('widget.placeholder')"
            class="w-full max-h-28 px-3 pt-2.5 bg-transparent text-xs resize-none focus:outline-none no-scrollbar"
            @keydown.enter.exact.prevent="send"
            @paste="onPaste"
          />
          <div class="flex items-center justify-between px-2 pb-2 pt-1">
            <button
              :disabled="uploading || sending"
              class="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              :aria-label="t('widget.attachImage')"
              @click="fileInput?.click()"
            >
              <Icon name="lucide:image" size="15" />
            </button>
            <button
              :disabled="(!draft.trim() && !attachments.length) || sending || uploading"
              class="px-4 h-7 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              @click="send"
            >
              {{ t('widget.send') }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <p v-if="status !== 'loading'" class="py-1.5 text-center text-[10px] text-muted-foreground shrink-0">
      {{ t('board.poweredBy') }}FeedLog
    </p>
  </div>
</template>

<style scoped>
/* The composer scrolls past max-h-28, but a scrollbar inside a 400px panel is
   more noise than affordance. */
.no-scrollbar {
  scrollbar-width: none;
}

.no-scrollbar::-webkit-scrollbar {
  display: none;
}

.typing-dot {
  animation: typing 1.2s ease-in-out infinite;
}

@keyframes typing {
  0%, 60%, 100% { opacity: 0.25; }
  30% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .typing-dot {
    animation: none;
  }
}
</style>

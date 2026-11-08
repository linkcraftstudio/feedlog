<script setup lang="ts">
import { GUEST_TOKEN_STORAGE_KEY } from '#layers/feedlog/shared/utils/guest'
import type { WidgetConversationItem } from '#layers/feedlog/server/api/widget/conversations/index.get'
import { widgetResumeSchema } from '#layers/feedlog/app/composables/useWidgetResume'
import { emitOnboardingEvent } from '#layers/feedlog/app/composables/useOnboarding'

// Demo Widget inside the dashboard. The panel is the production widget page
// (/widget/embed) in an iframe, so customers and the demo see the same thing; it
// is not loaded through the SDK because the SDK is a page-wide singleton with
// no destroy, positions its own panel and never tells the host it closed.
//
// The frame around it has two jobs: say this is what customers see on the user's
// own site, and lead to installation. The backdrop blurs the dashboard so the
// widget reads as popping up on that site, not as part of FeedLog.
const { state, exitDemo, goInstall } = useOnboarding()
const { locale } = useI18n()
const localePath = useLocalePath()

const frame = ref<HTMLIFrameElement | null>(null)
const src = ref('')
// Set by the frame's `ready`; until then the panel shows a spinner over it.
const frameReady = ref(false)
// The conversation the widget is showing, once the AI has answered it or handed
// it to the team: the Inbox row links there and follows the user between chats.
const landedId = ref<string | null>(null)
// Any chat has been answered in this demo; the install link stays prominent after.
const answered = ref(false)

const currentTheme = () => document.documentElement.classList.contains('dark') ? 'dark' : 'light'

function embedUrl() {
  const url = new URL('/widget/embed', window.location.origin)
  url.searchParams.set('theme', currentTheme())
  url.searchParams.set('locale', locale.value)
  url.searchParams.set('origin', window.location.origin)
  return url.toString()
}

// Unread count reported by the frame, shown on the launcher while the panel is
// collapsed: a team reply lighting it up is the clearest sign the two sides connect.
const unread = ref(0)

// Minimal host side of the widget protocol: answer `ready` with `init`, collapse
// on `close-request`, mirror `unread`, open feedback links in a new tab. Page
// context is not offered, so the agent never sees dashboard paths.
function onMessage(event: MessageEvent) {
  if (event.origin !== window.location.origin || event.source !== frame.value?.contentWindow) return
  const data = event.data as { v?: number, type?: string, payload?: { to?: string, slug?: string, count?: number } } | null
  if (data?.v !== 1) return
  if (data.type === 'ready') {
    event.source?.postMessage({ v: 1, type: 'init', payload: { capabilities: {} } }, { targetOrigin: event.origin })
    frameReady.value = true
    syncDisplay()
  }
  else if (data.type === 'close-request') {
    collapse()
  }
  else if (data.type === 'unread') {
    const count = Number(data.payload?.count)
    unread.value = Number.isFinite(count) && count > 0 ? count : 0
  }
  else if (data.type === 'navigate' && data.payload?.to === 'feedback' && typeof data.payload.slug === 'string') {
    window.open(localePath(`/p/${encodeURIComponent(data.payload.slug)}`), '_blank', 'noopener,noreferrer')
  }
}

// Which chat the widget shows comes from the resume-state exchange the SDK uses
// to carry the panel across page loads; whether it was answered comes from the
// demo guest's own conversations. Same origin as the frame: the guest token the
// frame stored is readable here and is sent as a bearer, never with the owner's
// cookies.
let stateRequest = 0
function shownConversation(): Promise<string | null> {
  const target = frame.value?.contentWindow
  if (!target || !frameReady.value) return Promise.resolve(null)
  const requestId = `onboarding-demo-${++stateRequest}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(null), 1000)
    function done(id: string | null) {
      clearTimeout(timer)
      window.removeEventListener('message', receive)
      resolve(id)
    }
    function receive(event: MessageEvent) {
      const data = event.data as { v?: number, type?: string, payload?: { requestId?: string, state?: unknown } } | null
      if (event.source !== target || data?.v !== 1 || data.type !== 'resume-state' || data.payload?.requestId !== requestId) return
      const parsed = widgetResumeSchema.safeParse(data.payload.state)
      // A new chat has no id until its first message is sent.
      done(parsed.success && parsed.data.view === 'chat' ? parsed.data.chat?.conversationId ?? parsed.data.conversationId : null)
    }
    window.addEventListener('message', receive)
    target.postMessage({ v: 1, type: 'resume-state-request', payload: { requestId } }, window.location.origin)
  })
}

async function guestConversations(): Promise<WidgetConversationItem[] | null> {
  const token = localStorage.getItem(GUEST_TOKEN_STORAGE_KEY)
  if (!token) return []
  const result = await $fetch<{ data: WidgetConversationItem[] }>('/api/widget/conversations', {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'omit',
  }).catch(() => null)
  return result?.data ?? null
}

let poller: ReturnType<typeof setInterval> | undefined
let checking = false
async function checkLanded() {
  if (checking || document.hidden || !state.value.demoPanelOpen) return
  checking = true
  try {
    const id = await shownConversation()
    if (!id) {
      landedId.value = null
      return
    }
    const rows = await guestConversations()
    // A failed request keeps the row as it is.
    if (!rows) return
    const row = rows.find(item => item.id === id)
    // The customer's message is one item; a reply or a handoff notice is the next.
    const hit = !!row && (row.lastSeq >= 2 || row.handling !== 'ai')
    landedId.value = hit ? id : null
    if (hit && !answered.value) {
      answered.value = true
      // Once per demo: the user chatted and saw it answered or handed over.
      emitOnboardingEvent('demo_replied')
    }
  }
  finally {
    checking = false
  }
}
function startWatching() {
  stopWatching()
  void checkLanded()
  poller = setInterval(checkLanded, 3000)
}
function stopWatching() {
  clearInterval(poller)
  poller = undefined
}

// The frame is loaded once per page visit and never torn down, as the SDK does:
// a preloaded frame turns the first opening into a display flip. The theme and
// locale it was loaded with may be stale by the time it is shown, so they are
// pushed again on every opening.
function load() {
  if (src.value) return
  frameReady.value = false
  src.value = embedUrl()
}
function syncDisplay() {
  if (!frameReady.value) return
  const target = frame.value?.contentWindow
  target?.postMessage({ v: 1, type: 'set-theme', payload: { theme: currentTheme() } }, window.location.origin)
  target?.postMessage({ v: 1, type: 'set-locale', payload: { locale: locale.value } }, window.location.origin)
}

let idle: number | undefined
// Same timing as the SDK prewarm: wait for an idle moment, but no longer than 3s.
watch(() => state.value.demoWarm, (warm) => {
  if (!warm || src.value || idle !== undefined) return
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return
  idle = typeof requestIdleCallback === 'function'
    ? requestIdleCallback(load, { timeout: 3000 })
    : window.setTimeout(load, 2500)
}, { immediate: true })

watch(() => state.value.demoOpen, (open) => {
  if (open) {
    load()
    syncDisplay()
    startWatching()
  }
  else {
    stopWatching()
    landedId.value = null
    answered.value = false
  }
}, { immediate: true })

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && state.value.demoOpen && state.value.demoPanelOpen) collapse()
}

onMounted(() => {
  window.addEventListener('message', onMessage)
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  window.removeEventListener('keydown', onKeydown)
  stopWatching()
  if (idle !== undefined) {
    if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idle)
    clearTimeout(idle)
  }
})

// Closing the widget only collapses it, as on a real site: trying the demo means
// going back and forth between the widget and the Inbox. The launcher stays for
// this page visit; its DEMO badge, the install link or a reload end the demo.
function collapse() { state.value.demoPanelOpen = false }
function expand() {
  state.value.demoPanelOpen = true
  void checkLanded()
}

async function viewInInbox() {
  if (!landedId.value) return
  // Leave the "customer's site" view so the Inbox is no longer blurred; after
  // replying as the team, the launcher brings the user back to see it arrive.
  collapse()
  state.value.highlightReply = landedId.value
  await navigateTo(localePath(`/dashboard/inbox?status=all&conversationId=${encodeURIComponent(landedId.value)}`))
}
</script>

<template>
  <!-- Mounted from the first preload on; while the demo is not open only the hidden
       panel with its loading frame exists. -->
  <template v-if="src || state.demoOpen">
    <Transition name="onboarding-fade">
      <div v-if="state.demoOpen && state.demoPanelOpen" class="fixed inset-0 z-30 bg-background/40 backdrop-blur-[6px]" data-onboarding-demo-backdrop @click="collapse" />
    </Transition>
    <div class="fixed bottom-6 right-6 z-40 flex flex-col items-end gap-4" :class="state.demoOpen ? '' : 'pointer-events-none'">
      <!-- v-show, not v-if: the iframe keeps its chat while the panel is collapsed. -->
      <Transition name="onboarding-pop">
        <div v-show="state.demoOpen && state.demoPanelOpen" data-onboarding-demo-widget>
          <!-- Label and install link share one quiet row above the widget. -->
          <div class="w-[400px] max-w-[calc(100vw-3rem)] rounded-[22px] bg-card/70 p-1.5 shadow-2xl ring-1 ring-foreground/[0.07] backdrop-blur-xl">
            <div class="flex items-center gap-2 px-2.5 pb-2 pt-1">
              <span class="rounded border border-foreground/15 px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wider text-foreground/60">{{ $t('onboarding.demo.badge') }}</span>
              <p class="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">{{ $t('onboarding.demo.caption') }}</p>
              <!-- Quiet until the user has seen an answer; then installing is the obvious next step. -->
              <button
                type="button"
                class="inline-flex h-6 shrink-0 items-center gap-1 rounded-md text-[11.5px] font-bold transition-colors"
                :class="answered ? 'bg-primary px-2.5 text-primary-foreground hover:bg-primary/90' : 'text-foreground hover:underline underline-offset-4'"
                data-fdl-action="onboarding_install"
                data-fdl-source="demo"
                data-onboarding-demo-install
                @click="goInstall()"
              >
                {{ $t('onboarding.demo.install') }}<Icon name="lucide:arrow-right" size="12" />
              </button>
            </div>
            <!-- The real panel is at most 680px tall; the frame adds its own 48px chrome, and
                 200px keeps room for the launcher, the "in your Inbox" row and a top margin. -->
            <div class="relative h-[min(640px,calc(100dvh-200px))] overflow-hidden rounded-2xl bg-background shadow-[0_1px_3px_rgb(0_0_0/0.08),0_0_0_0.5px_rgb(0_0_0/0.04)]">
              <iframe
                v-if="src"
                ref="frame"
                :src="src"
                :title="$t('onboarding.demo.frameTitle')"
                class="block size-full border-0"
                allow="clipboard-write"
              />
              <!-- Same loading state as the SDK panel. -->
              <div v-if="!frameReady" class="absolute inset-0 grid place-items-center bg-background" data-onboarding-demo-loading>
                <div class="size-7 animate-spin rounded-full border-[3px] border-border border-t-primary" role="status" :aria-label="$t('a11y.loading')" />
              </div>
            </div>
            <Transition name="onboarding-fade">
              <button v-if="landedId" type="button" class="mt-1 flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[11.5px] hover:bg-foreground/5" data-fdl-action="onboarding_demo_inbox" data-onboarding-demo-landed @click="viewInInbox">
                <Icon name="lucide:inbox" size="14" class="shrink-0 text-muted-foreground" />
                <span class="min-w-0 flex-1"><b class="font-semibold">{{ $t('onboarding.demo.landedTitle') }}</b> <span class="text-muted-foreground">{{ $t('onboarding.demo.landedBody') }}</span></span>
                <Icon name="lucide:arrow-right" size="13" class="shrink-0" />
              </button>
            </Transition>
          </div>
        </div>
      </Transition>

      <!-- Launcher. Stays while the demo is on; its DEMO badge ends the demo. -->
      <div v-if="state.demoOpen" class="relative">
        <button v-if="!state.demoPanelOpen" type="button" class="absolute -top-2 -left-2 z-10 inline-flex items-center gap-0.5 rounded-md bg-foreground py-0.5 pl-1.5 pr-1 text-[9px] font-bold uppercase tracking-wider text-background hover:opacity-90" :title="$t('onboarding.demo.end')" data-fdl-action="onboarding_demo_exit" data-onboarding-demo-exit @click="exitDemo()">
          {{ $t('onboarding.demo.badge') }}<Icon name="lucide:x" size="10" />
        </button>
        <button
          type="button"
          class="size-14 rounded-full bg-primary text-primary-foreground shadow-xl grid place-items-center hover:scale-105 transition-transform"
          :aria-label="state.demoPanelOpen ? $t('onboarding.demo.close') : $t('onboarding.demo.open')"
          data-onboarding-demo-launcher
          @click="state.demoPanelOpen ? collapse() : expand()"
        >
          <Icon :name="state.demoPanelOpen ? 'lucide:chevron-down' : 'lucide:square-pen'" size="26" />
        </button>
        <!-- Same badge as the SDK launcher. -->
        <span v-if="!state.demoPanelOpen && unread > 0" class="pointer-events-none absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-[#ef4444] px-[5px] text-[11px] font-bold leading-none text-white ring-2 ring-background" data-onboarding-demo-unread>{{ unread > 9 ? '9+' : unread }}</span>
      </div>
    </div>
  </template>
</template>

<style>
.onboarding-pop-enter-active, .onboarding-pop-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; transform-origin: bottom right; }
.onboarding-pop-enter-from, .onboarding-pop-leave-to { opacity: 0; transform: translateY(8px) scale(0.98); }
.onboarding-fade-enter-active, .onboarding-fade-leave-active { transition: opacity 0.2s; }
.onboarding-fade-enter-from, .onboarding-fade-leave-to { opacity: 0; }
</style>

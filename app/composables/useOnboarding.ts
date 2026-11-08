import { useInboxStatusCookie } from '#layers/feedlog/app/composables/useInboxStatus'

// New-workspace onboarding: the slide guide, the in-dashboard Demo Widget and the
// sidebar entry share one state so any of them can hand off to the others.
//
// Server state is only "should the guide open by itself for this user"
// (organization.metadata.onboarding.autoOpenFor). Everything else is per browser:
// the last viewed slide and the dismissed install card live in localStorage. That
// is per origin, so organizations served from one origin share these UI flags.

export const ONBOARDING_SLIDES = ['widget', 'inbox', 'feedback', 'start'] as const
export type OnboardingSlide = typeof ONBOARDING_SLIDES[number]
// The slide that carries "Try the demo" and the integration guide link.
export const ONBOARDING_DEMO_SLIDE: OnboardingSlide = 'start'

const SLIDE_KEY = 'feedlog:onboarding-slide'
const INSTALL_CARD_KEY = 'feedlog:onboarding-install-card-hidden'
// Neutral hook for analytics: the OSS layer never reports anything itself; a
// deployment that wants funnel numbers listens for this event. `action` is a
// snake_case name and every param is a string.
export const ONBOARDING_EVENT = 'feedlog:onboarding'
export type OnboardingGuideTrigger = 'auto' | 'entry'
export type OnboardingGuideCloseVia = 'dismiss' | 'try_demo' | 'install'

interface OnboardingState {
  loaded: boolean
  // The server asked this user to see the guide once; cleared on first close.
  autoOpen: boolean
  guideOpen: boolean
  slide: number
  guideClosedOnce: boolean
  // When the guide opened and the furthest slide reached since, so a close can say
  // how long it was read and whether the last slide was seen.
  guideOpenedAt: number
  furthestSlide: number
  entryHint: boolean
  installCardHidden: boolean
  // Onboarding has started in this page visit, so the Demo Widget frame loads in the
  // background and stays loaded; outside onboarding the dashboard never loads it.
  demoWarm: boolean
  demoOpen: boolean
  demoPanelOpen: boolean
  highlightInstall: boolean
  // The Demo Widget's chat just opened in the Inbox: point at its next step once.
  highlightReply: string | null
}

function readSavedSlide() {
  const n = Number(localStorage.getItem(SLIDE_KEY))
  return Number.isInteger(n) && n >= 0 && n < ONBOARDING_SLIDES.length ? n : 0
}

// Whether the guide opens by itself for this user, asked once per page load by the
// dashboard middleware, before the first dashboard page renders: on the server
// for a full load, on the client when the dashboard is entered by navigation.
export async function resolveOnboardingStatus() {
  // Composables first: the Nuxt context does not survive the await below.
  const status = useState<{ autoOpen: boolean } | null>('onboarding-status', () => null)
  if (status.value) return status.value
  const inboxStatus = useInboxStatusCookie()
  const result = await useRequestFetch()<{ autoOpen: boolean }>('/api/admin/onboarding').catch(() => null)
  status.value = { autoOpen: result?.autoOpen === true }
  // Onboarding starts the Inbox on every status: a new workspace has only a few
  // conversations, and the demo's chats are handled by the AI, not "open". Only
  // until the user picks a status; members who join later start on the default.
  if (status.value.autoOpen && !inboxStatus.value) inboxStatus.value = 'all'
  return status.value
}

export function emitOnboardingEvent(action: string, params: Record<string, string> = {}) {
  window.dispatchEvent(new CustomEvent(ONBOARDING_EVENT, { detail: { action, params } }))
}

export function useOnboarding() {
  const state = useState<OnboardingState>('onboarding', () => ({
    loaded: false,
    autoOpen: false,
    guideOpen: false,
    slide: 0,
    guideClosedOnce: false,
    guideOpenedAt: 0,
    furthestSlide: 0,
    entryHint: false,
    installCardHidden: false,
    demoWarm: false,
    demoOpen: false,
    demoPanelOpen: false,
    highlightInstall: false,
    highlightReply: null,
  }))
  const localePath = useLocalePath()
  let hintTimer: ReturnType<typeof setTimeout> | undefined

  // Called once by the dashboard layout on the client, with the server's answer to
  // "open the guide for this user"; false when it could not be asked.
  function load(autoOpen: boolean) {
    if (state.value.loaded) return
    state.value.loaded = true
    state.value.installCardHidden = localStorage.getItem(INSTALL_CARD_KEY) === '1'
    if (autoOpen) {
      state.value.autoOpen = true
      // The first, automatic opening always starts from the beginning.
      openGuide(0, 'auto')
    }
  }

  // Without an explicit slide (the sidebar entry), resume where the user left off.
  function openGuide(slide?: number, trigger: OnboardingGuideTrigger = 'entry') {
    state.value.slide = slide ?? readSavedSlide()
    state.value.guideOpen = true
    state.value.demoWarm = true
    state.value.entryHint = false
    state.value.guideOpenedAt = Date.now()
    state.value.furthestSlide = state.value.slide
    const key = ONBOARDING_SLIDES[state.value.slide]!
    emitOnboardingEvent('shown', { slide: key, trigger })
    emitOnboardingEvent('slide_viewed', { slide: key })
  }

  function setSlide(slide: number) {
    const next = Math.min(Math.max(slide, 0), ONBOARDING_SLIDES.length - 1)
    if (next === state.value.slide) return
    state.value.slide = next
    state.value.furthestSlide = Math.max(state.value.furthestSlide, next)
    localStorage.setItem(SLIDE_KEY, String(next))
    emitOnboardingEvent('slide_viewed', { slide: ONBOARDING_SLIDES[next]! })
  }

  function closeGuide(via: OnboardingGuideCloseVia = 'dismiss') {
    if (!state.value.guideOpen) return
    state.value.guideOpen = false
    emitOnboardingEvent('closed', {
      slide: ONBOARDING_SLIDES[state.value.slide]!,
      furthest_slide: ONBOARDING_SLIDES[state.value.furthestSlide]!,
      close_via: via,
      duration_sec: String(Math.max(0, Math.round((Date.now() - state.value.guideOpenedAt) / 1000))),
    })
    if (state.value.autoOpen) {
      state.value.autoOpen = false
      void $fetch('/api/admin/onboarding/dismiss', { method: 'POST' }).catch(() => {})
    }
    if (state.value.guideClosedOnce) return
    // First close only: point at the sidebar entry the guide now lives in.
    state.value.guideClosedOnce = true
    state.value.entryHint = true
    clearTimeout(hintTimer)
    hintTimer = setTimeout(() => { state.value.entryHint = false }, 6000)
  }

  function tryDemo() {
    closeGuide('try_demo')
    state.value.demoWarm = true
    state.value.demoOpen = true
    state.value.demoPanelOpen = true
  }

  function warmDemo() {
    state.value.demoWarm = true
  }

  // Ends the demo: the launcher goes too. Closing the panel only collapses it. The
  // frame itself stays loaded so the next opening is instant.
  function exitDemo() {
    state.value.demoPanelOpen = false
    state.value.demoOpen = false
  }

  async function goInstall() {
    closeGuide('install')
    exitDemo()
    state.value.highlightInstall = true
    await navigateTo(localePath('/dashboard/settings/widget'))
  }

  function hideInstallCard() {
    localStorage.setItem(INSTALL_CARD_KEY, '1')
    state.value.installCardHidden = true
  }


  return { state, load, openGuide, warmDemo, setSlide, closeGuide, tryDemo, exitDemo, goInstall, hideInstallCard }
}

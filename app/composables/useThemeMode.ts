export type ThemePref = 'system' | 'light' | 'dark'

const ONE_YEAR = 60 * 60 * 24 * 365

// Attach the OS-preference listener once per client bundle — useThemeMode is
// called from many components but we only need a single matchMedia subscription
// feeding the shared `fl-system-dark` state.
let systemListenerAttached = false

// One light/dark preference for the whole app. Portal and dashboard share it:
// the two surfaces are only ever seen together by the same person in the same
// browser, so a single stored choice is what a user expects. (Cookies are
// per-browser, so different people's preferences are already isolated — there is
// nothing to "separate" between a portal visitor and a dashboard admin.) When
// the user hasn't chosen anything, BOTH surfaces fall back to the org's
// configured defaultTheme. useState backs the reactive in-session truth; the
// cookie persists across sessions and seeds SSR (no flash for light/dark).
export function useThemeMode() {
  const route = useRoute()
  const portal = usePortalOrg()

  const isDashboard = computed(() => route.path.startsWith('/dashboard'))
  const isPortalSurface = computed(() =>
    !route.path.startsWith('/dashboard')
    && !route.path.startsWith('/proto')
    && !route.path.startsWith('/auth'))
  const themed = computed(() => isDashboard.value || isPortalSurface.value)

  const cookieOpts = { maxAge: ONE_YEAR, sameSite: 'lax' as const, path: '/' }
  const cookie = useCookie<ThemePref | null>('fl-theme', cookieOpts)
  const stored = useState<ThemePref | null>('fl-theme', () => cookie.value ?? null)

  // The switcher's current value. Unset → fall back to the org's configured
  // default theme on every surface; once the user chooses, it applies app-wide.
  const mode = computed<ThemePref>({
    get() {
      if (!themed.value) return 'light'
      return stored.value ?? portal.value.branding.defaultTheme
    },
    set(value) {
      stored.value = value
      cookie.value = value
    },
  })

  // Reactive OS preference, kept current by a single matchMedia listener. Seeded
  // false on SSR (corrected before paint by the no-FOUC inline script in app.vue);
  // on the client it updates live when the user flips their system theme.
  const systemDark = useState<boolean>('fl-system-dark', () => false)
  if (import.meta.client && !systemListenerAttached) {
    systemListenerAttached = true
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    systemDark.value = mq.matches
    mq.addEventListener('change', (e) => { systemDark.value = e.matches })
  }

  // Resolve a preference to an actual dark/light boolean. 'system' needs the
  // client's media query, so it reports light during SSR and is corrected by the
  // no-FOUC inline script + the client watchEffect in app.vue.
  function isDark(pref: ThemePref): boolean {
    if (pref === 'dark') return true
    if (pref === 'light') return false
    return import.meta.client && window.matchMedia('(prefers-color-scheme: dark)').matches
  }

  // Reactive resolved dark state for the active surface — drives the <html>.dark
  // toggle and any component that needs to mirror the theme (e.g. md-editor's own
  // `theme` prop). Unlike isDark(), this tracks live OS-preference changes.
  const resolvedDark = computed(() => {
    if (!themed.value) return false
    if (mode.value === 'dark') return true
    if (mode.value === 'light') return false
    return systemDark.value
  })

  return { mode, themed, isDashboard, isPortalSurface, isDark, resolvedDark }
}

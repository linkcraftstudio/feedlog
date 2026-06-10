// Theme ('light'/'dark') for md-editor surfaces, bound to the app's <html>.dark
// contract but SSR-safe. md-editor stamps a `md-editor-dark` class from this prop,
// so the value must be identical at SSR and first client (hydration) render —
// otherwise Vue logs a class mismatch on every SSR'd preview (portal welcome /
// post / comment bodies).
//
// The live <html>.dark can differ between SSR and hydration: for `system` mode the
// no-FOUC inline script flips the class before hydration, and reading the DOM
// during setup would adopt that flipped value while the server rendered the
// unflipped one. So until mounted we derive from `mode` — which is hydration-stable
// (cookie-seeded useState + the SSR-resolved org default) and mirrors the same
// rule app.vue uses for the server <html> class. After mount we adopt the live DOM
// state so the editor still tracks switcher changes and live OS-theme flips.
export function useEditorTheme() {
  const { mode } = useThemeMode()
  const documentDark = useDocumentDark()
  const mounted = ref(false)
  onMounted(() => { mounted.value = true })

  return computed(() =>
    (mounted.value ? documentDark.value : mode.value === 'dark') ? 'dark' : 'light')
}

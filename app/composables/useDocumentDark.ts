// Reactive mirror of the app's global dark contract: the `dark` class on
// <html>. Everything theme-aware already keys off this class (Tailwind's `dark:`
// variant, the CSS design tokens, app.vue's toggle), so this exposes it as a ref
// for prop-driven third-party widgets (e.g. md-editor) that can't read the class
// themselves. It is a pure consumer — it never decides the theme, only reflects
// whatever the theme "producer" (useThemeMode + app.vue, incl. follow-OS) wrote.
//
// Singleton: one MutationObserver per client bundle, shared by every caller —
// not one per component instance. SSR has no DOM, so it reports false there and
// resolves on the client (md-editor is client-only anyway).
const isDark = ref(false)
let observing = false

export function useDocumentDark() {
  if (import.meta.client && !observing) {
    observing = true
    const el = document.documentElement
    isDark.value = el.classList.contains('dark')
    new MutationObserver(() => {
      isDark.value = el.classList.contains('dark')
    }).observe(el, { attributes: true, attributeFilter: ['class'] })
  }
  return readonly(isDark)
}

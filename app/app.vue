<script setup lang="ts">
import { Toaster } from 'vue-sonner'
import 'vue-sonner/style.css'
import { derivePortalThemeVars, styleObjectToCss } from '#layers/feedlog/shared/utils/branding'

// Site-wide share-card defaults; per-page title/description come from usePageOg.
// og:image must be absolute, so build it from the request origin.
const ogImage = `${useRequestURL().origin}/og.png`
const portal = usePortalOrg()
const { mode, themed, resolvedDark } = useThemeMode()
const brandCss = computed(() => {
  if (!themed.value) return ''
  const color = portal.value.branding.primaryColor
  // Both surfaces (portal + dashboard) get the same override: brand tokens plus a
  // neutralized pure-gray palette. Keeping one palette means the public portal and
  // the dashboard share identical backgrounds/cards/borders — no warm-vs-neutral
  // mismatch between them — and brand color shows only through primary/accent/etc.
  // Doubled selectors raise specificity above the base theme tokens (plain
  // `:root` / `.dark`) so the per-tenant override wins regardless of where this
  // injected <style> lands relative to the bundled stylesheet (in dev Vite
  // appends CSS after head, which would otherwise re-win on source order).
  return [
    `:root:root { ${styleObjectToCss(derivePortalThemeVars(color, false))} }`,
    `:root.dark { ${styleObjectToCss(derivePortalThemeVars(color, true))} }`,
  ].join('\n')
})
// `light`/`dark` resolve at SSR (no flash); `system` renders light here and is
// corrected before paint by the inline script below, then kept in sync client-side.
const themeClass = computed(() => themed.value && mode.value === 'dark' ? 'dark' : undefined)

if (import.meta.client) {
  watchEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedDark.value)
  })
}

useSeoMeta({
  ogSiteName: () => portal.value.name,
  ogImage,
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageType: 'image/png',
  twitterImage: ogImage,
  twitterCard: 'summary_large_image',
})

const localeHead = useLocaleHead()

// i18n emits hreflang/canonical/og:url as relative paths (empty for the
// unprefixed default locale) because i18n.baseUrl can't carry a per-request
// value under multi-tenant hosting. Search engines require absolute URLs, so
// resolve them against the request origin — same origin used for og:image.
const seoOrigin = useRequestURL().origin
const absoluteSeoUrl = (href?: string) => {
  try { return new URL(href || '/', seoOrigin).href }
  catch { return href }
}
const seoLink = computed(() =>
  (localeHead.value.link ?? []).map(l =>
    (l.rel === 'alternate' || l.rel === 'canonical') && typeof l.href === 'string'
      ? { ...l, href: absoluteSeoUrl(l.href) }
      : l))
const seoMeta = computed(() =>
  (localeHead.value.meta ?? []).map(m =>
    m.property === 'og:url' && typeof m.content === 'string'
      ? { ...m, content: absoluteSeoUrl(m.content) }
      : m))

useHead(() => ({
  htmlAttrs: {
    ...localeHead.value.htmlAttrs,
    class: themeClass.value,
  },
  // A configured org logo is the favicon on every surface (dashboard included),
  // so the tab mirrors the brand the admin just set. Override each keyed static
  // icon slot rather than appending — otherwise the browser keeps preferring the
  // bundled SVG. All slots point at the one logo so selection is deterministic.
  link: [
    ...seoLink.value,
    ...(portal.value.logo
      ? [
          { key: 'favicon-svg', rel: 'icon', href: portal.value.logo },
          { key: 'favicon-png', rel: 'icon', href: portal.value.logo },
          { key: 'favicon-ico', rel: 'shortcut icon', href: portal.value.logo },
          { key: 'favicon-apple', rel: 'apple-touch-icon', href: portal.value.logo },
        ]
      : []),
  ],
  meta: seoMeta.value,
  style: brandCss.value
    ? [{ key: 'portal-brand-vars', innerHTML: brandCss.value }]
    : [],
  script: themed.value && mode.value === 'system'
    ? [{
        key: 'portal-system-theme',
        innerHTML: "try{document.documentElement.classList.toggle('dark',window.matchMedia('(prefers-color-scheme: dark)').matches)}catch(e){}",
      }]
    : [],
}))
</script>

<template>
  <NuxtLoadingIndicator color="var(--primary)" :height="3" :throttle="200" />
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <ConfirmDialogProvider />
  <Toaster position="top-center" :duration="3000" rich-colors close-button />
</template>

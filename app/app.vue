<script setup lang="ts">
import { Toaster } from 'vue-sonner'
import 'vue-sonner/style.css'

// Site-wide share-card defaults; per-page title/description come from usePageOg.
// og:image must be absolute, so build it from the request origin.
const ogImage = `${useRequestURL().origin}/og.png`
const portal = usePortalOrg()
useSeoMeta({
  ogSiteName: () => portal.value.name,
  ogImage,
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageType: 'image/png',
  twitterImage: ogImage,
  twitterCard: 'summary_large_image',
})
</script>

<template>
  <NuxtLoadingIndicator color="var(--primary)" :height="3" :throttle="200" />
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <ConfirmDialogProvider />
  <Toaster position="top-center" :duration="3000" rich-colors close-button />
</template>

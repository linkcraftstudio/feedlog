<script setup lang="ts">
// This page is the OAuth popup callback target.
// It notifies the opener window and closes itself.

// No layout: this window lives for one paint and then closes, so the portal
// chrome has nothing to render here — and running it would double every
// sign-in side effect the chrome owns. The guest claim is the one that bit:
// the chrome claims for whatever account it loads with, and this window loads
// with the account that just signed in, so it claimed the token alongside the
// opener and then closed before it could clear it.
definePageMeta({ layout: false })

if (import.meta.client) {
  window.opener?.postMessage({ type: 'auth-callback' }, window.location.origin)
  window.close()
}
</script>

<template>
  <div class="flex min-h-[60vh] items-center justify-center">
    <p class="text-muted-foreground">{{ $t('auth.signingIn') }}</p>
  </div>
</template>

<script setup lang="ts">
// /sso/error — friendly interstitial shown when /api/sso/jwt fails (expired or
// invalid token, SSO not configured, etc.). The token comes from the customer's
// product, so the failure is the integrator's problem; we explain it gently,
// tell the visitor to contact their admin, and after a short countdown continue
// on to the board (logged out) — friendlier than a raw 400.
//
// `layout: false` keeps the public-board chrome off this standalone shell.
definePageMeta({ layout: false, middleware: [] })

const { t } = useI18n()
const localePath = useLocalePath()
useHead({ title: () => t('auth.sso.pageTitle') })

// Re-validate return_to client-side (the page is directly reachable): only a
// same-origin relative path, never protocol-relative (`//evil.com`).
const route = useRoute()
const rawReturn = route.query.return_to
const returnTo = typeof rawReturn === 'string' && rawReturn.startsWith('/') && !rawReturn.startsWith('//')
  ? rawReturn
  : '/'

const seconds = ref(3)
let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  timer = setInterval(() => {
    seconds.value -= 1
    if (seconds.value <= 0) {
      if (timer) clearInterval(timer)
      navigateTo(localePath(returnTo))
    }
  }, 1000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="min-h-screen bg-background font-body flex items-center justify-center px-6 py-12">
    <div class="w-full max-w-sm text-center">
      <div class="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center mx-auto mb-5">
        <Icon name="lucide:shield-alert" size="26" class="text-primary" />
      </div>

      <h1 class="font-heading text-2xl font-bold tracking-tight">{{ $t('auth.sso.title') }}</h1>
      <p class="mt-3 text-sm text-muted-foreground leading-relaxed">
        {{ $t('auth.sso.body') }}
      </p>

      <p class="mt-6 text-xs text-muted-foreground">
        {{ $t('auth.sso.continuingIn', { seconds }) }}
      </p>
      <NuxtLink
        :to="localePath(returnTo)"
        class="mt-3 inline-flex h-9 px-4 rounded-lg border border-border bg-card text-xs font-semibold hover:bg-secondary transition-colors items-center gap-1.5"
      >
        {{ $t('auth.sso.continueNow') }}
        <Icon name="lucide:arrow-right" size="13" />
      </NuxtLink>
    </div>
  </div>
</template>

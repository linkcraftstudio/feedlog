<script setup lang="ts">
definePageMeta({ layout: 'dashboard', middleware: 'admin' })

const { data: session } = useAuthSession()
const { open: openLogin } = useLoginModal()
const portal = usePortalOrg()
const route = useRoute()
const isSsoSession = computed(() => !!(session.value as { session?: { ssoOrgId?: string | null } } | null)?.session?.ssoOrgId)
const hasPassword = ref<boolean | null>(null)
const { t } = useI18n()

function revealAccountCard() {
  if (!['#edit-profile', '#change-password'].includes(route.hash)) return
  const card = document.getElementById(route.hash.slice(1))
  card?.scrollIntoView({ block: 'start' })
  card?.focus({ preventScroll: true })
}

onMounted(revealAccountCard)
watch(() => route.hash, revealAccountCard, { flush: 'post' })
useHead({ title: () => t('settings.personal.profile') })
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="dashboard-panel-page-header">
      <div>
        <h2 class="font-heading text-lg font-bold">{{ $t('settings.personal.profile') }}</h2>
        <p class="text-xs text-muted-foreground">{{ $t('settings.personal.profileDesc') }}</p>
      </div>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="dashboard-panel-container dashboard-panel-stack">
      <section id="edit-profile" class="dashboard-panel overflow-hidden" tabindex="-1" aria-labelledby="edit-profile-heading">
        <div class="dashboard-panel-header border-b border-border">
          <h3 id="edit-profile-heading" class="font-heading text-sm font-bold">{{ $t('auth.profile.title') }}</h3>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ $t('auth.profile.subtitle') }}</p>
        </div>
        <AccountProfileForm v-if="!isSsoSession" card />
        <div v-else class="dashboard-panel-body space-y-4">
          <p class="text-sm text-muted-foreground">{{ $t('auth.localAuthRequired', { org: portal.name }) }}</p>
          <Button variant="outline" @click="openLogin(LOCAL_AUTH_REASON)">{{ $t('common.signIn') }}</Button>
        </div>
      </section>

      <section id="change-password" class="dashboard-panel overflow-hidden" tabindex="-1" aria-labelledby="change-password-heading">
        <div class="dashboard-panel-header border-b border-border">
          <h3 id="change-password-heading" class="font-heading text-sm font-bold">
            {{ $t(hasPassword === false && !isSsoSession ? 'auth.changePassword.setTitle' : 'auth.changePassword.title') }}
          </h3>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {{ $t(hasPassword === false && !isSsoSession ? 'auth.changePassword.setSubtitle' : 'auth.changePassword.subtitle') }}
          </p>
        </div>
        <AccountPasswordForm v-if="!isSsoSession" v-model:has-password="hasPassword" card />
        <div v-else class="dashboard-panel-body space-y-4">
          <p class="text-sm text-muted-foreground">{{ $t('auth.localAuthRequired', { org: portal.name }) }}</p>
          <Button variant="outline" @click="openLogin(LOCAL_AUTH_REASON)">{{ $t('common.signIn') }}</Button>
        </div>
      </section>
      </div>
    </div>
  </div>
</template>

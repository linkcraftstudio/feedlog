<script setup lang="ts">
// Next-step card on top of the widget settings page: what to install, and the
// way back into the Demo Widget. Dismissed for good in this browser.
const { state, tryDemo, hideInstallCard, warmDemo } = useOnboarding()
const org = usePortalOrg()
// The card is part of onboarding: get the Demo Widget ready behind "Try Demo".
onMounted(() => { if (!state.value.installCardHidden) warmDemo() })
</script>

<template>
  <section v-if="!state.installCardHidden" class="relative rounded-xl border border-primary/30 bg-secondary/60 py-5 pl-6 pr-12 flex flex-wrap items-center gap-4" data-onboarding-install-card>
    <div class="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground"><Icon name="lucide:code-xml" size="20" /></div>
    <div class="min-w-0 flex-1">
      <p class="font-heading text-sm font-bold">{{ $t('onboarding.installCard.title', { name: org.name }) }}</p>
      <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">{{ $t('onboarding.installCard.body') }}</p>
    </div>
    <button type="button" class="h-8 px-3 rounded-md border border-border bg-card hover:bg-secondary transition-colors flex items-center gap-1.5 text-xs font-semibold" data-fdl-action="onboarding_try_demo" data-fdl-source="install_card" @click="tryDemo()">
      <Icon name="lucide:message-circle" size="14" />{{ $t('onboarding.installCard.tryDemo') }}
    </button>
    <button type="button" class="absolute right-3 top-3 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-card hover:text-foreground" :title="$t('onboarding.installCard.dismiss')" :aria-label="$t('onboarding.installCard.dismiss')" data-onboarding-install-card-dismiss @click="hideInstallCard()">
      <Icon name="lucide:x" size="14" />
    </button>
  </section>
</template>

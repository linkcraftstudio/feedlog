<script setup lang="ts">
// "Getting started" entry at the bottom of the dashboard navigation. It always
// stays, so a user who closed the guide too early can come back to it.
const props = defineProps<{ mobile?: boolean }>()
const { state, openGuide } = useOnboarding()
</script>

<template>
  <div v-if="props.mobile" class="px-4 pb-3">
    <button
      type="button"
      class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-muted-foreground hover:bg-background hover:text-foreground transition-colors font-semibold"
      data-onboarding-entry
      @click="openGuide()"
    >
      <Icon name="lucide:rocket" size="20" />
      <span class="text-sm">{{ $t('onboarding.entry.label') }}</span>
    </button>
  </div>

  <div v-else class="relative px-2 min-[1280px]:px-4 pb-3">
    <button
      type="button"
      class="w-full flex items-center gap-3 py-2 rounded-lg justify-center min-[1280px]:justify-start px-0 min-[1280px]:px-3 font-semibold transition-colors"
      :class="state.entryHint ? 'bg-secondary text-primary ring-2 ring-primary/30' : 'text-muted-foreground hover:bg-background hover:text-foreground'"
      :title="$t('onboarding.entry.label')"
      data-onboarding-entry
      @click="openGuide()"
    >
      <Icon name="lucide:rocket" size="20" class="shrink-0" />
      <span class="hidden min-[1280px]:inline text-sm">{{ $t('onboarding.entry.label') }}</span>
    </button>
    <Transition name="onboarding-fade">
      <div v-if="state.entryHint && !state.demoPanelOpen" class="absolute left-full bottom-3 ml-3 z-50 w-56 rounded-lg bg-foreground text-background px-3 py-2.5 text-xs leading-relaxed shadow-lg">
        <span class="absolute -left-1 bottom-4 size-2 rotate-45 bg-foreground" />
        {{ $t('onboarding.entry.hint') }}
      </div>
    </Transition>
  </div>
</template>

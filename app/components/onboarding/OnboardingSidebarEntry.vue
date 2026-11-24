<script setup lang="ts">
// "Getting started" entry at the bottom of the dashboard navigation. It always
// stays, so a user who closed the guide too early can come back to it.
const props = defineProps<{ mobile?: boolean; compact?: boolean }>()
const emit = defineEmits<{ open: [] }>()
const { state, openGuide } = useOnboarding()

function launchGuide() {
  openGuide()
  emit('open')
}
</script>

<template>
  <div v-if="props.mobile" class="px-4 pb-3">
    <button
      type="button"
      class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-muted-foreground hover:bg-background hover:text-foreground transition-colors font-semibold"
      data-onboarding-entry
      @click="launchGuide"
    >
      <Icon name="lucide:rocket" size="20" />
      <span class="text-sm">{{ $t('onboarding.entry.label') }}</span>
    </button>
  </div>

  <div v-else class="relative pb-1">
    <button
      type="button"
      class="w-full flex items-center gap-3 rounded-lg px-3 py-2 font-semibold transition-colors"
      :class="state.entryHint ? 'bg-secondary text-primary ring-2 ring-primary/30' : 'text-muted-foreground hover:bg-background hover:text-foreground'"
      :title="$t('onboarding.entry.label')"
      :aria-label="$t('onboarding.entry.label')"
      data-onboarding-entry
      @click="launchGuide"
    >
      <Icon name="lucide:rocket" size="20" class="shrink-0" />
      <span v-if="!props.compact" class="text-sm">{{ $t('onboarding.entry.label') }}</span>
    </button>
    <Transition name="onboarding-fade">
      <div v-if="state.entryHint && !state.demoPanelOpen" class="absolute left-full bottom-3 ml-3 z-50 w-56 rounded-lg bg-foreground text-background px-3 py-2.5 text-xs leading-relaxed shadow-lg">
        <span class="absolute -left-1 bottom-4 size-2 rotate-45 bg-foreground" />
        {{ $t('onboarding.entry.hint') }}
      </div>
    </Transition>
  </div>
</template>

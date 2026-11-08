<script setup lang="ts">
// Pause/play for a looping slide recording. Auto-playing motion that runs past
// five seconds needs a way to stop it (WCAG 2.2.2), and the small UI text in the
// recordings needs a way to hold a frame. Progress shows how far the loop is.
// Fixed light colours in both themes: the recordings are always light.
const props = defineProps<{ paused: boolean; progress: number }>()
defineEmits<{ toggle: [] }>()

const RADIUS = 11
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const label = computed(() => props.paused ? 'onboarding.guide.playMedia' : 'onboarding.guide.pauseMedia')
// While playing only the ring shows; the backing disc and the pause icon appear
// together on hover or keyboard focus. Paused always shows both: a still ring on
// its own would look stuck.
const reveal = computed(() => props.paused ? '' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100')
</script>

<template>
  <button
    type="button"
    class="group grid size-6 place-items-center rounded-full text-neutral-600 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    :aria-label="$t(label)"
    :title="$t(label)"
    data-onboarding-media-control
    @click="$emit('toggle')"
  >
    <span class="absolute inset-0 rounded-full bg-white/70 backdrop-blur-sm transition-opacity" :class="reveal" aria-hidden="true" />
    <!-- A light halo keeps the bare ring visible over the recording. -->
    <svg class="absolute size-6 -rotate-90 drop-shadow-[0_0_1px_rgb(255_255_255/0.9)]" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" :r="RADIUS" fill="none" stroke="currentColor" stroke-opacity="0.15" stroke-width="1.5" />
      <circle
        cx="12" cy="12" :r="RADIUS" fill="none" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.5" stroke-linecap="round"
        :stroke-dasharray="CIRCUMFERENCE" :stroke-dashoffset="CIRCUMFERENCE * (1 - props.progress)"
      />
    </svg>
    <Icon
      :name="props.paused ? 'lucide:play' : 'lucide:pause'" size="10" class="relative transition-opacity"
      :class="[props.paused && 'translate-x-px', reveal]"
    />
  </button>
</template>

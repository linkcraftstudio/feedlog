<script setup lang="ts">
defineProps<{ checked: boolean | 'mixed'; label: string; disabled?: boolean; selecting?: boolean; pending?: boolean }>()
const emit = defineEmits<{ change: [checked: boolean] }>()
</script>
<template>
  <button type="button" role="checkbox" :aria-checked="pending ? true : checked" :aria-busy="pending || undefined" :aria-label="label" :disabled="disabled" class="flex size-5 shrink-0 items-center justify-center rounded-[6px] border-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring" :class="checked || pending ? 'border-primary bg-primary text-primary-foreground' : ['border-border bg-card text-transparent', selecting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 max-sm:opacity-100']" @click="emit('change', !pending && checked !== true)"><Icon v-if="pending" name="lucide:loader-circle" size="13" class="motion-safe:animate-spin" /><Icon v-else-if="checked === true" name="lucide:check" size="13" /><span v-else-if="checked === 'mixed'" class="h-0.5 w-2.5 rounded-full bg-primary-foreground" /></button>
</template>

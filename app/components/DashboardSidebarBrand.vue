<script setup lang="ts">
defineProps<{ compact?: boolean }>()
const localePath = useLocalePath()
</script>

<template>
  <div :class="compact ? 'px-3' : 'px-5 py-3'">
    <NuxtLink :to="localePath('/dashboard')" class="flex items-center gap-3" aria-label="FeedLog">
      <AppLogo :size="40" />
      <span v-if="!compact" class="font-heading text-xl font-bold tracking-tight">FeedLog</span>
    </NuxtLink>
  </div>
</template>

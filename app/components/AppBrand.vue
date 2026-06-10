<!--
  Brand mark (logo + wordmark) rendered in the default layout header.
-->
<template>
  <NuxtLink to="/" class="flex items-center gap-2 md:gap-3 min-w-0">
    <img
      v-if="portal.logo"
      :src="portal.logo"
      :alt="portal.name"
      width="40"
      height="40"
      class="size-8 md:size-10 rounded-lg object-cover shrink-0"
    >
    <AppLogo v-else :size="32" class="md:size-10" />
    <span class="font-heading text-xl md:text-2xl font-bold tracking-tight truncate">{{ portal.name }}</span>
  </NuxtLink>
</template>

<script setup lang="ts">
const portal = usePortalOrg()
</script>

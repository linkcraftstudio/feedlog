<!--
  Brand mark (logo + wordmark) rendered in the default layout header.
-->
<template>
  <NuxtLink to="/" class="flex items-center gap-2 md:gap-3">
    <AppLogo :size="32" class="md:size-10" />
    <span class="font-heading text-xl md:text-2xl font-bold tracking-tight">FeedLog</span>
  </NuxtLink>
</template>

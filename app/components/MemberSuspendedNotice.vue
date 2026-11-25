<script setup lang="ts">
// Shown by the dashboard layout instead of a page a suspended member may not open. A deployment that suspends
// members for its own reasons (ClientOrgContext.suspendedReason) may override it with a component of the same name.
const localePath = useLocalePath()
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="flex-1 grid place-items-center px-6">
      <div class="max-w-md text-center flex flex-col items-center">
        <div class="w-10 h-10 rounded-full bg-muted flex items-center justify-center mb-3"><Icon name="lucide:user-x" size="18" class="text-muted-foreground" /></div>
        <h3 class="font-heading font-bold text-sm">{{ $t('dashboard.suspended.title') }}</h3>
        <p class="text-xs text-muted-foreground mt-0.5">{{ $t('dashboard.suspended.body') }}</p>
        <NuxtLink :to="localePath('/dashboard/members')" class="mt-4 h-9 px-4 rounded-lg border border-border bg-background text-xs font-semibold hover:bg-secondary transition-colors inline-flex items-center">{{ $t('dashboard.suspended.goMembers') }}</NuxtLink>
      </div>
    </div>
  </div>
</template>

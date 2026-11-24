<script setup lang="ts">
import type { DashboardNavItem } from '#layers/feedlog/app/composables/useDashboardNav'

defineProps<{
  item: DashboardNavItem
  selected?: boolean
  unread?: number
}>()
const localePath = useLocalePath()
const { canVisit, guardNavigation } = useDashboardAccess()
</script>

<template>
  <NuxtLink
    :to="localePath(item.to)"
    :aria-label="item.label"
    :aria-disabled="!canVisit(item.to)"
    :aria-current="selected ? 'page' : undefined"
    :title="item.label"
    class="dashboard-nav-link relative flex min-w-0 items-center gap-3 rounded-lg px-3 py-2 transition-colors"
    :class="selected ? 'bg-secondary font-bold text-primary' : 'font-semibold text-muted-foreground hover:bg-background hover:text-foreground'"
    @click.capture="guardNavigation($event, item.to)"
  >
    <Icon :name="item.icon" size="20" class="shrink-0" />
    <span class="dashboard-nav-label truncate text-sm">{{ item.label }}</span>
    <span
      v-if="unread"
      data-inbox-badge
      class="dashboard-nav-badge ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] leading-none text-primary-foreground"
      :aria-label="$t('inbox.unreadOpenCount', { count: unread })"
    >
      <span class="relative top-px tabular-nums">{{ unread > 99 ? '99+' : unread }}</span>
    </span>
  </NuxtLink>
</template>

<script setup lang="ts">
// Auto / Light / Dark switcher. Reads & writes the active surface's preference
// via useThemeMode (portal vs dashboard handled there).
const { mode } = useThemeMode()
const { t } = useI18n()

const options = computed(() => [
  { value: 'system' as const, label: t('common.theme.auto'), icon: 'lucide:monitor' },
  { value: 'light' as const, label: t('common.theme.light'), icon: 'lucide:sun' },
  { value: 'dark' as const, label: t('common.theme.dark'), icon: 'lucide:moon' },
])
const currentIcon = computed(() => options.value.find(o => o.value === mode.value)?.icon ?? 'lucide:monitor')
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        :aria-label="$t('common.theme.label')"
        class="w-9 h-9 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors focus:outline-none"
      >
        <Icon :name="currentIcon" size="18" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-36">
      <DropdownMenuItem
        v-for="o in options"
        :key="o.value"
        class="cursor-pointer"
        @click="mode = o.value"
      >
        <Icon :name="o.icon" size="16" class="mr-2" />
        <span class="flex-1">{{ o.label }}</span>
        <Icon v-if="mode === o.value" name="lucide:check" size="14" class="text-primary" />
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

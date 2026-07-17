<script setup lang="ts">
// Standalone language switcher (top-bar icon), sits next to ThemeSwitcher.
const { locale, locales, setLocale } = useI18n()
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        :aria-label="$t('a11y.language')"
        class="w-9 h-9 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors focus:outline-none"
      >
        <Icon name="lucide:globe" size="18" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-40">
      <DropdownMenuItem
        v-for="l in locales"
        :key="l.code"
        class="cursor-pointer"
        @click="setLocale(l.code)"
      >
        <span class="flex-1">{{ l.name ?? l.code }}</span>
        <Icon v-if="locale === l.code" name="lucide:check" size="14" class="text-primary" />
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

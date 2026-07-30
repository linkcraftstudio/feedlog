<script setup lang="ts">
// Reuses the main app's status CSS variables so a post looks the same inside the
// widget as it does on the board.
const props = defineProps<{ status: string }>()
const { t } = useI18n()

const key = computed(() => props.status.replace('_', '-'))
const label = computed(() => t(`status.${props.status}`))
</script>

<template>
  <span
    class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border"
    :style="{
      color: `var(--status-${key})`,
      background: `var(--status-${key}-bg)`,
      border: `1px solid var(--status-${key}-border)`,
    }"
  >{{ label }}</span>
</template>

<script setup lang="ts">
// The card the assistant returns after distilling a message into a post.
defineProps<{
  title: string
  board: string | null
  status: string
}>()
defineEmits<{ open: [] }>()
const { t } = useI18n()
</script>

<template>
  <button
    class="w-full text-left mt-2 min-w-[230px] px-3 py-2.5 rounded-md border border-border bg-background hover:border-primary/50 transition-colors group"
    @click="$emit('open')"
  >
    <p class="text-[13px] font-semibold leading-snug">{{ title }}</p>
    <div class="mt-1.5 flex items-center justify-between gap-2.5">
      <span class="flex items-center gap-1.5 min-w-0">
        <span v-if="board" class="truncate rounded-sm bg-secondary px-1.5 py-0.5 text-[10.5px] font-semibold text-primary">{{ board }}</span>
        <WidgetEmbedStatusBadge :status="status" />
      </span>
      <span class="text-[11.5px] font-semibold text-primary inline-flex items-center gap-0.5 shrink-0">
        {{ t('widget.viewOnBoard') }}<Icon name="lucide:arrow-up-right" size="11" />
      </span>
    </div>
  </button>
</template>

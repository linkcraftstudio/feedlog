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
    class="w-full text-left mt-2 p-3 rounded-xl border border-border bg-background hover:border-primary/50 transition-colors group"
    @click="$emit('open')"
  >
    <p class="text-xs font-semibold leading-snug">{{ title }}</p>
    <div class="mt-2 flex items-center gap-2">
      <span v-if="board" class="text-[10px] font-semibold text-primary">{{ board }}</span>
      <WidgetEmbedStatusBadge :status="status" />
      <span class="ml-auto text-[10px] font-semibold text-primary flex items-center gap-0.5">
        {{ t('widget.viewOnBoard') }}<Icon name="lucide:arrow-up-right" size="11" />
      </span>
    </div>
  </button>
</template>

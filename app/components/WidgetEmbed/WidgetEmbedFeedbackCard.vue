<script setup lang="ts">
// The card the assistant returns after distilling a message into a post.
defineProps<{
  title: string
  board: string | null
  status: string
}>()
defineEmits<{ open: [] }>()
</script>

<template>
  <button
    class="w-full text-left mt-2 p-3 rounded-xl border border-border bg-background hover:border-primary/50 transition-colors group"
    @click="$emit('open')"
  >
    <div class="flex items-start gap-2">
      <p class="flex-1 text-xs font-semibold leading-snug">{{ title }}</p>
      <Icon name="lucide:arrow-up-right" size="13" class="shrink-0 mt-0.5 text-muted-foreground group-hover:text-primary transition-colors" />
    </div>
    <div class="mt-2 flex items-center gap-1.5">
      <WidgetEmbedStatusBadge :status="status" />
      <span v-if="board" class="text-[10px] text-muted-foreground">{{ board }}</span>
    </div>
  </button>
</template>

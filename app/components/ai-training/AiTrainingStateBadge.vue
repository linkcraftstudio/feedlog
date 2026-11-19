<script setup lang="ts">
withDefaults(defineProps<{ status: 'ready' | 'pending' | 'indexing' | 'failed' | 'partial' | 'disabled' | 'not_indexed' | 'index_failed' | 'crawl_failed'; label?: string; appearance?: 'badge' | 'inline' }>(), { appearance: 'badge', label: '' })
const tones = {
  ready: 'text-[var(--status-done)] bg-[var(--status-done-bg)] border-[var(--status-done-border)]',
  indexing: 'border-primary/20 bg-primary/5 text-primary',
  pending: 'border-[var(--status-in-progress-border)] bg-[var(--status-in-progress-bg)] text-[var(--status-in-progress)]',
  partial: 'border-[var(--status-in-progress-border)] bg-[var(--status-in-progress-bg)] text-[var(--status-in-progress)]',
  failed: 'border-destructive/25 bg-destructive/5 text-destructive',
  not_indexed: 'border-border bg-muted/50 text-muted-foreground',
  index_failed: 'border-destructive/25 bg-destructive/5 text-destructive',
  crawl_failed: 'border-destructive/25 bg-destructive/5 text-destructive',
  disabled: 'border-border bg-muted/50 text-muted-foreground',
}
const keys = { ready: 'indexed', pending: 'pending', indexing: 'indexing', failed: 'indexFailed', partial: 'partial', disabled: 'disabled', not_indexed: 'notIndexed', index_failed: 'indexFailed', crawl_failed: 'indexFailed' }
const inlineTones = { ready: 'text-[var(--status-done)]', pending: 'text-[var(--status-in-progress)]', indexing: 'text-[var(--status-in-progress)]', failed: 'text-destructive', partial: 'text-[var(--status-in-progress)]', disabled: 'text-muted-foreground', not_indexed: 'text-muted-foreground', index_failed: 'text-destructive', crawl_failed: 'text-destructive' }
</script>
<template>
  <span class="inline-flex shrink-0 items-center" :class="appearance === 'inline' ? ['gap-2 text-xs font-medium', inlineTones[status]] : ['gap-1 rounded border px-2 py-0.5 text-[10px] font-bold leading-[15px]', tones[status]]" :data-sync-state="status">
    <span v-if="appearance === 'inline'" class="size-2 shrink-0 rounded-full bg-current" :class="status === 'indexing' && 'motion-safe:animate-pulse'" aria-hidden="true" />
    {{ label || $t(status === 'partial' ? 'aiTraining.runs.partial' : 'aiTraining.ui.' + keys[status]) }}
  </span>
</template>

<script setup lang="ts">
import { Button } from '~/components/ui/button'
defineProps<{ total: number; pageCount: number }>()
const page = defineModel<number>('page', { required: true })
</script>
<template>
  <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border py-3 pr-4 pl-[var(--ai-training-content-start,1rem)] text-xs text-muted-foreground sm:pr-5" data-ai-training-pagination>
    <span>{{ $t('help.admin.showing', { from: (page - 1) * 10 + 1, to: Math.min(page * 10, total), total }) }}</span>
    <div class="ml-auto flex items-center gap-2"><Button variant="outline" size="icon-sm" :disabled="page <= 1" :aria-label="$t('aiTraining.ui.previousPage')" @click="page--"><Icon name="lucide:chevron-left" size="16" /></Button><span class="min-w-10 text-center tabular-nums">{{ page }} / {{ pageCount }}</span><Button variant="outline" size="icon-sm" :disabled="page >= pageCount" :aria-label="$t('aiTraining.ui.nextPage')" @click="page++"><Icon name="lucide:chevron-right" size="16" /></Button></div>
  </div>
</template>

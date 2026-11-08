<script setup lang="ts">
import { TooltipRoot as Tooltip, TooltipProvider, TooltipTrigger, TooltipContent, TooltipPortal } from 'reka-ui'
import type { HelpIndexStatus } from '#layers/feedlog/shared/types/help-index'

const props = defineProps<{ status: HelpIndexStatus }>()
const { t } = useI18n()
const styles = {
  not_indexed: { icon: 'lucide:clock-3', tone: 'border-border bg-muted/50 text-muted-foreground' },
  indexing: { icon: 'lucide:loader-circle', tone: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300' },
  ready: { icon: 'lucide:circle-check', tone: 'text-[var(--status-done)] bg-[var(--status-done-bg)] border-[var(--status-done-border)]' },
  failed: { icon: 'lucide:circle-alert', tone: 'border-destructive/25 bg-destructive/5 text-destructive' },
}
const presentation = computed(() => styles[props.status])
const hint = computed(() => t(props.status === 'failed' ? 'help.admin.editor.indexFailureHintEditor' : `help.admin.editor.indexHints.${props.status}`))
</script>

<template>
  <TooltipProvider :delay-duration="200">
    <Tooltip>
      <TooltipTrigger as-child>
        <span tabindex="0" :aria-label="`${t(`help.admin.editor.indexStatus.${status}`)}. ${hint}`" class="inline-flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-bold leading-[15px]" :class="presentation.tone" data-testid="help-index-status" :data-status="status">
          <Icon :name="presentation.icon" size="12" aria-hidden="true" :class="status === 'indexing' && 'motion-safe:animate-spin'" />
          {{ t(`help.admin.editor.indexStatus.${status}`) }}
        </span>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent :side-offset="6" class="z-50 max-w-xs rounded-md border bg-popover px-3 py-2 text-xs font-normal text-popover-foreground shadow-md">{{ hint }}</TooltipContent>
      </TooltipPortal>
    </Tooltip>
  </TooltipProvider>
</template>

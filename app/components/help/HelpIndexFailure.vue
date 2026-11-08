<script setup lang="ts">
import { TooltipRoot as Tooltip, TooltipProvider, TooltipTrigger, TooltipContent, TooltipPortal } from 'reka-ui'
const props = defineProps<{ inEditor?: boolean; indexing?: boolean }>()
const { t } = useI18n()
const hint = computed(() => t(props.indexing ? 'help.admin.editor.indexStatus.indexing' : props.inEditor ? 'help.admin.editor.indexFailureHintEditor' : 'help.admin.editor.indexFailureHint'))
</script>

<template>
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger as-child>
        <span tabindex="0" role="img" :aria-label="hint" class="inline-flex shrink-0" :class="indexing ? 'text-muted-foreground' : 'text-destructive'" :data-testid="indexing ? 'help-index-loading' : 'help-index-failure'">
          <Icon :name="indexing ? 'lucide:loader-circle' : 'lucide:info'" size="16" :class="indexing && 'motion-safe:animate-spin'" />
        </span>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent :side-offset="6" class="z-50 max-w-xs rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">{{ hint }}</TooltipContent>
      </TooltipPortal>
    </Tooltip>
  </TooltipProvider>
</template>

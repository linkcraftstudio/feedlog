<script setup lang="ts">
import { Switch } from '~/components/ui/switch'
const props = withDefaults(defineProps<{ enabled: boolean; name: string; disabled?: boolean }>(), { disabled: false })
const emit = defineEmits<{ change: [enabled: boolean] }>()
const { t } = useI18n()
const { confirm } = useConfirmDialog()
async function requestChange(enabled: boolean) {
  if (props.disabled) return
  if (enabled) emit('change', true)
  else if (await confirm({
    title: t('aiTraining.training.confirmTitle'),
    description: t('aiTraining.training.confirmDescription', { name: props.name }),
    cancelText: t('aiTraining.ui.cancel'),
    confirmText: t('aiTraining.training.confirmOff'),
  })) {
    if (!props.disabled) emit('change', false)
  }
}
</script>
<template>
  <label class="inline-flex shrink-0 items-center gap-2 text-xs font-medium text-muted-foreground" :title="$t('aiTraining.training.referenceHint')" data-ai-training-ai-reference>
    <span class="hidden whitespace-nowrap sm:inline">{{ $t('aiTraining.training.aiReference') }}</span>
    <Switch :model-value="enabled" :disabled="disabled" :aria-label="$t('aiTraining.training.referenceFor', { name })" @update:model-value="requestChange" />
  </label>
</template>

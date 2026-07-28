<script setup lang="ts">
import { WIDGET_MAX_RULE_LENGTH } from '~~/shared/constants/widget-rules'

// Add / edit a custom handoff rule. The text is spliced into the assistant's
// instructions verbatim, so the field is framed as completing a sentence
// ("redirect to support when… <scenario>") rather than as a free-form note.
const props = defineProps<{ initial?: string }>()
const emit = defineEmits<{ submit: [scenario: string] }>()
const open = defineModel<boolean>('open', { required: true })

const scenario = ref('')
const field = ref<HTMLTextAreaElement | null>(null)

watch(open, (isOpen) => {
  if (isOpen) {
    scenario.value = props.initial ?? ''
    nextTick(() => field.value?.focus())
  }
})

const trimmed = computed(() => scenario.value.trim())
const tooLong = computed(() => trimmed.value.length > WIDGET_MAX_RULE_LENGTH)
const canSubmit = computed(() => trimmed.value.length > 0 && !tooLong.value)

function submit() {
  if (!canSubmit.value) return
  emit('submit', trimmed.value)
  open.value = false
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle class="font-heading">{{ initial ? $t('settings.widget.editRule') : $t('settings.widget.addRule') }}</DialogTitle>
      </DialogHeader>

      <div>
        <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('settings.widget.ruleLabel') }}</label>
        <textarea
          ref="field"
          v-model="scenario"
          rows="3"
          :placeholder="$t('settings.widget.rulePlaceholder')"
          class="mt-2 w-full px-3.5 py-2.5 rounded-lg border border-border bg-background text-sm resize-none focus:outline-none focus:border-primary transition-colors"
          @keydown.meta.enter="submit"
        />
        <div class="flex items-start justify-between gap-3 mt-1.5">
          <p class="text-[11px] text-muted-foreground leading-snug">{{ $t('settings.widget.ruleHint') }}</p>
          <span
            class="text-[11px] tabular-nums shrink-0"
            :class="tooLong ? 'text-red-600 font-semibold' : 'text-muted-foreground'"
          >{{ trimmed.length }}/{{ WIDGET_MAX_RULE_LENGTH }}</span>
        </div>
      </div>

      <DialogFooter>
        <button
          class="h-9 px-4 rounded-lg border border-border bg-background text-xs font-semibold hover:bg-secondary transition-colors"
          @click="open = false"
        >
          {{ $t('settings.widget.cancel') }}
        </button>
        <button
          :disabled="!canSubmit"
          class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          @click="submit"
        >
          {{ $t('settings.widget.save') }}
        </button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

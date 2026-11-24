<script setup lang="ts">
defineProps<{ dirty: boolean; saving: boolean; disabled: boolean; error: string | null; saved: boolean; savedHint?: string }>()
defineEmits<{ cancel: []; save: [] }>()
</script>

<template>
  <div class="dashboard-panel-footer border-t border-border bg-muted/30 flex flex-wrap items-center justify-end gap-3">
    <p
      class="text-xs mr-auto"
      :class="error ? 'text-destructive' : 'text-muted-foreground'"
      :role="error ? 'alert' : 'status'"
    >
      {{ error || (dirty ? $t('settings.unsavedChanges') : saved ? (savedHint || $t('settings.widget.saved')) : '') }}
    </p>
    <button
      v-if="dirty"
      type="button"
      class="h-9 px-4 rounded-lg border border-border bg-background text-xs font-semibold hover:bg-secondary disabled:opacity-40"
      :disabled="saving"
      @click="$emit('cancel')"
    >
      {{ $t('settings.widget.cancelChanges') }}
    </button>
    <button
      type="button"
      class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
      :disabled="disabled || !dirty"
      @click="$emit('save')"
    >
      {{ saving ? $t('settings.saving') : $t('settings.saveChanges') }}
    </button>
  </div>
</template>

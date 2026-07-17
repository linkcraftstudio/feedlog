<script setup lang="ts">
const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  board?: BoardItem
}>()

const boardStore = useBoardStore()
const { t } = useI18n()
const isEdit = computed(() => !!props.board)
const formName = ref('')
const formDesc = ref('')
const submitting = ref(false)
const error = ref('')

watch(() => props.board, (b) => {
  formName.value = b?.name ?? ''
  formDesc.value = b?.description ?? ''
  error.value = ''
})

watch(open, (v) => {
  if (!v) {
    error.value = ''
  }
})

async function handleSave() {
  if (!formName.value.trim()) {
    error.value = t('dashboard.boards.nameRequired')
    return
  }

  submitting.value = true
  error.value = ''

  try {
    if (isEdit.value && props.board) {
      await boardStore.updateBoard(props.board.id, {
        name: formName.value.trim(),
        description: formDesc.value.trim() || null,
      })
    } else {
      await boardStore.createBoard({
        name: formName.value.trim(),
        description: formDesc.value.trim() || undefined,
      })
    }
    open.value = false
  } catch (e: any) {
    error.value = e.data?.message || t('dashboard.boards.saveFailed')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      :show-close-button="false"
      class="!max-w-[500px] !p-0 !gap-0 overflow-hidden border-border bg-card !rounded-xl"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-8 pt-8 pb-6">
        <DialogTitle class="font-heading text-xl font-bold">
          {{ isEdit ? $t('dashboard.boards.editTitle') : $t('dashboard.boards.create') }}
        </DialogTitle>
        <DialogClose class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-secondary transition-colors text-muted-foreground hover:text-primary">
          <Icon name="lucide:x" size="20" />
        </DialogClose>
      </div>

      <!-- Form -->
      <div class="px-8 pb-6 space-y-5">
        <div>
          <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2 block">
            {{ $t('dashboard.boards.nameLabel') }}
          </label>
          <input
            v-model="formName"
            class="w-full px-4 py-2.5 bg-background/60 border border-border rounded-lg text-sm font-bold focus:ring-primary focus:border-primary"
            @keydown.enter="handleSave"
          />
        </div>
        <div>
          <label class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2 block">
            {{ $t('dashboard.boards.descLabel') }}
          </label>
          <textarea
            v-model="formDesc"
            class="w-full px-4 py-3 bg-background/60 border border-border rounded-lg text-sm focus:ring-primary focus:border-primary min-h-[140px] resize-y leading-relaxed"
          />
        </div>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      </div>

      <!-- Footer actions -->
      <div class="flex items-center justify-end gap-4 px-8 py-5 border-t border-border">
        <DialogClose class="px-5 py-2 text-sm font-heading font-semibold text-muted-foreground hover:text-foreground transition-colors">
          {{ $t('common.cancel') }}
        </DialogClose>
        <button
          class="px-6 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-heading font-bold hover:opacity-90 transition-all disabled:opacity-50"
          :disabled="submitting"
          @click="handleSave"
        >
          {{ submitting ? $t('dashboard.boards.saving') : $t('dashboard.boards.saveChanges') }}
        </button>
      </div>

      <DialogDescription class="sr-only">
        {{ isEdit ? $t('dashboard.boards.editTitle') : $t('dashboard.boards.create') }}
      </DialogDescription>
    </DialogContent>
  </Dialog>
</template>

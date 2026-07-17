<script setup lang="ts">
import draggable from 'vuedraggable'

definePageMeta({ layout: 'dashboard', middleware: 'admin' })

const { t } = useI18n()
const boardStore = useBoardStore()
await callOnce(() => boardStore.fetchBoards())
const { boards } = storeToRefs(boardStore)

// Search
const search = ref('')
const isSearching = computed(() => !!search.value.trim())
const filteredBoards = computed(() => {
  if (!isSearching.value) return boards.value
  const q = search.value.toLowerCase()
  return boards.value.filter(b =>
    b.name.toLowerCase().includes(q) || (b.description ?? '').toLowerCase().includes(q),
  )
})

// Drag reorder — vuedraggable already updated boards array order via v-model,
// just persist the new order to the backend
async function onDragEnd() {
  const ids = boards.value.map(b => b.id)
  try {
    await useApiFetch('/api/admin/boards/reorder', { method: 'PATCH', body: { ids } })
  } catch (e) {
    // Revert on failure by re-fetching
    await boardStore.fetchBoards()
  }
}

// Edit modal
const showEdit = ref(false)
const editingBoard = ref<BoardItem | undefined>()

function openEdit(board: BoardItem) {
  editingBoard.value = board
  showEdit.value = true
}

function openCreate() {
  editingBoard.value = undefined
  showEdit.value = true
}

// Delete
const { confirm } = useConfirmDialog()
const deleting = ref<string | null>(null)

async function handleDelete(board: BoardItem) {
  const ok = await confirm({
    title: t('dashboard.boards.deleteTitle', { name: board.name }),
    description: t('dashboard.boards.deleteDescription'),
    confirmText: t('common.delete'),
    variant: 'destructive',
  })
  if (!ok) return
  deleting.value = board.id
  try {
    await boardStore.deleteBoard(board.id)
  } finally {
    deleting.value = null
  }
}
</script>

<template>
  <!-- Top bar -->
  <header class="h-16 px-6 border-b border-border flex items-center justify-between shrink-0 bg-card backdrop-blur-sm">
    <div class="flex items-center gap-4">
      <h2 class="font-heading text-lg font-bold">{{ $t('dashboard.boards.title') }}</h2>
      <div class="h-4 w-[1px] bg-border" />
      <span class="text-xs font-medium text-muted-foreground">{{ $t('dashboard.boards.subtitle') }}</span>
    </div>
    <div class="flex items-center gap-3">
      <button
        class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 transition-all flex items-center gap-2"
        @click="openCreate"
      >
        <Icon name="lucide:plus" size="16" />
        {{ $t('dashboard.boards.create') }}
      </button>
    </div>
  </header>

  <!-- Board list -->
  <div class="flex-1 overflow-y-auto p-6">
    <div class="max-w-[900px] mx-auto space-y-4">
      <!-- Empty state -->
      <div v-if="filteredBoards.length === 0" class="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <Icon name="lucide:layers" size="48" class="mb-4 opacity-50" />
        <p class="text-lg font-medium">{{ search ? $t('dashboard.boards.noResults') : $t('dashboard.boards.empty') }}</p>
        <p v-if="!search" class="text-sm mt-1">{{ $t('dashboard.boards.emptyHint') }}</p>
      </div>

      <ClientOnly>
        <draggable
          v-model="boards"
          item-key="id"
          handle=".drag-handle"
          :disabled="isSearching"
          ghost-class="opacity-50"
          @end="onDragEnd"
        >
          <template #item="{ element: board }">
            <div
              v-show="!isSearching || filteredBoards.some(b => b.id === board.id)"
              class="flex items-center gap-4 bg-card border border-border rounded-xl p-5 shadow-sm hover:shadow-warm transition-all group mb-4"
            >
              <!-- Drag handle -->
              <div class="drag-handle text-muted-foreground/40 shrink-0" :class="isSearching ? 'cursor-not-allowed' : 'cursor-grab'">
                <Icon name="lucide:grip-vertical" size="20" />
              </div>

              <!-- Board info -->
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-3 mb-1">
                  <h3 class="font-heading text-base font-bold">{{ board.name }}</h3>
                  <span class="text-xs text-muted-foreground bg-background px-2 py-0.5 rounded-full font-medium">
                    {{ $t('dashboard.boards.posts', { count: board.postCount ?? 0 }) }}
                  </span>
                </div>
                <p class="text-sm text-muted-foreground truncate">{{ board.description || $t('dashboard.boards.noDescription') }}</p>
              </div>

              <!-- Action buttons -->
              <div class="flex items-center gap-2 shrink-0">
                <button
                  class="w-10 h-10 flex items-center justify-center rounded-lg text-muted-foreground hover:text-primary hover:bg-secondary transition-colors"
                  @click="openEdit(board)"
                >
                  <Icon name="lucide:pencil" size="18" />
                </button>
                <button
                  class="w-10 h-10 flex items-center justify-center rounded-lg text-muted-foreground hover:text-destructive hover:bg-red-50 transition-colors disabled:opacity-50"
                  :disabled="deleting === board.id"
                  @click="handleDelete(board)"
                >
                  <Icon name="lucide:trash-2" size="18" />
                </button>
              </div>
            </div>
          </template>
        </draggable>
        <template #fallback>
          <div v-for="board in filteredBoards" :key="board.id" class="flex items-center gap-4 bg-card border border-border rounded-xl p-5 shadow-sm mb-4">
            <div class="text-muted-foreground/40 shrink-0">
              <Icon name="lucide:grip-vertical" size="20" />
            </div>
            <div class="flex-1 min-w-0">
              <h3 class="font-heading text-base font-bold">{{ board.name }}</h3>
              <p class="text-sm text-muted-foreground truncate">{{ board.description || $t('dashboard.boards.noDescription') }}</p>
            </div>
          </div>
        </template>
      </ClientOnly>
    </div>
  </div>

  <!-- Edit/Create modal -->
  <BoardEditModal v-model:open="showEdit" :board="editingBoard" />

</template>

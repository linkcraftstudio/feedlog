<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import type { SerializeObject } from 'nitropack/types'

// Component instance with exposed `el` from RoadmapCard
type CardComponentRef = ComponentPublicInstance & { el: HTMLElement }

// API response item type (PostListItem after JSON serialization)
type RoadmapItem = SerializeObject<PostListItem>

const props = defineProps<{
  boardId?: string | null
  editable?: boolean
}>()

const emit = defineEmits<{
  (e: 'open-detail', item: PostListItem): void
  (e: 'add', status: RoadmapStatus): void
}>()

// Define expose before await (Vue requirement)
// Use wrapper functions since the actual implementations are defined after await
const exposed = {
  refresh: () => refresh(),
  updateItem: (updated: { id: string; status?: string; [key: string]: unknown }) => updateItem(updated),
  removeItem: (postId: string) => removeItem(postId),
}
defineExpose(exposed)

// Ensure board data is loaded (needed by RoadmapCard for board names)
const boardStore = useBoardStore()
await callOnce(() => boardStore.fetchBoards())

const roadmapStatuses = ROADMAP_STATUSES
const { t } = useI18n()

// Fetch roadmap data (deep: true to track nested mutations)
const { data: roadmapData, refresh } = await useFetch('/api/roadmap', {
  deep: true,
  query: computed(() => ({
    boardId: props.boardId || undefined,
  })),
})

// Build columns from API data
const columns = computed(() =>
  roadmapStatuses.map(status => ({
    id: status,
    label: t(statusLabelKey(status)),
    cssVar: STATUS_CONFIG[status].cssVar,
    items: roadmapData.value?.[status]?.data ?? [],
    total: roadmapData.value?.[status]?.total ?? 0,
    nextCursor: roadmapData.value?.[status]?.nextCursor ?? null,
  })),
)

// Build flat render list for each column (cards + ghost + pending interleaved)
type RenderItem =
  | { type: 'card'; key: string; post: RoadmapItem }
  | { type: 'ghost'; key: string; post: RoadmapItem }
  | { type: 'pending'; key: string; post: RoadmapItem }

function buildRenderList(status: RoadmapStatus): RenderItem[] {
  const items = roadmapData.value?.[status]?.data ?? []
  const result: RenderItem[] = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    // Ghost before this index — use postId as key to merge with pending/real card
    if (ghostPreview.value?.status === status && ghostPreview.value.index === i) {
      result.push({ type: 'ghost', key: ghostPreview.value.post.id, post: ghostPreview.value.post })
    }
    // Pending before this index — use postId as key so it merges with the real card
    if (pendingDrop.value?.toStatus === status && pendingDrop.value.index === i) {
      result.push({ type: 'pending', key: pendingDrop.value.postId, post: pendingDrop.value.post })
    }
    // Real card
    result.push({ type: 'card', key: item.id, post: item })
  }

  // Ghost at end — use postId as key to merge with pending/real card
  if (ghostPreview.value?.status === status && ghostPreview.value.index >= items.length) {
    result.push({ type: 'ghost', key: ghostPreview.value.post.id, post: ghostPreview.value.post })
  }
  // Pending at end — use postId as key so it merges with the real card
  if (pendingDrop.value?.toStatus === status && pendingDrop.value.index >= items.length) {
    result.push({ type: 'pending', key: pendingDrop.value.postId, post: pendingDrop.value.post })
  }

  return result
}

// ---- Sorted insert helper ----
function findInsertIndex(list: RoadmapItem[], item: RoadmapItem): number {
  const itemTime = new Date(item.createdAt).getTime()
  for (let i = 0; i < list.length; i++) {
    const current = list[i]!
    const listTime = new Date(current.createdAt).getTime()
    if (itemTime > listTime || (itemTime === listTime && item.id > current.id)) {
      return i
    }
  }
  return list.length
}

// ---- Drag and drop state ----
const draggingPostId = ref<string | null>(null)
const draggingFromStatus = ref<RoadmapStatus | null>(null)
const dropTargetStatus = ref<RoadmapStatus | null>(null)

// Ghost preview: shows where the card will land in the target column (during hover)
const ghostPreview = ref<{ status: RoadmapStatus; index: number; post: RoadmapItem } | null>(null)

// Pending drop: ghost with loading indicator while API confirms (after release)
const pendingDrop = ref<{
  postId: string
  post: RoadmapItem
  fromStatus: RoadmapStatus
  toStatus: RoadmapStatus
  index: number
} | null>(null)

// ---- Drag and drop setup (pragmatic-drag-and-drop) ----
const columnRefs = ref<Record<string, HTMLElement | null>>({})
const scrollableRefs = ref<Record<string, HTMLElement | null>>({})
const cardRefs = ref<Map<string, CardComponentRef>>(new Map())
const cleanupFns: (() => void)[] = []

function setColumnRef(status: string, el: Element | ComponentPublicInstance | null) {
  columnRefs.value[status] = el as HTMLElement | null
}

function setScrollableRef(status: string, el: Element | ComponentPublicInstance | null) {
  scrollableRefs.value[status] = el as HTMLElement | null
}

function setCardRef(id: string, el: Element | ComponentPublicInstance | null) {
  if (el) {
    cardRefs.value.set(id, el as CardComponentRef)
  }
  // Never delete on unmount — TransitionGroup leave animation fires setCardRef(id, null)
  // ~150ms after the new component has already set a fresh ref for the same id.
  // Deleting here would remove the valid new ref and break drag registration.
  // Stale entries are harmless: setupDragAndDrop skips them (el null / not in data).
}

// Find the dragging post data
function getDraggingPost(): RoadmapItem | null {
  if (!draggingPostId.value || !draggingFromStatus.value || !roadmapData.value) return null
  return roadmapData.value[draggingFromStatus.value].data.find(
    p => p.id === draggingPostId.value,
  ) ?? null
}

// Show ghost preview in target column and scroll to it
function showGhostPreview(targetStatus: RoadmapStatus) {
  const post = getDraggingPost()
  if (!post) return

  const targetItems = roadmapData.value?.[targetStatus]?.data ?? []
  const index = findInsertIndex(targetItems, post)

  ghostPreview.value = { status: targetStatus, index, post }

  // Scroll ghost into view after enter animation expands enough for layout
  setTimeout(() => {
    const ghostEl = document.querySelector('[data-ghost-preview]') as HTMLElement
    if (ghostEl) {
      ghostEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, 100)
}

async function setupDragAndDrop() {
  if (!props.editable || !import.meta.client) return

  cleanupFns.forEach(fn => fn())
  cleanupFns.length = 0

  const { draggable: makeDraggable, dropTargetForElements } = await import('@atlaskit/pragmatic-drag-and-drop/element/adapter')
  const { setCustomNativeDragPreview } = await import('@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview')

  // Register drop targets (columns)
  for (const status of roadmapStatuses) {
    const el = columnRefs.value[status]
    if (!el) continue

    const cleanup = dropTargetForElements({
      element: el,
      getData: () => ({ status }),
      canDrop: ({ source }) => source.data.status !== status,
      onDragEnter: () => {
        dropTargetStatus.value = status
        showGhostPreview(status)
      },
      onDragLeave: () => {
        if (dropTargetStatus.value === status) {
          dropTargetStatus.value = null
          ghostPreview.value = null
        }
      },
      onDrop: () => {
        dropTargetStatus.value = null
        ghostPreview.value = null
      },
    })
    cleanupFns.push(cleanup)
  }

  // Register draggable cards
  for (const [id, componentRef] of cardRefs.value) {
    const el = componentRef.el
    if (!el) continue

    let cardStatus: RoadmapStatus | null = null
    for (const status of roadmapStatuses) {
      if (roadmapData.value?.[status]?.data.some(p => p.id === id)) {
        cardStatus = status
        break
      }
    }
    if (!cardStatus) continue

    const cleanup = makeDraggable({
      element: el,
      getInitialData: () => ({ postId: id, status: cardStatus }),
      onGenerateDragPreview: ({ nativeSetDragImage, location }) => {
        // Calculate mouse offset relative to the card element
        const rect = el.getBoundingClientRect()
        const offsetX = location.current.input.clientX - rect.left
        const offsetY = location.current.input.clientY - rect.top

        setCustomNativeDragPreview({
          nativeSetDragImage,
          getOffset: () => ({ x: offsetX, y: offsetY }),
          render: ({ container }) => {
            const clone = el.cloneNode(true) as HTMLElement
            clone.style.width = `${el.offsetWidth}px`
            clone.style.boxShadow = 'none'
            clone.style.opacity = '0.9'
            // Card surface token, not a fixed white, so the drag preview matches dark mode.
            clone.style.background = 'var(--card)'
            clone.style.borderRadius = '12px'
            clone.style.border = '2px solid var(--primary)'
            container.appendChild(clone)
          },
        })
      },
      onDragStart: () => {
        draggingPostId.value = id
        draggingFromStatus.value = cardStatus
      },
      onDrop: ({ location }) => {
        const target = location.current.dropTargets[0]
        if (target) {
          const targetStatus = target.data.status as RoadmapStatus
          handleDrop(id, cardStatus!, targetStatus)
        }
        draggingPostId.value = null
        draggingFromStatus.value = null
        dropTargetStatus.value = null
        ghostPreview.value = null
      },
    })
    cleanupFns.push(cleanup)
  }
}

watch(
  () => columns.value.map(c => c.items.length),
  () => { nextTick(() => setupDragAndDrop()) },
)

onMounted(() => {
  nextTick(() => setupDragAndDrop())
})

onUnmounted(() => {
  cleanupFns.forEach(fn => fn())
})

// ---- Handle drop (pessimistic update) ----
async function handleDrop(postId: string, fromStatus: RoadmapStatus, toStatus: RoadmapStatus) {
  // Clear hover ghost immediately to avoid two ghosts in the same frame
  ghostPreview.value = null
  dropTargetStatus.value = null

  if (fromStatus === toStatus || !roadmapData.value) return

  const fromCol = roadmapData.value[fromStatus]
  const idx = fromCol.data.findIndex(p => p.id === postId)
  if (idx === -1) return

  const item = fromCol.data[idx]!
  const targetItems = roadmapData.value[toStatus].data
  const insertIndex = findInsertIndex(targetItems, item)

  // Step 1: Source card stays but shows ghost state, target shows pending ghost
  pendingDrop.value = { postId, post: { ...item }, fromStatus, toStatus, index: insertIndex }

  // Step 2: Call API (with minimum display time for loading state)
  const MIN_LOADING_MS = 400
  try {
    await Promise.all([
      useApiFetch(`/api/admin/posts/${postId}`, {
        method: 'PATCH',
        body: { status: toStatus },
      }),
      new Promise(r => setTimeout(r, MIN_LOADING_MS)),
    ])

    // Step 3a: Success — insert real card in target first, then clear pending + remove source
    // Insert before clearing pendingDrop so the key stays the same (pending → card, no animation)
    const toCol = roadmapData.value[toStatus]
    const realItem = { ...item, status: toStatus }
    const finalIndex = findInsertIndex(toCol.data, realItem)
    toCol.data.splice(finalIndex, 0, realItem)
    toCol.total++
    pendingDrop.value = null

    // Now remove source card (triggers leave animation in source column)
    const sourceIdx = fromCol.data.findIndex(p => p.id === postId)
    if (sourceIdx !== -1) {
      fromCol.data.splice(sourceIdx, 1)
      fromCol.total--
    }
  } catch {
    // Step 3b: Failure — just remove ghost, source card is still there
    pendingDrop.value = null
  }
}

// ---- Load more with dedup ----
const loadingMore = ref<RoadmapStatus | null>(null)

async function loadMore(status: RoadmapStatus) {
  const col = roadmapData.value?.[status]
  if (!col?.nextCursor || loadingMore.value) return

  loadingMore.value = status
  try {
    const moreData = await useApiFetch<CursorPaginatedList<RoadmapItem>>('/api/posts', {
      query: {
        status,
        sort: 'createdAt',
        cursor: col.nextCursor,
        pageSize: 10,
        boardId: props.boardId || undefined,
      },
    })

    if (moreData && roadmapData.value) {
      const existingIds = new Set(col.data.map(p => p.id))
      const newItems = moreData.data.filter(p => !existingIds.has(p.id))
      col.data.push(...newItems)
      col.nextCursor = moreData.pagination.nextCursor
    }
  } finally {
    loadingMore.value = null
  }
}

// ---- Local update methods ----

function updateItem(updated: { id: string; status?: string; [key: string]: unknown }) {
  if (!roadmapData.value) return

  let foundStatus: RoadmapStatus | null = null
  let foundIndex = -1
  for (const status of roadmapStatuses) {
    const idx = roadmapData.value[status].data.findIndex(p => p.id === updated.id)
    if (idx !== -1) {
      foundStatus = status
      foundIndex = idx
      break
    }
  }

  const isRoadmapStatus = (s: string): s is RoadmapStatus =>
    (roadmapStatuses as readonly string[]).includes(s)
  const newStatus = updated.status ?? foundStatus

  if (!foundStatus && (!newStatus || !isRoadmapStatus(newStatus))) return

  if (foundStatus && foundIndex !== -1) {
    const col = roadmapData.value[foundStatus]
    const item = col.data[foundIndex]!

    if (!newStatus || !isRoadmapStatus(newStatus)) {
      col.data.splice(foundIndex, 1)
      col.total--
      return
    }

    if (newStatus === foundStatus) {
      Object.assign(item, updated)
      // If board filter is active and the updated boardId no longer matches, remove the card
      if (props.boardId && 'boardId' in updated && updated.boardId !== props.boardId) {
        col.data.splice(foundIndex, 1)
        col.total--
      }
      return
    }

    col.data.splice(foundIndex, 1)
    col.total--

    const movedItem = { ...item, ...updated }
    const targetCol = roadmapData.value[newStatus]
    const insertIdx = findInsertIndex(targetCol.data, movedItem as RoadmapItem)
    targetCol.data.splice(insertIdx, 0, movedItem as RoadmapItem)
    targetCol.total++
    return
  }

  if (newStatus && isRoadmapStatus(newStatus)) {
    const targetCol = roadmapData.value[newStatus]
    if (updated.title && updated.createdAt) {
      const insertIdx = findInsertIndex(targetCol.data, updated as RoadmapItem)
      targetCol.data.splice(insertIdx, 0, updated as RoadmapItem)
      targetCol.total++
    } else {
      targetCol.total++
    }
  }
}

function removeItem(postId: string) {
  if (!roadmapData.value) return

  for (const status of roadmapStatuses) {
    const col = roadmapData.value[status]
    const idx = col.data.findIndex(p => p.id === postId)
    if (idx !== -1) {
      col.data.splice(idx, 1)
      col.total--
      return
    }
  }
}

</script>

<template>
  <div class="flex gap-6 h-full">
    <div
      v-for="col in columns"
      :key="col.id"
      :ref="(el) => setColumnRef(col.id, el)"
      :data-status="col.id"
      class="flex-1 flex flex-col min-w-[260px] md:min-w-0 kanban-column transition-all duration-200"
      :class="{
        'ring-2 ring-primary/50': dropTargetStatus === col.id,
      }"
    >
      <!-- Column header -->
      <div class="flex items-center justify-between mb-4 px-2">
        <div class="flex items-center gap-2">
          <span class="w-2.5 h-2.5 rounded-full" :style="{ backgroundColor: `var(${col.cssVar})` }" />
          <h3 class="font-heading text-sm font-bold uppercase tracking-wider">{{ col.label }}</h3>
          <span class="ml-1 px-2 py-0.5 rounded-full bg-card/60 text-[10px] font-bold text-muted-foreground border border-border/40">
            {{ col.total }}
          </span>
        </div>
        <button
          v-if="editable"
          class="text-muted-foreground hover:text-primary transition-colors"
          @click="emit('add', col.id)"
        >
          <Icon name="lucide:plus" size="20" />
        </button>
      </div>

      <!-- Card list -->
      <div
        v-if="col.items.length || ghostPreview?.status === col.id || pendingDrop?.toStatus === col.id"
        :ref="(el) => setScrollableRef(col.id, el)"
        class="flex-1 overflow-y-auto pr-1"
      >
        <TransitionGroup
          name="kanban-card"
          tag="div"
          class="space-y-4"
        >
          <div
            v-for="entry in buildRenderList(col.id)"
            :key="entry.key"
            :data-ghost-preview="entry.type === 'ghost' ? '' : undefined"
          >
            <!-- Hover ghost -->
            <RoadmapCard
              v-if="entry.type === 'ghost'"
              :post="entry.post"
              class="opacity-40 border-2 border-dashed border-primary/40 !shadow-none"
            />

            <!-- Pending drop with spinner -->
            <div v-else-if="entry.type === 'pending'" class="relative select-none">
              <RoadmapCard
                :post="entry.post"
                class="opacity-50 !shadow-none animate-pulse"
              />
              <div class="absolute inset-0 flex items-center justify-center">
                <Spinner class="size-5 text-primary" />
              </div>
            </div>

            <!-- Real card -->
            <RoadmapCard
              v-else
              :ref="(el: any) => editable && setCardRef(entry.post.id, el)"
              :post="entry.post"
              :class="{
                'opacity-40 scale-95': draggingPostId === entry.post.id || pendingDrop?.postId === entry.post.id,
                'cursor-grab active:cursor-grabbing select-none': editable && !pendingDrop,
              }"
              @click="!draggingPostId && !pendingDrop && emit('open-detail', entry.post)"
            />
          </div>
        </TransitionGroup>

        <!-- Load more -->
        <div v-if="col.nextCursor" class="flex justify-center pt-2 pb-1 mt-4">
          <button
            class="text-xs font-bold text-muted-foreground hover:text-primary transition-colors"
            :disabled="loadingMore === col.id"
            @click.stop="loadMore(col.id)"
          >
            {{ loadingMore === col.id ? $t('roadmap.loading') : $t('roadmap.loadMore') }}
          </button>
        </div>
      </div>

      <!-- Empty state -->
      <div
        v-if="!col.items.length && !draggingPostId"
        class="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-border/60 rounded-xl p-8 text-center bg-card/30"
      >
        <Icon name="lucide:puzzle" size="48" class="text-border mb-3" />
        <p class="text-xs font-medium text-muted-foreground">{{ $t('roadmap.emptyColumn', { status: col.label.toLowerCase() }) }}</p>
        <button
          v-if="editable"
          class="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-primary bg-primary/5 hover:bg-primary/10 transition-colors text-xs font-bold border border-primary/20"
          @click="emit('add', col.id)"
        >
          <Icon name="lucide:plus-circle" size="16" />
          {{ $t('roadmap.addItem') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.kanban-column {
  /* Subtle panel that derives from the foreground so it reads as a recessed
     column in both light (faint dark wash) and dark (faint light wash) modes —
     a fixed light beige stayed light against the dark surface. */
  background-color: color-mix(in oklab, var(--foreground) 5%, transparent);
  border-radius: 16px;
  padding: 12px;
}

/* Card enter: expand from 0 height + fade in */
.kanban-card-enter-active {
  transition: all 0.15s ease;
  overflow: hidden;
}
.kanban-card-enter-from {
  opacity: 0;
  max-height: 0;
  margin-top: 0 !important;
  margin-bottom: 0 !important;
}
.kanban-card-enter-to {
  opacity: 1;
  max-height: 200px;
}

/* Card leave: collapse to 0 height + fade out */
.kanban-card-leave-active {
  transition: all 0.15s ease;
  overflow: hidden;
}
.kanban-card-leave-from {
  opacity: 1;
  max-height: 200px;
}
.kanban-card-leave-to {
  opacity: 0;
  max-height: 0;
  margin-top: 0 !important;
  margin-bottom: 0 !important;
}

/* Other cards move smoothly when items are added/removed */
.kanban-card-move {
  transition: transform 0.15s ease;
}
</style>

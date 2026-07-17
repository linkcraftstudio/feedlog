<script setup lang="ts">
definePageMeta({ layout: 'dashboard', middleware: 'admin' })

const { t } = useI18n()
const boardStore = useBoardStore()
const postDetailStore = usePostDetailStore()
await callOnce(() => boardStore.fetchBoards())
const { boards } = storeToRefs(boardStore)

const selectedBoard = ref('all')
const boardOptions = computed(() => [
  { value: 'all', label: t('dashboard.allBoards') },
  ...boards.value.map(b => ({ value: b.id, label: b.name })),
])

const activeBoardId = computed(() =>
  selectedBoard.value !== 'all' ? selectedBoard.value : null,
)

const showSubmit = ref(false)
const addStatus = ref<string | null>(null)
const kanbanRef = ref<{ refresh: () => Promise<void>; updateItem: (post: any) => void; removeItem: (id: string) => void } | null>(null)

function handleAdd(status: string) {
  addStatus.value = status
  showSubmit.value = true
}

async function handleCreated(slug: string) {
  // Set the status for newly created post (created as 'open' by default)
  if (addStatus.value && addStatus.value !== 'open') {
    try {
      const post = await useApiFetch<PostDetail>(`/api/posts/${slug}`)
      if (post?.id) {
        await useApiFetch(`/api/admin/posts/${post.id}`, {
          method: 'PATCH',
          body: { status: addStatus.value },
        })
      }
    } catch {
      // Status update failed, post still created as 'open'
    }
  }
  addStatus.value = null
  kanbanRef.value?.refresh()
}

const showDetail = ref(false)
const detailSlug = ref<string | null>(null)

function openPostDetail(item: PostListItem) {
  postDetailStore.prefill(item.slug, item)
  detailSlug.value = item.slug
  showDetail.value = true
}
</script>

<template>
  <!-- Top bar -->
  <header class="h-16 px-6 border-b border-border flex items-center justify-between shrink-0 bg-card backdrop-blur-sm">
    <div class="flex items-center gap-4">
      <h2 class="font-heading text-lg font-bold">{{ $t('dashboard.roadmap.title') }}</h2>
      <div class="h-4 w-[1px] bg-border" />
      <span class="text-xs font-medium text-muted-foreground">{{ $t('dashboard.roadmap.subtitle') }}</span>
    </div>
  </header>

  <!-- Board filter bar -->
  <div class="px-6 py-4 border-b border-border flex items-center bg-background/30">
    <FilterTag
      v-model="selectedBoard"
      :label="$t('dashboard.filter.board')"
      icon="lucide:layers"
      :options="boardOptions"
      :removable="false"
    />
  </div>

  <!-- Board area -->
  <div class="flex-1 min-h-0 overflow-x-auto overflow-y-hidden p-6">
    <RoadmapKanban ref="kanbanRef" :board-id="activeBoardId" editable @open-detail="openPostDetail" @add="handleAdd" />
  </div>

  <SubmitModal v-model:open="showSubmit" :default-board-id="activeBoardId ?? undefined" @created="handleCreated" />
  <PostDetailModal
    v-model:open="showDetail"
    :slug="detailSlug"
    @updated="kanbanRef?.updateItem($event)"
    @deleted="kanbanRef?.removeItem($event)"
  />
</template>

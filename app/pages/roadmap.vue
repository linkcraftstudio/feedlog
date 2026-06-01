<script setup lang="ts">
usePageOg({ kind: 'roadmap' })

const postDetailStore = usePostDetailStore()
const showDetail = ref(false)
const detailSlug = ref<string | null>(null)
const kanbanRef = ref<{ updateItem: (post: any) => void; removeItem: (id: string) => void } | null>(null)

function openPostDetail(item: PostListItem) {
  postDetailStore.prefill(item.slug, item)
  detailSlug.value = item.slug
  showDetail.value = true
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0 max-h-[calc(100vh-5rem)] min-h-[500px]">
    <!-- Title area -->
    <div class="pb-3 md:pb-6">
      <div class="flex items-baseline gap-3">
        <h1 class="font-heading text-xl md:text-2xl font-bold shrink-0">Roadmap</h1>
        <p class="text-sm text-muted-foreground truncate">Our current strategic roadmap and development status.</p>
      </div>
    </div>

    <!-- Board area -->
    <div class="flex-1 overflow-x-auto overflow-y-hidden min-h-[400px]">
      <RoadmapKanban ref="kanbanRef" @open-detail="openPostDetail" />
    </div>
  </div>

  <PostDetailModal
    v-model:open="showDetail"
    :slug="detailSlug"
    @updated="kanbanRef?.updateItem($event)"
    @deleted="kanbanRef?.removeItem($event)"
  />
</template>

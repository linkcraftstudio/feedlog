<script setup lang="ts">

usePageOg({ kind: 'changelogList' })

const pageSize = 10

// SSR-compatible initial fetch
const { data, status } = await useFetch<CursorPaginatedList<ChangelogListItem>>('/api/changelogs', {
  query: { pageSize },
})

// Mutable list for "Load More" appending
const items = computed(() => data.value?.data ?? [])
const extraItems = ref<ChangelogListItem[]>([])
const extraCursor = ref<string | null>(null)
const loadingMore = ref(false)

const allItems = computed(() => [...items.value, ...extraItems.value])
const nextCursor = computed(() => extraCursor.value ?? data.value?.pagination?.nextCursor ?? null)

async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return
  loadingMore.value = true

  try {
    const result = await useApiFetch<CursorPaginatedList<ChangelogListItem>>('/api/changelogs', {
      query: { pageSize, cursor: nextCursor.value },
    })
    extraItems.value.push(...result.data)
    extraCursor.value = result.pagination.nextCursor
  } finally {
    loadingMore.value = false
  }
}

function collapseDefaultForIndex(index: number) {
  return index >= 2
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0 max-w-3xl mx-auto w-full min-h-0">
    <div class="pb-3 sm:pb-4 md:pb-8">
      <div class="flex flex-col gap-1.5 sm:gap-2 md:flex-row md:items-baseline md:justify-between md:gap-4">
        <div class="min-w-0">
          <h1 class="font-heading text-xl sm:text-2xl md:text-3xl font-bold tracking-tight">
            Changelog
          </h1>
          <p class="text-xs sm:text-sm text-muted-foreground mt-1 max-w-xl leading-relaxed">
            Product updates, fixes, and improvements.
          </p>
        </div>
      </div>
    </div>

    <!-- Loading (only on initial SSR pending, not on client) -->
    <div v-if="status === 'pending' && allItems.length === 0" class="flex items-center justify-center py-16">
      <div class="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
    </div>

    <!-- Empty -->
    <div v-else-if="allItems.length === 0" class="flex flex-col items-center justify-center py-16 text-muted-foreground">
      <Icon name="lucide:newspaper" size="48" class="mb-4 opacity-50" />
      <p class="text-lg font-medium">No updates yet</p>
      <p class="text-sm mt-1">Check back soon for product updates.</p>
    </div>

    <template v-else>
      <div class="flex flex-col">
        <ChangelogTimelineItem
          v-for="(entry, index) in allItems"
          :key="entry.id"
          :entry="entry"
          :is-last="index === allItems.length - 1 && !nextCursor"
          :collapse-body-by-default="collapseDefaultForIndex(index)"
        />
      </div>

      <div v-if="nextCursor" class="flex justify-center mt-3 sm:mt-2 mb-6 sm:mb-8 px-1">
        <button
          type="button"
          class="w-full max-w-xs min-h-11 px-6 py-2.5 rounded-full border border-border text-sm font-heading font-semibold hover:border-primary hover:text-primary active:bg-secondary/50 transition-colors bg-card shadow-warm sm:min-h-0 sm:w-auto"
          :disabled="loadingMore"
          @click="loadMore"
        >
          {{ loadingMore ? 'Loading...' : 'Load more' }}
        </button>
      </div>
    </template>
  </div>
</template>

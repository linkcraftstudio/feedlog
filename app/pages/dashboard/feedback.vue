<script setup lang="ts">
definePageMeta({ layout: 'dashboard', middleware: 'admin' })

const boardStore = useBoardStore()
const postDetailStore = usePostDetailStore()
await callOnce(() => boardStore.fetchBoards())
const { boards, boardMap } = storeToRefs(boardStore)

// ---- Filter system ----

interface FilterType {
  key: string
  label: string
  icon: string
  options: { value: string; label: string }[]
}


const statusOptions = [
  { value: 'all', label: 'All' },
  ...STATUS_OPTIONS.map(s => ({ value: s.value, label: s.label })),
]

const boardOptions = computed(() => [
  { value: 'all', label: 'All' },
  ...boards.value.map(b => ({ value: b.id, label: b.name })),
])

const mergedOptions = [
  { value: 'canonical_only', label: 'Canonical Only' },
  { value: 'merged_only', label: 'Merged Only' },
  { value: 'all', label: 'All' },
]

const filterTypes = computed<FilterType[]>(() => [
  { key: 'status', label: 'Status', icon: 'lucide:activity', options: statusOptions },
  { key: 'boardId', label: 'Board', icon: 'lucide:layers', options: boardOptions.value },
  { key: 'merged', label: 'Merged', icon: 'lucide:git-merge', options: mergedOptions },
])

// Active filters: Map<key, value>
const filters = ref(new Map<string, string>())

function addFilter(key: string, value: string) {
  filters.value.set(key, value)
  // Trigger reactivity
  filters.value = new Map(filters.value)
}

function removeFilter(key: string) {
  filters.value.delete(key)
  filters.value = new Map(filters.value)
}

function updateFilterValue(key: string, value: string) {
  filters.value.set(key, value)
  filters.value = new Map(filters.value)
}

function clearAllFilters() {
  filters.value = new Map()
}


// Resolve display info for active filters
const activeFilterEntries = computed(() => {
  const entries: { key: string; label: string; icon: string; value: string; valueLabel: string; options: { value: string; label: string }[] }[] = []
  for (const [key, value] of filters.value) {
    const type = filterTypes.value.find(t => t.key === key)
    if (!type) continue
    const opt = type.options.find(o => o.value === value)
    entries.push({
      key,
      label: type.label,
      icon: type.icon,
      value,
      valueLabel: opt?.label ?? value,
      options: type.options,
    })
  }
  return entries
})

// Build API query from filters (skip "all" values)
const filterStatus = computed(() => {
  const v = filters.value.get('status')
  return v && v !== 'all' ? v : undefined
})
const filterBoardId = computed(() => {
  const v = filters.value.get('boardId')
  return v && v !== 'all' ? v : undefined
})
const filterMerged = computed(() => {
  const v = filters.value.get('merged')
  return v || 'canonical_only'
})

// ---- Add filter dropdown state ----
const addFilterOpen = ref(false)
const addFilterStep = ref<'type' | 'value'>('type')
const addFilterSelectedType = ref<FilterType | null>(null)

function openAddFilter() {
  addFilterStep.value = 'type'
  addFilterSelectedType.value = null
  addFilterOpen.value = true
}

function selectFilterType(type: FilterType) {
  addFilterSelectedType.value = type
  addFilterStep.value = 'value'
}

function selectFilterValue(value: string) {
  if (addFilterSelectedType.value) {
    addFilter(addFilterSelectedType.value.key, value)
  }
  addFilterOpen.value = false
}

// ---- Sort & Pagination ----
const sortBy = ref<'createdAt' | 'votes' | 'comments'>('createdAt')
const currentPage = ref(1)
const pageSize = 10

// Reset page when filters change
watch(filters, () => {
  currentPage.value = 1
}, { deep: true })

// Fetch data
const { data: postsData, refresh: refreshPosts, status: fetchStatus } = await useFetch<PagePaginatedList<PostListItem>>('/api/admin/posts', {
  query: computed(() => ({
    status: filterStatus.value,
    boardId: filterBoardId.value,
    merged: filterMerged.value,
    sort: sortBy.value,
    page: currentPage.value,
    pageSize,
  })),
})

const posts = computed(() => postsData.value?.data ?? [])
const pagination = computed(() => postsData.value?.pagination ?? { page: 1, pageSize, total: 0 })
const totalPages = computed(() => Math.ceil(pagination.value.total / pagination.value.pageSize))

// Status config: uses centralized STATUS_CONFIG imported above

// Sort handler
function toggleSort(col: 'createdAt' | 'votes' | 'comments') {
  sortBy.value = col
  currentPage.value = 1
}


function initials(name: string | null) {
  return (name || '?').slice(0, 2).toUpperCase()
}

// Pagination
const pageNumbers = computed(() => {
  const total = totalPages.value
  const current = currentPage.value
  if (total <= 5) return Array.from({ length: total }, (_, i) => i + 1)
  const pages: number[] = []
  const start = Math.max(1, current - 1)
  const end = Math.min(total, start + 2)
  for (let i = start; i <= end; i++) pages.push(i)
  return pages
})

// Modal controls
const showSubmit = ref(false)
const showDetail = ref(false)
const detailSlug = ref<string | null>(null)

function openPostDetail(item: PostListItem) {
  postDetailStore.prefill(item.slug, item)
  detailSlug.value = item.slug
  showDetail.value = true
}

// Local update handlers
function onPostUpdated(updated: { id: string; status?: string; boardId?: string | null; [key: string]: any }) {
  const list = postsData.value?.data
  if (!list) return
  const idx = list.findIndex(p => p.id === updated.id)
  if (idx === -1) return

  // If status/board changed and no longer matches active filters, remove
  if (updated.status !== undefined && filterStatus.value && updated.status !== filterStatus.value) {
    list.splice(idx, 1)
    if (postsData.value?.pagination) postsData.value.pagination.total--
    return
  }
  if (updated.boardId !== undefined && filterBoardId.value && updated.boardId !== filterBoardId.value) {
    list.splice(idx, 1)
    if (postsData.value?.pagination) postsData.value.pagination.total--
    return
  }

  Object.assign(list[idx], updated)
}

function onPostDeleted(postId: string) {
  const list = postsData.value?.data
  if (!list) return
  const idx = list.findIndex(p => p.id === postId)
  if (idx !== -1) {
    list.splice(idx, 1)
    if (postsData.value?.pagination) postsData.value.pagination.total--
  }
}
</script>

<template>
  <!-- Top bar -->
  <header class="h-14 md:h-16 px-4 md:px-6 border-b border-border flex items-center justify-between shrink-0 bg-card backdrop-blur-sm">
    <div class="flex items-center gap-4">
      <h2 class="font-heading text-lg font-bold">Feedback</h2>
      <div class="hidden md:block h-4 w-[1px] bg-border" />
      <span class="hidden md:block text-xs font-medium text-muted-foreground">All submissions</span>
    </div>
    <div class="flex items-center gap-3">
      <!-- Filters button -->
      <DropdownMenu v-model:open="addFilterOpen">
        <DropdownMenuTrigger as-child>
          <button
            class="h-9 px-3 rounded-lg border border-border bg-background text-xs font-heading font-bold text-muted-foreground hover:text-foreground hover:border-primary transition-all flex items-center gap-2"
            @click="openAddFilter"
          >
            <Icon name="lucide:filter" size="16" />
            Filters
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="w-48">
          <!-- Step 1: Choose filter type -->
          <template v-if="addFilterStep === 'type'">
            <DropdownMenuItem
              v-for="type in filterTypes"
              :key="type.key"
              class="cursor-pointer"
              @select.prevent="selectFilterType(type)"
            >
              <Icon :name="type.icon" size="14" class="mr-2" />
              {{ type.label }}
            </DropdownMenuItem>
          </template>
          <!-- Step 2: Choose value -->
          <template v-else-if="addFilterStep === 'value' && addFilterSelectedType">
            <DropdownMenuItem
              v-for="opt in addFilterSelectedType.options.filter(o => o.value !== 'all')"
              :key="opt.value"
              class="cursor-pointer"
              @select="selectFilterValue(opt.value)"
            >
              {{ opt.label }}
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>

      <!-- Create button -->
      <button
        class="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 transition-all flex items-center gap-2"
        @click="showSubmit = true"
      >
        <Icon name="lucide:plus" size="16" />
        Create Feedback
      </button>
    </div>
  </header>

  <!-- Main content -->
  <div class="flex-1 flex flex-col min-h-0">
    <div class="flex-1 flex flex-col overflow-hidden bg-card">
      <!-- Filter bar -->
      <div v-if="activeFilterEntries.length > 0" class="px-6 py-4 border-b border-border flex items-center justify-between bg-background/30">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mr-2">Active Filters:</span>
          <div class="flex items-center gap-2">
            <FilterTag
              v-for="entry in activeFilterEntries"
              :key="entry.key"
              :label="entry.label"
              :icon="entry.icon"
              :model-value="entry.value"
              :options="entry.options"
              @update:model-value="updateFilterValue(entry.key, $event)"
              @remove="removeFilter(entry.key)"
            />
          </div>
          <button
            class="text-[10px] font-bold text-muted-foreground hover:text-primary transition-colors ml-2 underline underline-offset-2"
            @click="clearAllFilters"
          >
            Clear all
          </button>
        </div>
      </div>

      <!-- Data table -->
      <div class="flex-1 overflow-auto" :class="{ 'opacity-50 pointer-events-none': fetchStatus === 'pending' && posts.length > 0 }" style="transition: opacity 0.2s ease;">
        <!-- Loading -->
        <div v-if="fetchStatus === 'pending' && posts.length === 0" class="flex items-center justify-center py-16">
          <div class="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
        </div>

        <!-- Empty state -->
        <div v-else-if="posts.length === 0" class="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Icon name="lucide:inbox" size="48" class="mb-4 opacity-50" />
          <p class="text-lg font-medium">No feedback found</p>
          <p class="text-sm mt-1">Try adjusting your filters</p>
        </div>

        <template v-else>
          <!-- Mobile card list -->
          <div class="md:hidden divide-y divide-border">
            <div
              v-for="fb in posts"
              :key="fb.id"
              class="px-4 py-3 cursor-pointer active:bg-background/50 transition-colors"
              @click="openPostDetail(fb)"
            >
              <div class="flex items-start gap-3">
                <!-- Vote -->
                <div class="flex flex-col items-center justify-center w-10 h-10 rounded-lg bg-background border border-border shrink-0">
                  <Icon name="lucide:chevron-up" size="12" class="text-muted-foreground" />
                  <span class="text-[11px] font-bold leading-none">{{ fb.voteCount }}</span>
                </div>
                <!-- Content -->
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-0.5">
                    <span
                      class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold border"
                      :style="{
                        color: `var(${(STATUS_CONFIG[fb.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open).cssVar})`,
                        backgroundColor: `var(${(STATUS_CONFIG[fb.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open).cssVar}-bg)`,
                        borderColor: `var(${(STATUS_CONFIG[fb.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open).cssVar}-border)`,
                      }"
                    >
                      {{ (STATUS_CONFIG[fb.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open).label }}
                    </span>
                    <span v-if="fb.boardId" class="text-[10px] font-medium text-muted-foreground">
                      {{ boardMap.get(fb.boardId) ?? 'Unknown' }}
                    </span>
                  </div>
                  <h4 class="text-sm font-bold truncate">{{ fb.title }}</h4>
                  <p class="text-[11px] text-muted-foreground truncate mt-0.5">{{ fb.excerpt }}</p>
                  <div class="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
                    <div class="flex items-center gap-1">
                      <img
                        v-if="fb.author?.image"
                        :src="fb.author.image"
                        :alt="fb.author.name"
                        class="w-4 h-4 rounded-full object-cover"
                        referrerpolicy="no-referrer"
                      >
                      <div
                        v-else
                        class="w-4 h-4 rounded-full bg-accent flex items-center justify-center text-accent-foreground font-bold text-[7px]"
                      >
                        {{ initials(fb.author?.name) }}
                      </div>
                      <span class="font-medium">{{ fb.author?.name ?? 'Anonymous' }}</span>
                    </div>
                    <span>{{ formatDate(fb.createdAt) }}</span>
                    <div class="flex items-center gap-0.5">
                      <Icon name="lucide:message-square" size="12" />
                      {{ fb.commentCount }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Desktop table -->
          <table class="hidden md:table w-full text-left border-collapse min-w-[1000px] table-fixed">
            <thead class="sticky top-0 bg-background border-b border-border z-10">
              <tr>
                <th
                  class="w-24 px-6 py-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-primary transition-colors"
                  @click="toggleSort('votes')"
                >
                  <div class="flex items-center gap-1">
                    Upvotes
                    <Icon v-if="sortBy === 'votes'" name="lucide:arrow-down" size="14" class="text-primary" />
                  </div>
                </th>
                <th class="w-1/4 px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Title</th>
                <th class="w-32 px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Board</th>
                <th class="w-40 px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Author</th>
                <th
                  class="w-32 px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-primary transition-colors"
                  @click="toggleSort('comments')"
                >
                  <div class="flex items-center gap-1">
                    Comments
                    <Icon v-if="sortBy === 'comments'" name="lucide:arrow-down" size="14" class="text-primary" />
                  </div>
                </th>
                <th
                  class="w-32 px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-primary transition-colors"
                  @click="toggleSort('createdAt')"
                >
                  <div class="flex items-center gap-1">
                    Created
                    <Icon v-if="sortBy === 'createdAt'" name="lucide:arrow-down" size="14" class="text-primary" />
                  </div>
                </th>
                <th class="w-32 px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr
                v-for="fb in posts"
                :key="fb.id"
                class="hover:bg-background/50 cursor-pointer transition-colors group"
                @click="openPostDetail(fb)"
              >
                <!-- Votes -->
                <td class="px-6 py-4">
                  <div class="flex flex-col items-center justify-center w-10 h-10 rounded-lg bg-background border border-border">
                    <Icon name="lucide:chevron-up" size="14" class="text-muted-foreground" />
                    <span class="text-xs font-bold">{{ fb.voteCount }}</span>
                  </div>
                </td>
                <!-- Title -->
                <td class="px-4 py-4 overflow-hidden">
                  <div class="flex flex-col max-w-full">
                    <span class="text-sm font-bold group-hover:text-primary transition-colors truncate">{{ fb.title }}</span>
                    <span class="text-[11px] text-muted-foreground truncate">{{ fb.excerpt }}</span>
                  </div>
                </td>
                <!-- Board -->
                <td class="px-4 py-4">
                  <span v-if="fb.boardId" class="text-xs font-medium text-muted-foreground bg-muted px-2 py-1 rounded">
                    {{ boardMap.get(fb.boardId) ?? 'Unknown' }}
                  </span>
                  <span v-else class="text-xs italic text-muted-foreground">—</span>
                </td>
                <!-- Author -->
                <td class="px-4 py-4">
                  <div class="flex items-center gap-2">
                    <img
                      v-if="fb.author?.image"
                      :src="fb.author.image"
                      :alt="fb.author.name"
                      class="w-6 h-6 rounded-full object-cover shrink-0"
                      referrerpolicy="no-referrer"
                    >
                    <div
                      v-else
                      class="w-6 h-6 rounded-full bg-accent flex items-center justify-center text-accent-foreground font-bold text-[9px]"
                    >
                      {{ initials(fb.author?.name) }}
                    </div>
                    <span class="text-xs font-medium truncate">{{ fb.author?.name ?? 'Anonymous' }}</span>
                  </div>
                </td>
                <!-- Comments -->
                <td class="px-4 py-4">
                  <div class="flex items-center gap-1 text-xs font-bold text-muted-foreground">
                    <Icon name="lucide:message-square" size="14" />
                    {{ fb.commentCount }}
                  </div>
                </td>
                <!-- Created -->
                <td class="px-4 py-4">
                  <span class="text-xs font-medium text-muted-foreground">{{ formatDate(fb.createdAt) }}</span>
                </td>
                <!-- Status -->
                <td class="px-4 py-4">
                  <span
                    class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border"
                    :style="{
                      color: `var(${(STATUS_CONFIG[fb.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open).cssVar})`,
                      backgroundColor: `var(${(STATUS_CONFIG[fb.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open).cssVar}-bg)`,
                      borderColor: `var(${(STATUS_CONFIG[fb.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open).cssVar}-border)`,
                    }"
                  >
                    {{ (STATUS_CONFIG[fb.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open).label }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </template>
      </div>

      <!-- Pagination -->
      <div v-if="pagination.total > 0" class="h-14 md:h-16 px-4 md:px-6 border-t border-border flex items-center justify-between bg-card">
        <span class="hidden md:block text-xs text-muted-foreground font-medium">
          Showing {{ (pagination.page - 1) * pagination.pageSize + 1 }} to {{ Math.min(pagination.page * pagination.pageSize, pagination.total) }} of {{ pagination.total }} entries
        </span>
        <span class="md:hidden text-xs text-muted-foreground font-medium">
          {{ pagination.total }} entries
        </span>
        <div class="flex items-center gap-2">
          <button
            class="w-8 h-8 flex items-center justify-center rounded border border-border hover:bg-background disabled:opacity-50"
            :disabled="currentPage <= 1"
            @click="currentPage--"
          >
            <Icon name="lucide:chevron-left" size="16" />
          </button>
          <button
            v-for="page in pageNumbers"
            :key="page"
            class="w-8 h-8 flex items-center justify-center rounded text-xs font-bold"
            :class="currentPage === page
              ? 'bg-primary text-primary-foreground'
              : 'border border-border hover:bg-background'"
            @click="currentPage = page"
          >
            {{ page }}
          </button>
          <button
            class="w-8 h-8 flex items-center justify-center rounded border border-border hover:bg-background disabled:opacity-50"
            :disabled="currentPage >= totalPages"
            @click="currentPage++"
          >
            <Icon name="lucide:chevron-right" size="16" />
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Modals -->
  <SubmitModal v-model:open="showSubmit" :default-board-id="filterBoardId" @created="refreshPosts()" />
  <PostDetailModal v-model:open="showDetail" :slug="detailSlug" @updated="onPostUpdated" @deleted="onPostDeleted" />
</template>


<script setup lang="ts">
definePageMeta({ layout: 'dashboard', middleware: 'admin' })

const boardStore = useBoardStore()
const postDetailStore = usePostDetailStore()
await callOnce(() => boardStore.fetchBoards())
const { boards, boardMap } = storeToRefs(boardStore)
const formatDate = useFormatDate()
const { t } = useI18n()

// ---- Filter system ----

type FieldKey = 'status' | 'boardId' | 'author' | 'created' | 'merged'

const { data: authorsData } = await useFetch<{ data: { id: string, name: string | null, email: string | null, image: string | null }[] }>('/api/admin/posts/authors')
const authors = computed(() => authorsData.value?.data ?? [])

const fieldDefs = computed(() => [
  {
    key: 'status' as FieldKey, kind: 'enum' as const, label: t('dashboard.filter.status'), icon: 'lucide:activity',
    options: STATUS_OPTIONS.map(o => ({ value: o.value, label: t(statusLabelKey(o.value)), color: o.color })),
  },
  {
    key: 'boardId' as FieldKey, kind: 'enum' as const, label: t('dashboard.filter.board'), icon: 'lucide:layers',
    options: [
      ...boards.value.map(b => ({ value: b.id, label: b.name })),
      { value: 'none', label: t('dashboard.filter.noBoard') },
    ],
  },
  {
    key: 'author' as FieldKey, kind: 'enum' as const, label: t('dashboard.filter.author'), icon: 'lucide:user', searchable: true,
    options: authors.value.map(a => ({ value: a.id, label: a.name || a.email || a.id, sub: a.email || '', image: a.image })),
  },
  { key: 'created' as FieldKey, kind: 'date' as const, label: t('dashboard.filter.created'), icon: 'lucide:calendar', options: [] },
  {
    key: 'merged' as FieldKey, kind: 'single' as const, label: t('dashboard.filter.merged'), icon: 'lucide:git-merge',
    options: [
      { value: 'canonical_only', label: t('dashboard.feedback.canonicalOnly') },
      { value: 'merged_only', label: t('dashboard.feedback.mergedOnly') },
      { value: 'all', label: t('dashboard.all') },
    ],
  },
])

const route = useRoute()
const conditions = ref<FilterCondition[]>(parseFilterQuery(route.query as Record<string, unknown>))

const activeChips = computed(() =>
  conditions.value
    .map(c => ({ condition: c, def: fieldDefs.value.find(d => d.key === c.field)! }))
    .filter(x => x.def))

const availableFields = computed(() => {
  const used = new Set(conditions.value.map(c => c.field))
  return fieldDefs.value.filter(d => !used.has(d.key))
})

function blankCondition(key: FieldKey): FilterCondition {
  return key === 'created'
    ? { field: 'created', op: 'after' }
    : key === 'merged'
      ? { field: 'merged', value: '' }
      : { field: key as EnumFilterField, op: 'is', values: [] }
}

function hasValue(c: FilterCondition) {
  if (c.field === 'created') return Boolean(c.from || c.to)
  if (c.field === 'merged') return Boolean(c.value)
  return c.values.length > 0
}

const pickingField = ref<FieldKey | null>(null)
const draft = ref<FilterCondition | null>(null)

const picking = computed(() => {
  const def = fieldDefs.value.find(d => d.key === pickingField.value)
  return def && draft.value ? { def, condition: draft.value } : null
})

function startPicking(key: FieldKey) {
  pickingField.value = key
  draft.value = blankCondition(key)
}

function resetPicking() {
  pickingField.value = null
  draft.value = null
}

// Also removes: unchecking the last value must drop the condition, not leave an empty chip.
function patchDraft(patch: Record<string, unknown>) {
  if (!draft.value) return
  const next = { ...draft.value, ...patch } as FilterCondition
  draft.value = next
  const rest = conditions.value.filter(c => c.field !== next.field)
  conditions.value = hasValue(next) ? [...rest, next] : rest
}

function patchCondition(field: string, patch: Record<string, unknown>) {
  conditions.value = conditions.value.map(c => (c.field === field ? { ...c, ...patch } as FilterCondition : c))
}

function removeCondition(field: string) {
  conditions.value = conditions.value.filter(c => c.field !== field)
}

function clearAllFilters() {
  conditions.value = []
}

const defaultBoardId = computed(() => {
  const v = railValue(conditions.value, 'boardId')
  return v && v !== 'none' ? v : undefined
})

function pickRail(field: EnumFilterField, value: string) {
  conditions.value = toggleRail(conditions.value, field, value)
}

const addFilterOpen = ref(false)

// ---- Sort & Pagination ----
const sortBy = ref<'createdAt' | 'votes' | 'comments'>(
  (['createdAt', 'votes', 'comments'].includes(route.query.sort as string) ? route.query.sort : 'createdAt') as 'createdAt' | 'votes' | 'comments')
const sortOrder = ref<'asc' | 'desc'>(route.query.order === 'asc' ? 'asc' : 'desc')
const currentPage = ref(Math.max(Number(route.query.page) || 1, 1))
const pageSize = 10

const searchTerm = ref((route.query.q as string) || '')
const searchActive = computed(() => searchTerm.value.length > 0)

watch([conditions, searchTerm], () => {
  currentPage.value = 1
}, { deep: true })

// replaceState, not the router — a push would re-run the route watchers and
// refetch a list we already have.
watch([conditions, searchTerm, sortBy, sortOrder, currentPage], () => {
  const qs = serializeFilterQuery(conditions.value, {
    q: searchTerm.value,
    sort: sortBy.value,
    order: sortOrder.value,
    page: currentPage.value,
  })
  window.history.replaceState(window.history.state, '', qs ? `${route.path}?${qs}` : route.path)
}, { deep: true })

// While searching, route to the additive /search endpoint; otherwise use the
// standard list endpoint. Both return PagePaginatedList<PostListItem>.
const apiUrl = computed(() => searchActive.value ? '/api/admin/posts/search' : '/api/admin/posts')

// Fetch data
const { data: postsData, refresh: refreshPosts, status: fetchStatus } = await useFetch<PagePaginatedList<PostListItem>>(apiUrl, {
  query: computed(() => filterApiQuery(conditions.value, {
    q: searchTerm.value || undefined,
    sort: sortBy.value,
    order: sortOrder.value,
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
  sortOrder.value = sortBy.value === col && sortOrder.value === 'desc' ? 'asc' : 'desc'
  sortBy.value = col
  currentPage.value = 1
}


const { authorName } = useAuthorDisplay()

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

  const dropped = (field: EnumFilterField, value: string) => {
    const c = findCondition(conditions.value, field)
    if (!c || c.field === 'created' || c.field === 'merged' || !c.values.length) return false
    return c.op === 'is' ? !c.values.includes(value) : c.values.includes(value)
  }
  if ((updated.status !== undefined && dropped('status', updated.status))
    || (updated.boardId !== undefined && dropped('boardId', updated.boardId ?? 'none'))) {
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
      <h2 class="hidden sm:block font-heading text-lg font-bold">{{ $t('dashboard.feedback.title') }}</h2>
      <div class="hidden md:block h-4 w-[1px] bg-border" />
      <span class="hidden md:block text-xs font-medium text-muted-foreground">{{ $t('dashboard.feedback.subtitle') }}</span>
    </div>
    <div class="flex items-center gap-3">
      <!-- Search: persistent, filters the table in place -->
      <AdminFeedbackSearch v-model="searchTerm" />

      <!-- Filters button -->
      <DropdownMenu v-model:open="addFilterOpen" @update:open="resetPicking">
        <DropdownMenuTrigger as-child>
          <button
            class="h-9 px-3 rounded-lg border border-border bg-background text-xs font-heading font-bold text-muted-foreground hover:text-foreground hover:border-primary transition-all flex items-center gap-2"
          >
            <Icon name="lucide:filter" size="16" />
            {{ $t('dashboard.feedback.filtersBtn') }}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" :class="picking ? 'min-w-[220px] max-w-[320px]' : 'w-48'">
          <template v-if="picking">
            <button
              class="w-full flex items-center gap-1.5 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors border-b border-border"
              @click="resetPicking"
            >
              <Icon name="lucide:chevron-left" size="12" class="shrink-0" />
              {{ picking.def.label }}
            </button>
            <FilterValuePanel
              :kind="picking.def.kind"
              :op="'op' in picking.condition ? picking.condition.op : 'is'"
              :values="'values' in picking.condition ? picking.condition.values : 'value' in picking.condition ? [picking.condition.value] : []"
              :from="'from' in picking.condition ? picking.condition.from : undefined"
              :to="'to' in picking.condition ? picking.condition.to : undefined"
              :options="picking.def.options"
              :searchable="'searchable' in picking.def && picking.def.searchable"
              @update:op="patchDraft({ op: $event })"
              @update:values="patchDraft(picking.def.kind === 'single' ? { value: $event[0] } : { values: $event })"
              @update:range="patchDraft($event)"
            />
          </template>
          <template v-else>
            <DropdownMenuItem
              v-for="def in availableFields"
              :key="def.key"
              class="cursor-pointer"
              @select.prevent="startPicking(def.key)"
            >
              <Icon :name="def.icon" size="14" class="mr-2" />
              {{ def.label }}
            </DropdownMenuItem>
            <p v-if="!availableFields.length" class="px-2 py-3 text-center text-[11px] text-muted-foreground">
              {{ $t('dashboard.filter.noFieldsLeft') }}
            </p>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>

      <!-- Create button -->
      <button
        class="h-9 px-3 sm:px-4 rounded-lg bg-primary text-primary-foreground text-xs font-heading font-bold hover:opacity-90 transition-all flex items-center gap-2 shrink-0"
        :aria-label="$t('dashboard.feedback.create')"
        @click="showSubmit = true"
      >
        <Icon name="lucide:plus" size="16" />
        <span class="hidden sm:inline">{{ $t('dashboard.feedback.create') }}</span>
      </button>
    </div>
  </header>

  <!-- Main content -->
  <div class="flex-1 flex min-h-0">
    <FeedbackQuickFilters
      :conditions="conditions"
      :boards="boards"
      @pick="pickRail"
      @clear="clearAllFilters"
    />
    <div class="flex-1 flex flex-col overflow-hidden bg-card min-w-0">
      <!-- Filter bar -->
      <div v-if="activeChips.length > 0" class="px-6 py-4 border-b border-border flex items-end justify-between gap-3 bg-background/30">
        <div class="flex flex-wrap items-center gap-2 min-w-0">
          <span class="hidden sm:inline text-[11px] font-bold text-muted-foreground uppercase tracking-wider mr-2 shrink-0">{{ $t('dashboard.feedback.activeFilters') }}</span>
          <FilterChip
            v-for="{ condition, def } in activeChips"
            :key="def.key"
            :label="def.label"
            :icon="def.icon"
            :kind="def.kind"
            :op="'op' in condition ? condition.op : 'is'"
            :values="'values' in condition ? condition.values : 'value' in condition ? [condition.value] : []"
            :from="'from' in condition ? condition.from : undefined"
            :to="'to' in condition ? condition.to : undefined"
            :options="def.options"
            :searchable="'searchable' in def && def.searchable"
            @update:op="patchCondition(def.key, { op: $event })"
            @update:values="patchCondition(def.key, def.kind === 'single' ? { value: $event[0] } : { values: $event })"
            @update:range="patchCondition(def.key, $event)"
            @remove="removeCondition(def.key)"
          />
        </div>
        <button
          class="relative inline-flex items-center h-7 shrink-0 text-[10px] font-bold text-muted-foreground hover:text-primary transition-colors underline underline-offset-2 after:absolute after:content-[''] after:-inset-x-3 after:-inset-y-2 sm:after:content-none"
          @click="clearAllFilters"
        >
          {{ $t('dashboard.feedback.clearAll') }}
        </button>
      </div>

      <!-- Data table -->
      <div class="flex-1 overflow-auto" :class="{ 'opacity-50 pointer-events-none': fetchStatus === 'pending' && posts.length > 0 }" style="transition: opacity 0.2s ease;">
        <!-- Loading -->
        <div v-if="fetchStatus === 'pending' && posts.length === 0" class="flex items-center justify-center py-16">
          <div class="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
        </div>

        <!-- Empty state -->
        <div v-else-if="posts.length === 0" class="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Icon :name="searchActive ? 'lucide:search-x' : 'lucide:inbox'" size="48" class="mb-4 opacity-50" />
          <p class="text-lg font-medium">
            {{ searchActive ? $t('dashboard.feedback.searchNoMatch', { query: searchTerm }) : $t('dashboard.feedback.noResults') }}
          </p>
          <p class="text-sm mt-1">
            {{ searchActive ? $t('dashboard.feedback.searchNoMatchHint') : $t('dashboard.feedback.noResultsHint') }}
          </p>
          <button
            v-if="conditions.length"
            class="mt-4 h-8 px-3 rounded-lg border border-border text-xs font-bold hover:text-primary hover:border-primary transition-colors"
            @click="clearAllFilters"
          >
            {{ $t('dashboard.feedback.clearAllFilters') }}
          </button>
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
                      {{ $t(statusLabelKey(fb.status)) }}
                    </span>
                    <span v-if="fb.boardId" class="text-[10px] font-medium text-muted-foreground">
                      {{ boardMap.get(fb.boardId) ?? $t('dashboard.feedback.unknownBoard') }}
                    </span>
                  </div>
                  <h4 class="text-sm font-bold truncate">{{ fb.title }}</h4>
                  <p class="text-[11px] text-muted-foreground truncate mt-0.5">{{ fb.excerpt }}</p>
                  <div class="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
                    <div class="flex items-center gap-1">
                      <UserAvatar :author="fb.author" :size="4" />
                      <span class="font-medium">{{ authorName(fb.author) }}</span>
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
          <table class="hidden md:table w-full text-left border-collapse min-w-[900px] table-fixed">
            <thead class="sticky top-0 bg-background border-b border-border z-10">
              <tr>
                <th
                  class="w-[72px] px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-primary transition-colors"
                  @click="toggleSort('votes')"
                >
                  <div class="flex items-center gap-1">
                    {{ $t('dashboard.feedback.colUpvotes') }}
                    <Icon v-if="sortBy === 'votes'" :name="sortOrder === 'asc' ? 'lucide:arrow-up' : 'lucide:arrow-down'" size="14" class="text-primary" />
                  </div>
                </th>
                <th class="w-1/4 px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('dashboard.feedback.colTitle') }}</th>
                <th class="w-[152px] px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('dashboard.feedback.colBoard') }}</th>
                <th class="w-[160px] px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('dashboard.feedback.colAuthor') }}</th>
                <th
                  class="w-[104px] px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-primary transition-colors"
                  @click="toggleSort('comments')"
                >
                  <div class="flex items-center gap-1">
                    {{ $t('dashboard.feedback.colComments') }}
                    <Icon v-if="sortBy === 'comments'" :name="sortOrder === 'asc' ? 'lucide:arrow-up' : 'lucide:arrow-down'" size="14" class="text-primary" />
                  </div>
                </th>
                <th
                  class="w-[122px] px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-primary transition-colors"
                  @click="toggleSort('createdAt')"
                >
                  <div class="flex items-center gap-1">
                    {{ $t('dashboard.feedback.colCreated') }}
                    <Icon v-if="sortBy === 'createdAt'" :name="sortOrder === 'asc' ? 'lucide:arrow-up' : 'lucide:arrow-down'" size="14" class="text-primary" />
                  </div>
                </th>
                <th class="w-[80px] px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{{ $t('dashboard.feedback.colStatus') }}</th>
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
                  <span
                    v-if="fb.boardId"
                    class="inline-block max-w-full truncate text-xs font-medium text-muted-foreground bg-muted px-2 py-1 rounded whitespace-nowrap"
                    :title="boardMap.get(fb.boardId) ?? $t('dashboard.feedback.unknownBoard')"
                  >
                    {{ boardMap.get(fb.boardId) ?? $t('dashboard.feedback.unknownBoard') }}
                  </span>
                  <span v-else class="text-xs italic text-muted-foreground">—</span>
                </td>
                <!-- Author -->
                <td class="px-4 py-4">
                  <div class="flex items-center gap-2">
                    <UserAvatar :author="fb.author" :size="6" />
                    <span class="text-xs font-medium truncate">{{ authorName(fb.author) }}</span>
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
                    {{ $t(statusLabelKey(fb.status)) }}
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
          {{ $t('dashboard.feedback.showing', { from: (pagination.page - 1) * pagination.pageSize + 1, to: Math.min(pagination.page * pagination.pageSize, pagination.total), total: pagination.total }) }}
        </span>
        <span class="md:hidden text-xs text-muted-foreground font-medium">
          {{ $t('dashboard.feedback.entriesShort', { total: pagination.total }) }}
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
  <SubmitModal v-model:open="showSubmit" :default-board-id="defaultBoardId" @created="refreshPosts()" />
  <PostDetailModal v-model:open="showDetail" :slug="detailSlug" @updated="onPostUpdated" @deleted="onPostDeleted" />
</template>


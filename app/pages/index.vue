<script setup lang="ts">
usePageOg({ kind: 'home' })
const portalOrg = usePortalOrg() // for the sr-only <h1> below
const branding = computed(() => portalOrg.value.branding)
const hasWelcome = computed(() => branding.value.welcomeTitle || branding.value.welcomeDescription)

// Auth & login modal
const { data: session } = useAuthSession()
const isLoggedIn = computed(() => !!session.value?.user)
const isSsoSession = computed(
  () => !!(session.value as { session?: { ssoOrgId?: string | null } } | null)?.session?.ssoOrgId,
)
const orgCtx = useOrgContext()
const canEditPortal = computed(() => !!session.value?.user && !!orgCtx.value.role && !isSsoSession.value)
const loginModal = useLoginModal()

// Board store
const boardStore = useBoardStore()
await callOnce(() => boardStore.fetchBoards())
const { boards, boardMap, totalPostCount } = storeToRefs(boardStore)

// Currently selected board and sort order
const route = useRoute()
const router = useRouter()
const activeBoardId = computed(() => (route.query.b as string) || null)
const sortBy = ref<'top' | 'recent'>('recent')

// Post list
const sort = computed(() => sortBy.value === 'top' ? 'votes' : 'createdAt')

const posts = ref<PostListItem[]>([])
const nextCursor = ref<string | null>(null)
const loadingMore = ref(false)
const fetchingPosts = ref(false)

// Loading indicator for board switching (top progress bar)
const { start: startLoading, finish: finishLoading } = useLoadingIndicator()

async function fetchPosts(cursor?: string) {
  const data = await useApiFetch<CursorPaginatedList<PostListItem>>('/api/posts', {
    query: {
      boardId: activeBoardId.value || undefined,
      sort: sort.value,
      pageSize: 10,
      cursor,
    },
  })
  return data
}

// Initial load
const initialData = await fetchPosts()
posts.value = initialData.data
nextCursor.value = initialData.pagination.nextCursor

const searchQuery = ref('')
const searching = ref(false)
const searchActive = computed(() => searchQuery.value.trim().length > 0)
const searchToolbar = ref<{ reset: () => void } | null>(null)
let boardSwitchClearing = false

// Reset list when filters change
watch(activeBoardId, async () => {
  if (searchActive.value) return
  startLoading()
  fetchingPosts.value = true
  try {
    const data = await fetchPosts()
    posts.value = data.data
    nextCursor.value = data.pagination.nextCursor
  } finally {
    finishLoading()
    fetchingPosts.value = false
  }
})

watch(sort, async () => {
  if (searchActive.value) return
  fetchingPosts.value = true
  try {
    const data = await fetchPosts()
    posts.value = data.data
    nextCursor.value = data.pagination.nextCursor
  } finally {
    fetchingPosts.value = false
  }
})

async function refreshPosts() {
  const data = await fetchPosts()
  posts.value = data.data
  nextCursor.value = data.pagination.nextCursor
}

watch(searchQuery, async () => {
  const q = searchQuery.value.trim()
  if (!q) {
    if (boardSwitchClearing) { boardSwitchClearing = false; return }
    await refreshPosts()
    return
  }
  searching.value = true
  try {
    const res = await useApiFetch<{ data: PostListItem[] }>('/api/posts/search', { query: { q } })
    posts.value = res.data
    nextCursor.value = null // search returns a flat capped set — no "load more"
  } finally {
    searching.value = false
  }
})

async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return
  loadingMore.value = true
  try {
    const data = await fetchPosts(nextCursor.value)
    posts.value.push(...data.data)
    nextCursor.value = data.pagination.nextCursor
  } finally {
    loadingMore.value = false
  }
}

// Switch board
async function selectBoard(boardId: string | null) {
  const wasCommitted = searchActive.value
  const sameBoard = activeBoardId.value === boardId
  searchToolbar.value?.reset()
  if (wasCommitted) {
    boardSwitchClearing = true
    searchQuery.value = ''
  }
  router.push({ query: boardId ? { b: boardId } : {} })
  if (wasCommitted && sameBoard) await refreshPosts()
}

// Status configuration (centralized)


// User initials
function initials(name: string | null) {
  return (name || '?').slice(0, 2).toUpperCase()
}

// Post detail store
const postDetailStore = usePostDetailStore()

// Modal controls
const showDetail = ref(false)
const showSubmit = ref(false)
const detailSlug = ref<string | null>(null)

// Open post detail modal with prefill from list data
function openPostDetail(item: PostListItem) {
  postDetailStore.prefill(item.slug, item)
  detailSlug.value = item.slug
  showDetail.value = true
}

// Local update handlers
function onPostUpdated(updated: { id: string; status?: string; boardId?: string | null; [key: string]: any }) {
  const idx = posts.value.findIndex(p => p.id === updated.id)
  if (idx === -1) return

  // Board changed → the sidebar's per-board counts (served from the board store)
  // are now stale. Compare against the pre-update boardId, then refresh the store.
  if (updated.boardId !== undefined && updated.boardId !== posts.value[idx].boardId) {
    void boardStore.fetchBoards()
  }

  // If status or board changed and no longer matches current filter, remove
  if (updated.boardId !== undefined && activeBoardId.value && updated.boardId !== activeBoardId.value) {
    posts.value.splice(idx, 1)
    return
  }

  // Update fields in place
  Object.assign(posts.value[idx], updated)
}

function onPostDeleted(postId: string) {
  const idx = posts.value.findIndex(p => p.id === postId)
  if (idx !== -1) posts.value.splice(idx, 1)
  // A deleted post drops its board's count (and the total) → refresh the store.
  void boardStore.fetchBoards()
}

// Vote / unvote on list items
async function handleVote(post: PostListItem) {
  if (!isLoggedIn.value) return loginModal.open()
  const wasVoted = post.hasVoted
  post.hasVoted = !wasVoted
  post.voteCount += wasVoted ? -1 : 1
  try {
    await useApiFetch(`/api/posts/${post.id}/vote`, {
      method: wasVoted ? 'DELETE' : 'POST',
    })
  } catch {
    post.hasVoted = wasVoted
    post.voteCount += wasVoted ? 1 : -1
  }
}
</script>

<template>
  <!-- Sr-only H1: the board layout has no visible page title, but SEO needs one. -->
  <h1 class="sr-only">{{ portalOrg.name }} Feedback</h1>

  <!-- Sidebar: Boards -->
  <aside class="w-full md:w-[280px] shrink-0 space-y-8">
    <div class="space-y-4">
      <div class="font-heading text-lg font-bold mb-4 md:mb-4 hidden md:block">Boards</div>

      <!-- Mobile: horizontal scrollable pills with fade edges -->
      <div class="md:hidden relative">
        <div class="font-heading text-sm font-bold text-muted-foreground uppercase tracking-wider mb-2">Boards</div>
        <div class="relative -mx-4">
          <nav class="flex gap-2 overflow-x-auto px-4" style="-ms-overflow-style: none; scrollbar-width: none;">
        <button
          class="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold transition-colors border"
          :class="!activeBoardId
            ? 'bg-primary text-primary-foreground border-primary'
            : 'bg-card text-muted-foreground border-border hover:border-primary hover:text-foreground'"
          @click="selectBoard(null)"
        >
          All
          <span class="text-xs opacity-70">{{ totalPostCount }}</span>
        </button>
        <button
          v-for="b in boards"
          :key="b.id"
          class="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold transition-colors border"
          :class="activeBoardId === b.id
            ? 'bg-primary text-primary-foreground border-primary'
            : 'bg-card text-muted-foreground border-border hover:border-primary hover:text-foreground'"
          @click="selectBoard(b.id)"
        >
          {{ b.name }}
          <span class="text-xs opacity-70">{{ b.postCount ?? 0 }}</span>
        </button>
          </nav>
          <!-- Fade edges -->
          <div class="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-background to-transparent" />
          <div class="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-background to-transparent" />
        </div>
      </div>

      <!-- Desktop: vertical list -->
      <nav class="hidden md:flex flex-col gap-2">
        <!-- All Feedback -->
        <button
          class="flex items-center justify-between px-4 py-3 rounded-lg font-medium transition-colors w-full text-left"
          :class="!activeBoardId
            ? 'bg-secondary text-primary'
            : 'text-muted-foreground hover:bg-card hover:text-foreground'"
          @click="selectBoard(null)"
        >
          <div class="flex items-center gap-3">
            <Icon name="lucide:layout-grid" size="18" />
            <span>All Feedback</span>
          </div>
          <span
            class="text-xs px-2 py-0.5 rounded-full font-bold"
            :class="!activeBoardId ? 'bg-card text-primary shadow-sm' : 'bg-background'"
          >
            {{ totalPostCount }}
          </span>
        </button>

        <!-- Individual boards -->
        <button
          v-for="b in boards"
          :key="b.id"
          class="flex items-center justify-between px-4 py-3 rounded-lg font-medium transition-colors w-full text-left"
          :class="activeBoardId === b.id
            ? 'bg-secondary text-primary'
            : 'text-muted-foreground hover:bg-card hover:text-foreground'"
          @click="selectBoard(b.id)"
        >
          <div class="flex items-center gap-3">
            <Icon name="lucide:folder" size="18" />
            <span>{{ b.name }}</span>
          </div>
          <span
            class="text-xs px-2 py-0.5 rounded-full font-bold"
            :class="activeBoardId === b.id ? 'bg-card text-primary shadow-sm' : 'bg-background'"
          >
            {{ b.postCount ?? 0 }}
          </span>
        </button>
      </nav>

      <!-- Keep "Powered by FeedLog" as one inline run so the flex gap only spaces
           the icon (a gap between the text node and the brand span would read as a
           stray space). Quiet prefix + emphasized brand give the badge hierarchy. -->
      <a
        href="https://feedlog.ai"
        target="_blank"
        rel="noreferrer"
        class="group hidden md:inline-flex items-center gap-1.5 px-4 pt-2 text-xs text-muted-foreground/70 hover:text-foreground transition-colors"
      >
        <Icon name="lucide:zap" size="12" class="opacity-60 transition-opacity group-hover:opacity-100" />
        <span>Powered by <span class="font-semibold text-foreground/75 transition-colors group-hover:text-foreground">FeedLog</span></span>
      </a>
    </div>
  </aside>

  <!-- Main content: Feedback area -->
  <section class="flex-1 min-w-0 flex flex-col gap-6">
    <PortalWelcomeBlock
      v-if="hasWelcome"
      :title="branding.welcomeTitle"
      :description="branding.welcomeDescription"
      :editable="canEditPortal"
    />

    <!-- Header row -->
    <BoardSearchToolbar
      ref="searchToolbar"
      v-model="searchQuery"
      v-model:sort="sortBy"
      @new-request="isLoggedIn ? (showSubmit = true) : loginModal.open()"
    />

    <!-- Post list with loading state -->
    <div :class="{ 'opacity-50 pointer-events-none': fetchingPosts || searching }" class="transition-opacity duration-200">

    <!-- Empty state -->
    <div v-if="posts.length === 0" class="flex flex-col items-center justify-center py-16 text-muted-foreground">
      <!-- Search yielded nothing: nudge toward raising it (duplicate-prevention payoff) -->
      <template v-if="searchActive">
        <Icon name="lucide:search-x" size="48" class="mb-4 opacity-50" />
        <p class="text-lg font-medium">No matches for “{{ searchQuery.trim() }}”</p>
        <p class="fl-empty__hint">Nobody’s raised this yet — be the first.</p>
        <Button
          class="h-10 px-4 rounded-lg text-[15px] font-heading font-semibold"
          @click="isLoggedIn ? showSubmit = true : loginModal.open()"
        >
          <Icon name="lucide:plus" size="18" />
          New Request
        </Button>
      </template>
      <template v-else>
        <Icon name="lucide:inbox" size="48" class="mb-4 opacity-50" />
        <p class="text-lg font-medium">No feedback yet</p>
      </template>
    </div>

    <!-- Feedback card list -->
    <div v-else class="flex flex-col gap-4">
      <article
        v-for="p in posts"
        :key="p.id"
        class="feedback-card flex items-stretch gap-4 bg-card border border-border rounded-lg p-4 cursor-pointer"
        @click="openPostDetail(p)"
      >
        <!-- Upvote button -->
        <button
          class="upvote-btn w-[56px] h-[64px] shrink-0 rounded-md flex flex-col items-center justify-center gap-1 border focus:outline-none"
          :class="p.hasVoted
            ? 'bg-primary text-primary-foreground border-primary shadow-sm'
            : 'bg-background text-foreground border-border hover:border-primary hover:text-primary transition-colors'"
          @click.stop="handleVote(p)"
        >
          <Icon name="lucide:chevron-up" size="24" />
          <span class="font-heading font-bold text-[15px] leading-none">{{ p.voteCount }}</span>
        </button>

        <!-- Card content -->
        <div class="flex-1 flex flex-col justify-center min-w-0 py-1">
          <!-- Status badge + Board -->
          <div class="flex items-center gap-2 mb-1">
            <span
              v-if="p.status && p.status !== 'open' && STATUS_CONFIG[p.status as keyof typeof STATUS_CONFIG]"
              class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border"
              :style="{
                color: `var(${STATUS_CONFIG[p.status as keyof typeof STATUS_CONFIG].cssVar})`,
                backgroundColor: `var(${STATUS_CONFIG[p.status as keyof typeof STATUS_CONFIG].cssVar}-bg)`,
                borderColor: `var(${STATUS_CONFIG[p.status as keyof typeof STATUS_CONFIG].cssVar}-border)`,
              }"
            >
              {{ STATUS_CONFIG[p.status as keyof typeof STATUS_CONFIG]?.label }}
            </span>
            <span v-if="p.boardId && boardMap.get(p.boardId)" class="text-xs font-medium text-muted-foreground">
              {{ p.status && p.status !== 'open' ? '•' : '' }} {{ boardMap.get(p.boardId) }}
            </span>
          </div>

          <!-- Title -->
          <div class="flex items-center gap-2 mb-1.5">
            <h3 class="font-heading text-lg font-bold leading-tight truncate">
              {{ p.title }}
            </h3>
            <!-- <span v-if="p.mergedCount > 0" class="inline-flex items-center gap-0.5 text-[10px] font-bold text-muted-foreground bg-secondary px-1.5 py-0.5 rounded shrink-0">
              <Icon name="lucide:git-merge" size="10" /> {{ p.mergedCount }}
            </span> -->
          </div>

          <!-- Excerpt -->
          <p class="text-sm text-muted-foreground line-clamp-2 break-all">
            {{ p.excerpt }}
          </p>

          <!-- Bottom meta -->
          <div class="flex items-center gap-4 mt-3 text-xs text-muted-foreground font-medium">
            <div class="flex items-center gap-1.5">
              <Icon name="lucide:message-square" size="14" />
              <span>{{ p.commentCount }} comments</span>
            </div>
            <div class="flex items-center gap-2">
              <img v-if="p.author?.image" :src="p.author.image" :alt="p.author.name" class="w-5 h-5 rounded-full object-cover shrink-0" referrerpolicy="no-referrer">
              <div v-else class="w-5 h-5 rounded-full bg-foreground/10 flex items-center justify-center text-foreground font-bold text-[9px] shrink-0">
                {{ initials(p.author?.name) }}
              </div>
              <div class="flex items-center gap-1.5">
                <Icon name="lucide:clock" size="14" />
                <span>{{ timeAgo(p.createdAt) }}</span>
              </div>
            </div>
          </div>
        </div>
      </article>
    </div>

    </div>

    <!-- Load More -->
    <div v-if="nextCursor" class="flex justify-center mt-6">
      <button
        class="px-6 py-2.5 rounded-full border border-border text-sm font-heading font-semibold hover:border-primary hover:text-primary transition-colors bg-card shadow-warm disabled:opacity-50"
        :disabled="loadingMore"
        @click="loadMore"
      >
        {{ loadingMore ? 'Loading...' : 'Load More' }}
      </button>
    </div>
  </section>

  <!-- Post detail modal -->
  <PostDetailModal v-model:open="showDetail" :slug="detailSlug" @updated="onPostUpdated" @deleted="onPostDeleted" />

  <!-- Submit feedback modal -->
  <SubmitModal v-model:open="showSubmit" :default-board-id="activeBoardId ?? undefined" @created="refreshPosts()" />
</template>

<style scoped>
.upvote-btn {
  transition: all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

.feedback-card {
  transition: box-shadow 0.2s ease;
}

.feedback-card:hover {
  box-shadow: var(--shadow-warm);
}

nav::-webkit-scrollbar {
  display: none;
}

.fl-empty__hint {
  font-size: 14px;
  margin: 4px 0 20px;
  color: var(--muted-foreground);
}
</style>

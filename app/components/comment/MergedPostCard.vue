<script setup lang="ts">

const props = defineProps<{
  comment: CommentItem
  isAdmin?: boolean
}>()

const emit = defineEmits<{
  unmerge: [postId: string]
  loadMoreComments: [postId: string, cursor: string]
}>()

const localePath = useLocalePath()
const timeAgo = useTimeAgo()
const mp = computed(() => props.comment.mergedPost)
const subComments = computed(() => {
  const base = mp.value?.comments.data ?? []
  const postId = mp.value?.post.id
  const extra = postId ? (extraSubComments.value[postId]?.data ?? []) : []
  return [...base, ...extra]
})
const hasMoreSub = computed(() => {
  const postId = mp.value?.post.id
  if (!postId) return false
  const extra = extraSubComments.value[postId]
  // If we've started lazy-loading, use extra's cursor; otherwise use initial pagination
  if (extra) return extra.cursor !== null
  return !!mp.value?.comments.pagination.nextCursor
})
const loadingMore = ref(false)

// Extra sub-comments loaded via pagination (for first-level merged post)
const extraSubComments = ref<Record<string, { data: any[]; cursor: string | null }>>({})

async function loadMoreSubComments() {
  const postId = mp.value?.post.id
  if (!postId || loadingMore.value) return

  const extra = extraSubComments.value[postId]
  const cursor = extra?.cursor ?? mp.value?.comments.pagination.nextCursor
  if (!cursor) return

  loadingMore.value = true
  try {
    const res = await useApiFetch<{ data: any[]; pagination: { nextCursor: string | null } }>(
      `/api/posts/${postId}/comments`,
      { params: { sort: 'oldest', limit: 5, withChildren: 'false', cursor } },
    )
    const prev = extra?.data ?? []
    extraSubComments.value[postId] = {
      data: [...prev, ...res.data],
      cursor: res.pagination.nextCursor,
    }
  } finally {
    loadingMore.value = false
  }
}

// Track lazily-loaded comments for second-level merged posts (keyed by post id)
const level2Comments = ref<Record<string, { data: any[]; loading: boolean; cursor: string | null }>>({})

function initials(name: string | null) {
  return (name || '?').slice(0, 2).toUpperCase()
}

function handleUnmerge() {
  const postId = mp.value?.post.id
  if (postId) emit('unmerge', postId)
}

async function loadLevel2Comments(postId: string) {
  const state = level2Comments.value[postId]
  const cursor = state?.cursor ?? undefined
  if (state?.loading) return

  level2Comments.value[postId] = { data: state?.data ?? [], loading: true, cursor: state?.cursor ?? null }
  try {
    const res = await useApiFetch<{ data: any[]; pagination: { nextCursor: string | null } }>(
      `/api/posts/${postId}/comments`,
      { params: { sort: 'oldest', limit: 5, withChildren: 'false', ...(cursor ? { cursor } : {}) } },
    )
    const prev = level2Comments.value[postId]?.data ?? []
    level2Comments.value[postId] = {
      data: [...prev, ...res.data],
      loading: false,
      cursor: res.pagination.nextCursor,
    }
  } catch {
    level2Comments.value[postId] = { ...level2Comments.value[postId], loading: false }
  }
}
</script>

<template>
  <div v-if="mp" class="relative flex flex-col gap-4">
    <div class="flex gap-4">
      <!-- Avatar -->
      <div class="w-10 h-10 rounded-full shrink-0 flex items-center justify-center shadow-sm relative overflow-visible">
        <img
          v-if="comment.author.image"
          :src="comment.author.image"
          :alt="comment.author.name"
          class="w-10 h-10 rounded-full object-cover"
          referrerpolicy="no-referrer"
        >
        <div v-else class="w-10 h-10 rounded-full bg-foreground/10 flex items-center justify-center text-foreground font-bold text-sm">
          {{ initials(comment.author.name) }}
        </div>
      </div>

      <div class="flex-1 min-w-0">
        <!-- Header with merge badge -->
        <div class="flex items-center flex-wrap gap-2 mb-3">
          <span class="font-heading font-bold text-sm">{{ comment.author.name }}</span>
          <span class="text-xs text-muted-foreground">{{ timeAgo(comment.createdAt) }}</span>
          <span class="text-xs font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-md flex items-center gap-1 ml-1">
            <Icon name="lucide:git-merge" size="14" />
            {{ $t('post.merge.mergedPostBy', { name: comment.author.name }) }}
          </span>

          <!-- Admin unmerge menu -->
          <DropdownMenu v-if="isAdmin">
            <DropdownMenuTrigger as-child>
              <button class="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors ml-auto">
                <Icon name="lucide:more-horizontal" size="18" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="min-w-[120px]">
              <DropdownMenuItem class="text-xs font-bold gap-2" @click="handleUnmerge">
                <Icon name="lucide:git-branch" size="14" />
                {{ $t('post.merge.unmerge') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <!-- Merged post card -->
        <div class="bg-card border border-border rounded-lg p-5 shadow-sm space-y-3">
          <NuxtLink :to="localePath(`/p/${mp.post.slug}`)" class="font-heading font-bold text-lg text-foreground hover:text-primary block">
            {{ mp.post.title }}
          </NuxtLink>
          <p v-if="mp.post.excerpt" class="text-sm text-foreground/80 leading-relaxed">{{ mp.post.excerpt }}</p>
        </div>
      </div>
    </div>

    <!-- Sub-post comments (indented with left border line, read-only) -->
    <div v-if="subComments.length > 0" class="ml-10 space-y-4 relative comment-thread">
      <template v-for="sc in subComments" :key="sc.id">
        <!-- Second-level merged post card -->
        <div v-if="sc.type === 'mergedPost' && sc.mergedPost?.post" class="flex gap-4">
          <div class="w-10 h-10 rounded-full shrink-0 flex items-center justify-center shadow-sm relative z-10">
            <img
              v-if="sc.author.image"
              :src="sc.author.image"
              :alt="sc.author.name"
              class="w-10 h-10 rounded-full object-cover"
              referrerpolicy="no-referrer"
            >
            <div v-else class="w-10 h-10 rounded-full bg-foreground/10 flex items-center justify-center text-foreground font-bold text-sm">
              {{ initials(sc.author.name) }}
            </div>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center flex-wrap gap-2 mb-3">
              <span class="font-heading font-bold text-sm">{{ sc.author.name }}</span>
              <span class="text-xs text-muted-foreground">{{ timeAgo(sc.createdAt) }}</span>
              <span class="text-xs font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-md flex items-center gap-1 ml-1">
                <Icon name="lucide:git-merge" size="14" />
                {{ $t('post.merge.mergedPost') }}
              </span>

              <!-- Admin unmerge menu for second-level -->
              <DropdownMenu v-if="isAdmin">
                <DropdownMenuTrigger as-child>
                  <button class="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors ml-auto">
                    <Icon name="lucide:more-horizontal" size="18" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="min-w-[120px]">
                  <DropdownMenuItem class="text-xs font-bold gap-2" @click="emit('unmerge', sc.mergedPost!.post.id)">
                    <Icon name="lucide:git-branch" size="14" />
                    {{ $t('post.merge.unmerge') }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div class="bg-card border border-border rounded-lg p-5 shadow-sm space-y-2">
              <NuxtLink :to="localePath(`/p/${sc.mergedPost.post.slug}`)" class="font-heading font-bold text-base text-foreground hover:text-primary block">
                {{ sc.mergedPost.post.title }}
              </NuxtLink>
              <p v-if="sc.mergedPost.post.excerpt" class="text-sm text-foreground/80 leading-relaxed">{{ sc.mergedPost.post.excerpt }}</p>
            </div>

            <!-- Lazily loaded comments for this second-level post -->
            <div v-if="level2Comments[sc.mergedPost.post.id]?.data?.length" class="mt-3 space-y-3">
              <div v-for="l2c in level2Comments[sc.mergedPost.post.id].data" :key="l2c.id" class="flex gap-3">
                <div class="w-8 h-8 rounded-full shrink-0 flex items-center justify-center shadow-sm">
                  <img v-if="l2c.author.image" :src="l2c.author.image" :alt="l2c.author.name" class="w-8 h-8 rounded-full object-cover" referrerpolicy="no-referrer">
                  <div v-else class="w-8 h-8 rounded-full bg-foreground/10 flex items-center justify-center text-foreground font-bold text-xs">{{ initials(l2c.author.name) }}</div>
                </div>
                <div class="flex-1 min-w-0 bg-card border border-border rounded-lg p-3 shadow-sm">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="font-heading font-bold text-xs">{{ l2c.author.name }}</span>
                    <span class="text-[10px] text-muted-foreground">{{ timeAgo(l2c.createdAt) }}</span>
                  </div>
                  <p class="text-sm text-foreground/90">{{ l2c.content }}</p>
                </div>
              </div>
            </div>

            <!-- Load comments button -->
            <button
              v-if="sc.mergedPost.post.commentCount > 0 && (!level2Comments[sc.mergedPost.post.id] || level2Comments[sc.mergedPost.post.id].loading || level2Comments[sc.mergedPost.post.id].cursor !== null)"
              class="text-xs font-bold text-muted-foreground hover:text-primary transition-colors mt-2 inline-flex items-center gap-1.5"
              :disabled="level2Comments[sc.mergedPost.post.id]?.loading"
              @click="loadLevel2Comments(sc.mergedPost.post.id)"
            >
              {{ level2Comments[sc.mergedPost.post.id]?.data?.length ? $t('post.merge.loadMoreComments') : $t('post.merge.loadComments', { count: sc.mergedPost.post.commentCount }) }}
              <Icon v-if="level2Comments[sc.mergedPost.post.id]?.loading" name="lucide:loader-2" size="12" class="animate-spin" />
            </button>
          </div>
        </div>

        <!-- Regular sub-comment -->
        <div v-else class="flex gap-4">
          <div class="w-10 h-10 rounded-full shrink-0 flex items-center justify-center shadow-sm relative z-10">
            <img
              v-if="sc.author.image"
              :src="sc.author.image"
              :alt="sc.author.name"
              class="w-10 h-10 rounded-full object-cover"
              referrerpolicy="no-referrer"
            >
            <div v-else class="w-10 h-10 rounded-full bg-foreground/10 flex items-center justify-center text-foreground font-bold text-sm">
              {{ initials(sc.author.name) }}
            </div>
          </div>
          <div class="flex-1 min-w-0 bg-card border border-border rounded-lg p-4 shadow-sm">
            <div class="flex items-center gap-2 mb-2">
              <span class="font-heading font-bold text-sm">{{ sc.author.name }}</span>
              <span class="text-xs text-muted-foreground">{{ timeAgo(sc.createdAt) }}</span>
            </div>
            <p class="text-sm text-foreground/90">{{ sc.content }}</p>
          </div>
        </div>
      </template>

      <!-- Load more sub-comments -->
      <button
        v-if="hasMoreSub"
        class="text-xs font-bold text-muted-foreground hover:text-primary transition-colors ml-14 inline-flex items-center gap-1.5"
        :disabled="loadingMore"
        @click="loadMoreSubComments"
      >
        {{ $t('post.merge.loadMoreComments') }}
        <Icon v-if="loadingMore" name="lucide:loader-2" size="12" class="animate-spin" />
      </button>
    </div>
  </div>
</template>

<style scoped>
/* .comment-thread::before {
  content: '';
  position: absolute;
  left: 20px;
  top: 48px;
  bottom: 0;
  width: 2px;
  background-color: var(--color-border);
} */
</style>

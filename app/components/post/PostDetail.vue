<script setup lang="ts">
import '~/assets/css/md-editor-preview.css'
import { toast } from 'vue-sonner'
import { sanitizeAttachmentHtml } from '~/utils/attachment';

// Event types for post mutations
export interface PostUpdatedEvent {
  id: string
  slug: string
  title?: string
  content?: string
  excerpt?: string
  status?: string
  boardId?: string | null
}

const props = defineProps<{
  slug: string
}>()

const emit = defineEmits<{
  updated: [post: PostUpdatedEvent]
  deleted: [postId: string]
}>()

const { onUploadImg } = useUploadImg()
const store = usePostDetailStore()
const boardStore = useBoardStore()
const { boards } = storeToRefs(boardStore)

// Derive data from store using slug
const post = computed(() => store.getPost(props.slug))
const comments = computed(() => store.getComments(props.slug))
const hasMoreComments = computed(() => !!store.getCommentCursor(props.slug))
const loading = computed(() => store.isPostLoading(props.slug))
const commentLoading = useDebouncedLoading(computed(() => store.isCommentLoading(props.slug)))
const moreCommentLoading = computed(() => store.isMoreCommentLoading(props.slug))

// Comment sort is local UI state
const commentSort = ref<'newest' | 'oldest' | 'top'>('newest')

// Auth & login modal
const { data: session } = useAuthSession()
const isLoggedIn = computed(() => !!session.value?.user)
const loginModal = useLoginModal()

// Permissions
const postAuthorId = computed(() => post.value?.author?.id)
const { canEdit: canEditPost, canDelete: canDeletePost, isOrgManager, showMenu: showPostMenu } = usePermission(postAuthorId, 'post')


function initials(name: string | null) {
  return (name || '?').slice(0, 2).toUpperCase()
}

// Board name
const boardName = computed(() => {
  if (!post.value?.boardId) return null
  return boardStore.boardMap.get(post.value.boardId) ?? null
})

// ---- Post editing state ----
const editing = ref(false)
const editTitle = ref('')
const editContent = ref('')
const editSaving = ref(false)
const editError = ref('')
const { confirm } = useConfirmDialog()
const deleting = ref(false)

function startEditPost() {
  if (!post.value) return
  editTitle.value = post.value.title
  editContent.value = post.value.content
  editError.value = ''
  editing.value = true
  replyingTo.value = null
  editingCommentId.value = null
}

function cancelEditPost() {
  editing.value = false
  editError.value = ''
}

async function saveEditPost() {
  if (!post.value) return
  const title = editTitle.value.trim()
  const content = editContent.value.trim()
  if (!title) { editError.value = 'Title is required'; return }
  if (!content) { editError.value = 'Content is required'; return }

  editSaving.value = true
  editError.value = ''
  try {
    await store.updatePost(props.slug, { title, content }, isOrgManager.value)
    editing.value = false
    emit('updated', { id: post.value.id, slug: post.value.slug, title, content })
  } catch (e: any) {
    editError.value = e.data?.message || 'Failed to save'
  } finally {
    editSaving.value = false
  }
}

async function handleDeletePost() {
  if (!post.value) return
  const ok = await confirm({
    title: 'Delete this post?',
    description: 'This action cannot be undone. This will permanently delete the post and all its comments.',
    confirmText: 'Delete',
    variant: 'destructive',
  })
  if (!ok) return
  const postId = post.value.id
  deleting.value = true
  try {
    await store.deletePost(props.slug)
    emit('deleted', postId)
  } catch (e: any) {
    editError.value = e.data?.message || 'Failed to delete'
  } finally {
    deleting.value = false
  }
}

// ---- Admin sidebar actions ----
async function handleStatusChange(status: string) {
  if (!post.value || !isOrgManager.value) return
  await store.updatePost(props.slug, { status }, true)
  emit('updated', { id: post.value.id, slug: post.value.slug, status })
}

async function handleBoardChange(boardId: string | null) {
  if (!post.value || !isOrgManager.value) return
  await store.updatePost(props.slug, { boardId }, true)
  emit('updated', { id: post.value.id, slug: post.value.slug, boardId })
}

// ---- Merge state ----
const isMerged = computed(() => !!post.value?.mergedTo)
const mergedCount = computed(() => post.value?.mergedCount ?? 0)
const mergeDialogOpen = ref(false)
const mergeDirection = ref<'bring' | 'push'>('bring')

function openMergeDialog(direction: 'bring' | 'push') {
  mergeDirection.value = direction
  mergeDialogOpen.value = true
}

async function handleMerged() {
  // Refresh post data after merge
  await store.fetchPost(props.slug)
  await store.fetchComments(props.slug, commentSort.value)
}

async function handleUnmerge(postId: string) {
  try {
    await useApiFetch('/api/admin/posts/unmerge', { method: 'POST', body: { postId } })
    await store.fetchPost(props.slug)
    await store.fetchComments(props.slug, commentSort.value)
  } catch (e: any) {
    console.error('Unmerge failed:', e)
  }
}

async function handleSimilarMerge(direction: 'bring' | 'push', targetPost: any) {
  if (!post.value) return
  const body = direction === 'bring'
    ? { canonicalPostId: post.value.id, mergedPostId: targetPost.id }
    : { canonicalPostId: targetPost.id, mergedPostId: post.value.id }

  try {
    await useApiFetch('/api/admin/posts/merge', { method: 'POST', body })
    await handleMerged()
  } catch (e: any) {
    console.error('Merge failed:', e)
  }
}

// ---- Vote handler ----
function handleVote() {
  if (!post.value) return
  if (isMerged.value) return // Block voting on merged posts
  if (!isLoggedIn.value) return loginModal.open()
  if (post.value.hasVoted) {
    store.unvote(props.slug)
  } else {
    store.vote(props.slug)
  }
}

// ---- Comment interaction state ----
const replyingTo = ref<{ commentId: string; parentId: string } | null>(null)
const editingCommentId = ref<string | null>(null)
const commentSubmitting = ref(false)
const commentEditorRef = ref<{ clear: () => void } | null>(null)

// Comment handlers
async function handleCommentSubmit(content: string) {
  commentSubmitting.value = true
  try {
    await store.addComment(props.slug, content)
    commentEditorRef.value?.clear()
  } finally {
    commentSubmitting.value = false
  }
}

async function handleReplySubmit(content: string) {
  if (!replyingTo.value) return
  commentSubmitting.value = true
  try {
    const { parentId, commentId } = replyingTo.value
    const replyToId = commentId !== parentId ? commentId : undefined
    await store.addComment(props.slug, content, parentId, replyToId)
    replyingTo.value = null
  } finally {
    commentSubmitting.value = false
  }
}

function handleReply(commentId: string) {
  if (!isLoggedIn.value) return loginModal.open()

  editingCommentId.value = null
  editing.value = false

  const topLevel = comments.value.find(c => c.id === commentId)
  if (topLevel) {
    replyingTo.value = { commentId, parentId: commentId }
  } else {
    const parent = comments.value.find(c => c.children?.some(ch => ch.id === commentId))
    if (parent) {
      replyingTo.value = { commentId, parentId: parent.id }
    }
  }
}

function handleLike(commentId: string) {
  if (!isLoggedIn.value) return loginModal.open()

  const c = comments.value.find(item => item.id === commentId)
    || comments.value.flatMap(item => item.children ?? []).find(ch => ch.id === commentId)
  if (!c) return
  if (c.hasLiked) {
    store.unlikeComment(props.slug, commentId)
  } else {
    store.likeComment(props.slug, commentId)
  }
}

function handleEditComment(commentId: string) {
  replyingTo.value = null
  editing.value = false
  editingCommentId.value = commentId
}

async function handleEditCommentSubmit(commentId: string, content: string) {
  commentSubmitting.value = true
  try {
    await store.updateComment(props.slug, commentId, content)
    editingCommentId.value = null
  } finally {
    commentSubmitting.value = false
  }
}

function handleEditCommentCancel() {
  editingCommentId.value = null
}

async function handleDeleteComment(commentId: string) {
  await store.deleteComment(props.slug, commentId)
}

// Watch comment sort changes → refetch
watch(commentSort, () => {
  store.fetchComments(props.slug, commentSort.value)
})

async function handleShare() {
  // Canonical post URL — independent of current location (post may be opened in a modal)
  const url = `${window.location.origin}/p/${props.slug}`
  try {
    await navigator.clipboard.writeText(url)
    toast.success('Link copied to clipboard')
  } catch {
    toast.error('Failed to copy link')
  }
}
</script>

<template>
  <!-- Single stable root for SSR hydration -->
  <template v-if="loading && !post">
    <div class="flex-1 min-w-0">
      <div class="bg-card border border-border rounded-lg p-6 lg:p-8 shadow-sm animate-pulse">
        <div class="flex gap-6">
          <div class="w-14 h-[72px] rounded-md bg-muted"></div>
          <div class="flex-1 space-y-3">
            <div class="h-4 bg-muted rounded w-1/3"></div>
            <div class="h-6 bg-muted rounded w-2/3"></div>
            <div class="h-4 bg-muted rounded w-full"></div>
            <div class="h-4 bg-muted rounded w-4/5"></div>
          </div>
        </div>
      </div>
    </div>
    <aside class="w-full md:w-[320px] shrink-0 self-start">
      <div class="bg-card border border-border rounded-lg p-6 shadow-sm animate-pulse space-y-6">
        <div class="h-4 bg-muted rounded w-1/2"></div>
        <div class="h-10 bg-muted rounded"></div>
        <div class="h-4 bg-muted rounded w-1/2"></div>
        <div class="h-6 bg-muted rounded w-1/3"></div>
      </div>
    </aside>
  </template>

  <!-- Content: use v-if (not v-else-if) so SSR always renders this when post exists -->
  <template v-if="post">
    <!-- Left column: post card + discussion -->
    <div class="flex-1 min-w-0 space-y-6">
      <!-- Post card -->
      <div class="bg-card border border-border rounded-lg p-6 lg:p-8 shadow-sm">
        <div class="flex flex-col md:flex-row gap-6">
          <div v-if="!isMerged" class="flex flex-row md:flex-col items-center gap-3 shrink-0">
            <button
              class="upvote-btn w-14 h-[72px] rounded-md flex flex-col items-center justify-center gap-1 shadow-md border transition-transform hover:scale-105"
              :class="post.hasVoted
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-foreground border-border hover:border-primary hover:text-primary'"
              @click="handleVote"
            >
              <Icon name="lucide:chevron-up" size="28" />
              <span class="font-heading font-bold text-lg">{{ post.voteCount }}</span>
            </button>
            <p class="text-[10px] font-bold uppercase tracking-wider text-muted-foreground text-center">Upvotes</p>
          </div>
          <div class="flex-1 min-w-0">
            <template v-if="editing">
              <div class="space-y-4">
                <Input v-model="editTitle" class="h-10 text-lg font-heading font-bold" placeholder="Title" :maxlength="200" />
                <div class="editor-preview-styled">
                  <ThemedMdEditor v-model="editContent" language="en-US" placeholder="Edit your post..." :preview="false" :max-length="10000" :toolbars="['bold', 'italic', 'strikeThrough', '-', 'title', 'unorderedList', 'orderedList', '-', 'link', 'image', 'code', 'codeRow', '-', 'previewOnly']" :sanitize="sanitizeAttachmentHtml" :style="{ height: '280px' }" @on-upload-img="onUploadImg" />
                </div>
                <p v-if="editError" class="text-sm text-destructive">{{ editError }}</p>
                <div class="flex items-center gap-3 justify-end">
                  <button class="px-4 py-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground transition-colors" @click="cancelEditPost">Cancel</button>
                  <button class="px-5 py-2 rounded-md bg-primary text-primary-foreground text-sm font-heading font-bold hover:bg-primary/90 transition-colors disabled:opacity-50" :disabled="editSaving" @click="saveEditPost">{{ editSaving ? 'Saving...' : 'Save Changes' }}</button>
                </div>
              </div>
            </template>
            <template v-else>
              <div class="flex items-start gap-3 mb-3">
                <div class="flex-1 min-w-0 flex items-center gap-2">
                  <h2 class="font-heading text-2xl font-bold">{{ post.title }}</h2>
                  <!-- <span v-if="mergedCount > 0" class="inline-flex items-center gap-1 text-xs font-bold text-muted-foreground bg-secondary px-2 py-0.5 rounded-md shrink-0">
                    <Icon name="lucide:git-merge" size="12" /> {{ mergedCount }}
                  </span> -->
                </div>
                <div class="flex items-center gap-2 shrink-0 pt-1">
                  <span class="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <Icon name="lucide:clock" size="14" /> {{ timeAgo(post.createdAt) }}
                  </span>
                  <DropdownMenu v-if="isOrgManager && !isMerged">
                    <DropdownMenuTrigger as-child>
                      <button class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors" title="Merge"><Icon name="lucide:git-merge" size="18" /></button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" class="min-w-[200px]">
                      <DropdownMenuItem class="text-xs font-bold gap-2" @click="openMergeDialog('bring')"><Icon name="lucide:arrow-down-left" size="14" /> Merge to this post</DropdownMenuItem>
                      <DropdownMenuItem class="text-xs font-bold gap-2" @click="openMergeDialog('push')"><Icon name="lucide:arrow-up-right" size="14" /> Merge this post into...</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu v-if="showPostMenu">
                    <DropdownMenuTrigger as-child>
                      <button class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"><Icon name="lucide:more-horizontal" size="18" /></button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" class="min-w-[120px]">
                      <DropdownMenuItem v-if="canEditPost" class="text-xs font-bold gap-2" @click="startEditPost"><Icon name="lucide:pencil" size="14" /> Edit</DropdownMenuItem>
                      <DropdownMenuItem v-if="canDeletePost" class="text-xs font-bold gap-2 text-destructive" @click="handleDeletePost"><Icon name="lucide:trash-2" size="14" /> Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              <PostContent v-if="post.content" :content="post.content" />
              <div v-else class="h-20 bg-muted rounded animate-pulse" />
            </template>
          </div>
        </div>
      </div>

      <!-- Discussion -->
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <h3 class="font-heading text-lg font-bold flex items-center gap-2">
            <Icon name="lucide:message-square" size="20" /> Discussion ({{ post.commentCount }})
          </h3>
          <div class="flex items-center gap-2 bg-border/20 p-1 rounded-md">
            <button v-for="s in (['newest', 'oldest', 'top'] as const)" :key="s" class="px-3 py-1 text-[11px] font-medium rounded-md capitalize transition-colors" :class="commentSort === s ? 'bg-card shadow-sm text-foreground font-bold' : 'text-muted-foreground hover:text-foreground'" @click="commentSort = s">{{ s === 'newest' ? 'Newest' : s === 'oldest' ? 'Oldest' : 'Top' }}</button>
          </div>
        </div>
        <!-- Merge banner (inside discussion, per PRD) -->
        <MergeBanner v-if="isMerged && post.canonicalPost" :canonical-post="post.canonicalPost" />
        <ClientOnly v-if="!isMerged">
          <CommentEditor v-if="isLoggedIn" ref="commentEditorRef" :loading="commentSubmitting" @submit="handleCommentSubmit" />
          <CommentLoginPrompt v-else />
        </ClientOnly>
        <div v-if="commentLoading && comments.length === 0" class="space-y-4 pt-2">
          <div v-for="i in 3" :key="i" class="flex gap-4 animate-pulse">
            <div class="w-10 h-10 rounded-full bg-muted shrink-0" />
            <div class="flex-1 bg-card border border-border rounded-lg p-4 space-y-2">
              <div class="h-3 bg-muted rounded w-1/4" /><div class="h-4 bg-muted rounded w-full" /><div class="h-4 bg-muted rounded w-3/4" />
            </div>
          </div>
        </div>
        <div v-else-if="comments.length > 0" class="space-y-4 pt-2 transition-opacity duration-200" :class="commentLoading ? 'opacity-60 pointer-events-none' : ''">
          <template v-for="comment in comments" :key="comment.id">
            <CommentItem :comment="comment" :replying-to="replyingTo?.parentId === comment.id ? replyingTo.commentId : undefined" :editing-id="editingCommentId ?? undefined" :submitting="commentSubmitting" @reply="handleReply" @like="handleLike" @reply-submit="handleReplySubmit" @reply-cancel="replyingTo = null" @edit="handleEditComment" @edit-submit="handleEditCommentSubmit" @edit-cancel="handleEditCommentCancel" @delete="handleDeleteComment" @load-more-children="store.loadMoreChildren(slug, $event)" @unmerge="handleUnmerge" />
          </template>
        </div>
        <div v-else class="flex flex-col items-center justify-center py-12 text-center">
          <Icon name="lucide:message-circle" size="48" class="text-muted-foreground/40 mb-4" />
          <p class="text-sm font-medium text-muted-foreground">No comments yet</p>
          <p class="text-xs text-muted-foreground/60 mt-1">Be the first to share your thoughts</p>
        </div>
        <div v-if="hasMoreComments" class="flex justify-center mt-8">
          <button class="px-6 py-2.5 rounded-full border border-border text-sm font-heading font-semibold hover:border-primary hover:text-primary transition-colors bg-card shadow-warm" :disabled="moreCommentLoading" @click="store.loadMoreComments(slug, commentSort)">{{ moreCommentLoading ? 'Loading...' : 'View more comments' }}</button>
        </div>
      </div>
    </div>

    <!-- Right sidebar -->
    <aside class="w-full md:w-[320px] shrink-0 self-start space-y-4">
      <div class="bg-card border border-border rounded-lg p-6 shadow-sm space-y-4">
        <div>
          <h4 class="font-heading text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-2">Board</h4>
          <DropdownMenu v-if="isOrgManager && !isMerged">
            <DropdownMenuTrigger as-child>
              <button class="flex items-center gap-3 hover:bg-secondary/50 p-2 -ml-2 rounded-md transition-colors">
                <Icon name="lucide:folder" size="16" class="text-primary shrink-0" /><span class="font-bold text-sm">{{ boardName ?? 'None' }}</span><Icon name="lucide:chevron-down" size="14" class="text-muted-foreground shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="min-w-[200px]">
              <DropdownMenuItem class="text-xs font-medium gap-2" :class="!post.boardId ? 'font-bold' : ''" @click="handleBoardChange(null)">
                <span class="w-4 shrink-0 flex items-center justify-center"><Icon v-if="!post.boardId" name="lucide:check" size="12" /></span> None
              </DropdownMenuItem>
              <DropdownMenuItem v-for="board in boards" :key="board.id" class="text-xs font-medium gap-2" :class="post.boardId === board.id ? 'font-bold' : ''" @click="handleBoardChange(board.id)">
                <span class="w-4 shrink-0 flex items-center justify-center"><Icon v-if="post.boardId === board.id" name="lucide:check" size="12" /></span> {{ board.name }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div v-else class="flex items-center gap-3 p-2 -ml-2"><Icon name="lucide:folder" size="16" class="text-primary shrink-0" /><span class="font-bold text-sm">{{ boardName ?? 'None' }}</span></div>
        </div>
        <!-- Status: hidden for merged posts -->
        <div v-if="!isMerged">
          <h4 class="font-heading text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-2">Status</h4>
          <DropdownMenu v-if="isOrgManager">
            <DropdownMenuTrigger as-child>
              <button class="flex items-center gap-3 hover:bg-secondary/50 p-2 -ml-2 rounded-md transition-colors">
                <div class="w-3 h-3 rounded-full" :style="{ backgroundColor: `var(${(STATUS_CONFIG[post.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open).cssVar})` }" />
                <span class="font-bold text-sm">{{ (STATUS_CONFIG[post.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open).label }}</span><Icon name="lucide:chevron-down" size="14" class="text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="min-w-[160px]">
              <DropdownMenuItem v-for="opt in STATUS_OPTIONS" :key="opt.value" class="text-xs font-medium gap-2" :class="post.status === opt.value ? 'font-bold' : ''" @click="handleStatusChange(opt.value)">
                <span class="w-4 shrink-0 flex items-center justify-center"><Icon v-if="post.status === opt.value" name="lucide:check" size="12" /></span>
                <div class="w-2.5 h-2.5 rounded-full" :style="{ backgroundColor: `var(${opt.cssVar})` }"></div> {{ opt.label }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div v-else class="flex items-center gap-3">
            <div class="w-3 h-3 rounded-full" :style="{ backgroundColor: `var(${(STATUS_CONFIG[post.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open).cssVar})` }" />
            <span class="font-bold text-sm">{{ (STATUS_CONFIG[post.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open).label }}</span>
          </div>
        </div>
        <div>
          <h4 class="font-heading text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-3">Author</h4>
          <div class="flex items-center gap-3">
            <img v-if="post.author?.image" :src="post.author.image" :alt="post.author.name" class="w-8 h-8 rounded-full object-cover shrink-0" referrerpolicy="no-referrer">
            <div v-else class="w-8 h-8 rounded-full bg-foreground/10 flex items-center justify-center text-foreground font-bold text-xs shrink-0">{{ initials(post.author?.name) }}</div>
            <p class="text-sm font-bold">{{ post.author?.name ?? 'Anonymous' }}</p>
          </div>
        </div>
        <div class="pt-2 flex flex-col gap-2">
          <!-- Subscribe to Updates — hidden until the notification backend lands; unhide when ready
          <Button variant="secondary" :disabled="isMerged" :class="isMerged ? 'opacity-50 cursor-not-allowed' : ''"><Icon name="lucide:bell" size="18" /> Subscribe to Updates</Button>
          -->
          <Button variant="outline" class="text-primary" :disabled="isMerged" :class="isMerged ? 'opacity-50 cursor-not-allowed' : ''" @click="handleShare"><Icon name="lucide:share-2" size="18" /> Share Request</Button>
        </div>
      </div>
      <SimilarPostsPanel v-if="post.id && !isMerged" :post-id="post.id" :is-admin="isOrgManager" @merge="handleSimilarMerge" />
    </aside>

    <!-- Merge dialog -->
    <MergeDialog v-if="post.id" v-model:open="mergeDialogOpen" :post-id="post.id" :post-title="post.title" :direction="mergeDirection" @merged="handleMerged" />
  </template>
</template>

<style scoped>
.upvote-btn {
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}
</style>

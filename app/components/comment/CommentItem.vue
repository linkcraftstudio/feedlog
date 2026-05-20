<script setup lang="ts">
defineOptions({ name: 'CommentItem' })

const props = defineProps<{
  comment: CommentItem
  depth?: number
  replyingTo?: string // commentId that is being replied to
  editingId?: string // commentId that is being edited
  submitting?: boolean
  replyAuthorMap?: Map<string, string> // commentId → author name, for @username display
}>()

const emit = defineEmits<{
  reply: [commentId: string]
  like: [commentId: string]
  replySubmit: [content: string]
  replyCancel: []
  edit: [commentId: string]
  editSubmit: [commentId: string, content: string]
  editCancel: []
  delete: [commentId: string]
  loadMoreChildren: [parentId: string]
  unmerge: [postId: string]
}>()

const isMergedPost = computed(() => props.comment.type === 'mergedPost')

const hasMoreChildren = computed(() => {
  const c = props.comment
  return !props.depth && (c.replyCount ?? 0) > (c.children?.length ?? 0)
})

const authorId = computed(() => props.comment.author?.id)
const { canEdit, canDelete, showMenu } = usePermission(authorId, 'comment')

const isEditing = computed(() => props.editingId === props.comment.id)

// Build author map for children (only at top-level)
const childReplyAuthorMap = computed(() => {
  if (props.depth) return undefined
  const map = new Map<string, string>()
  for (const child of props.comment.children ?? []) {
    if (child.author?.name) {
      map.set(child.id, child.author.name)
    }
  }
  return map
})

// Resolve @username for flattened replies
const replyToName = computed(() => {
  const { replyToId, parentId } = props.comment
  if (!replyToId || replyToId === parentId) return null
  return props.replyAuthorMap?.get(replyToId) ?? null
})

// Delete confirmation
const { confirm } = useConfirmDialog()

async function handleDelete() {
  const ok = await confirm({
    title: 'Delete this comment?',
    description: 'This action cannot be undone. This will permanently delete the comment and all its replies.',
    confirmText: 'Delete',
    variant: 'destructive',
  })
  if (!ok) return
  emit('delete', props.comment.id)
}

function initials(name: string | null) {
  return (name || '?').slice(0, 2).toUpperCase()
}

</script>

<template>
  <!-- Merged post type: render MergedPostCard instead -->
  <MergedPostCard
    v-if="isMergedPost"
    :comment="comment"
    :is-admin="usePermission(computed(() => ''), 'post').isOrgManager.value"
    @unmerge="$emit('unmerge', $event)"
  />

  <!-- Regular comment -->
  <div v-else class="relative flex flex-col gap-4">
    <div class="flex gap-4" :class="depth ? 'ml-10' : ''">
      <!-- Avatar -->
      <img
        v-if="comment.author?.image"
        :src="comment.author.image"
        :alt="comment.author.name"
        class="shrink-0 rounded-full object-cover shadow-sm"
        :class="depth ? 'w-8 h-8' : 'w-10 h-10'"
        referrerpolicy="no-referrer"
      >
      <div
        v-else
        class="shrink-0 rounded-full bg-accent flex items-center justify-center text-accent-foreground font-bold shadow-sm"
        :class="depth ? 'w-8 h-8 text-xs' : 'w-10 h-10 text-sm'"
      >
        {{ initials(comment.author?.name) }}
      </div>

      <!-- Content -->
      <div
        class="flex-1 rounded-lg shadow-sm"
        :class="depth ? 'bg-secondary/30 border border-primary/10 p-3' : 'bg-card border border-border p-4'"
      >
        <div class="flex items-center gap-2 mb-2">
          <span class="font-heading font-bold" :class="depth ? 'text-xs' : 'text-sm'">
            {{ comment.author?.name ?? 'Anonymous' }}
          </span>
          <span v-if="replyToName" class="inline-flex items-center gap-0.5 text-muted-foreground" :class="depth ? 'text-[10px]' : 'text-xs'">
            <Icon name="lucide:corner-down-right" :size="depth ? '10' : '12'" />
            <span class="font-medium">@{{ replyToName }}</span>
          </span>
          <span :class="depth ? 'text-[10px]' : 'text-xs'" class="text-muted-foreground">
            {{ timeAgo(comment.createdAt) }}
          </span>
          <span v-if="comment.editedAt" class="text-[10px] text-muted-foreground italic">
            (edited)
          </span>

          <!-- Three-dot menu -->
          <DropdownMenu v-if="showMenu">
            <DropdownMenuTrigger as-child>
              <button class="ml-auto p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors">
                <Icon name="lucide:more-horizontal" :size="depth ? '14' : '16'" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="min-w-[120px]">
              <DropdownMenuItem v-if="canEdit" class="text-xs font-bold gap-2" @click="$emit('edit', comment.id)">
                <Icon name="lucide:pencil" size="14" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem v-if="canDelete" class="text-xs font-bold gap-2 text-destructive focus:text-destructive" @click="handleDelete">
                <Icon name="lucide:trash-2" size="14" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <!-- Edit mode -->
        <template v-if="isEditing">
          <CommentEditor
            :initial-content="comment.content"
            :placeholder="'Edit your comment...'"
            :loading="submitting"
            @submit="$emit('editSubmit', comment.id, $event)"
            @cancel="$emit('editCancel')"
          />
        </template>

        <!-- Read mode -->
        <template v-else>
          <CommentContent :content="comment.content" />
          <div class="flex items-center gap-4" :class="depth ? 'mt-3' : 'mt-4'">
            <Button
              variant="subtle"
              size="xs"
              class="font-bold text-primary"
              :class="depth ? 'text-[11px]' : ''"
              @click="$emit('reply', comment.id)"
            >
              <Icon name="lucide:reply" :size="depth ? '12' : '14'" /> Reply
            </Button>
            <Button
              variant="subtle"
              size="xs"
              class="font-bold"
              :class="[
                depth ? 'text-[11px]' : '',
                comment.hasLiked ? 'text-primary' : '',
              ]"
              @click="$emit('like', comment.id)"
            >
              <Icon name="lucide:thumbs-up" class="translate-y-[-1px]" :size="depth ? '12' : '14'" /> {{ comment.likeCount }}
            </Button>
          </div>
        </template>
      </div>
    </div>

    <!-- Reply editor for this top-level comment -->
    <div v-if="!depth && replyingTo === comment.id" class="ml-14">
      <CommentEditor
        :parent-id="comment.id"
        :reply-to-id="comment.id"
        placeholder="Write a reply..."
        :loading="submitting"
        @submit="$emit('replySubmit', $event)"
        @cancel="$emit('replyCancel')"
      />
    </div>

    <!-- Nested replies (recursive) -->
    <template v-for="reply in comment.children" :key="reply.id">
      <CommentItem
        :comment="reply"
        :depth="(depth || 0) + 1"
        :reply-author-map="childReplyAuthorMap"
        :replying-to="replyingTo"
        :editing-id="editingId"
        :submitting="submitting"
        @reply="$emit('reply', $event)"
        @like="$emit('like', $event)"
        @reply-submit="$emit('replySubmit', $event)"
        @reply-cancel="$emit('replyCancel')"
        @edit="$emit('edit', $event)"
        @edit-submit="(id: string, content: string) => $emit('editSubmit', id, content)"
        @edit-cancel="$emit('editCancel')"
        @delete="$emit('delete', $event)"
        @load-more-children="$emit('loadMoreChildren', $event)"
      />

      <!-- Reply editor for this child comment -->
      <div v-if="replyingTo === reply.id" class="ml-20">
        <CommentEditor
          :parent-id="comment.id"
          :reply-to-id="reply.id"
          placeholder="Write a reply..."
          :loading="submitting"
          @submit="$emit('replySubmit', $event)"
          @cancel="$emit('replyCancel')"
        />
      </div>
    </template>

    <!-- Load more children -->
    <div v-if="hasMoreChildren" class="ml-14">
      <button
        class="text-xs font-bold text-muted-foreground hover:text-primary transition-colors"
        @click="$emit('loadMoreChildren', comment.id)"
      >
        View {{ (comment.replyCount ?? 0) - (comment.children?.length ?? 0) }} more replies
      </button>
    </div>

  </div>
</template>

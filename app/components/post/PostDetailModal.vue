<script setup lang="ts">

import type { PostUpdatedEvent } from './PostDetail.vue'
import { preventShadcnDialogClose } from '~/lib/md-editor-helper';

const props = defineProps<{
  slug?: string | null
}>()

const open = defineModel<boolean>('open', { default: false })

const emit = defineEmits<{
  updated: [post: PostUpdatedEvent]
  deleted: [postId: string]
}>()

const localePath = useLocalePath()
const store = usePostDetailStore()

watch(open, (isOpen) => {
  if (isOpen && props.slug) {
    store.fetchPost(props.slug)
    store.fetchComments(props.slug)
  }
}, { immediate: true })

</script>

<template>
  <!-- Keep non-modal so md-editor/medium-zoom overlays teleported to body stay interactive -->
  <Dialog v-model:open="open" :modal="true">
    <DialogContent
      :show-close-button="false"
      @open-auto-focus.prevent
      @pointer-down-outside="preventShadcnDialogClose"
      @escape-key-down="preventShadcnDialogClose"
      class="!max-w-[1100px] h-[90vh] !p-0 !gap-0 overflow-hidden border-border bg-background !rounded-2xl flex flex-col"
    >
      <!-- Modal header -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-border bg-card shrink-0">
        <div class="flex items-center gap-3">
          <AppLogo :size="32" />
          <DialogTitle class="font-heading text-lg font-bold tracking-tight">
            {{ $t('post.detail.modalTitle') }}
          </DialogTitle>
        </div>
        <div class="flex items-center gap-2">
          <NuxtLink
            v-if="slug"
            :to="localePath(`/p/${slug}`)"
            class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-secondary transition-colors text-muted-foreground hover:text-primary"
            :title="$t('post.detail.openInPage')"
            @click="open = false"
          >
            <Icon name="lucide:external-link" size="18" />
          </NuxtLink>
          <DialogClose class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-secondary transition-colors text-muted-foreground hover:text-primary">
            <Icon name="lucide:x" size="20" />
          </DialogClose>
        </div>
      </div>

      <!-- Modal content: scrollable -->
      <div class="overflow-y-auto flex-1">
        <div class="flex flex-col md:flex-row gap-8 p-4 sm:p-6 lg:p-8">
          <PostDetail
            v-if="slug"
            :slug="slug"
            @updated="emit('updated', $event)"
            @deleted="(postId) => { emit('deleted', postId); open = false }"
          />
        </div>
      </div>

      <DialogDescription class="sr-only">
        {{ $t('post.detail.modalDescription') }}
      </DialogDescription>
    </DialogContent>
  </Dialog>
</template>

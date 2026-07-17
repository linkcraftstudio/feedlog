<script setup lang="ts">
import type { SimilarPost } from '#layers/feedlog/server/utils/similar'

const props = defineProps<{
  postId: string
  isAdmin?: boolean
}>()

const emit = defineEmits<{
  merge: [direction: 'bring' | 'push', targetPost: SimilarPost]
}>()

const localePath = useLocalePath()
const similarPosts = ref<SimilarPost[]>([])
const loading = ref(false)
const expanded = ref(false)

async function fetchSimilar(limit = 3) {
  loading.value = true
  try {
    const { data } = await useApiFetch<{ data: SimilarPost[] }>(`/api/posts/${props.postId}/similar?limit=${limit}`)
    similarPosts.value = data
  } catch {
    similarPosts.value = []
  } finally {
    loading.value = false
  }
}

async function handleExpand() {
  expanded.value = true
  await fetchSimilar(10)
}

onMounted(() => fetchSimilar())

function statusConfig(status: string) {
  return STATUS_CONFIG[status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open
}
</script>

<template>
  <div class="bg-card border border-border rounded-lg p-6 shadow-sm flex flex-col gap-4">
    <h3 class="font-heading text-[11px] font-bold text-muted-foreground uppercase tracking-wider">{{ $t('post.similar.panelTitle') }}</h3>

    <!-- Loading -->
    <div v-if="loading && similarPosts.length === 0" class="space-y-3">
      <div v-for="i in 3" :key="i" class="animate-pulse space-y-1.5 py-3">
        <div class="h-3.5 bg-muted rounded w-3/4" />
        <div class="h-2.5 bg-muted rounded w-full" />
        <div class="flex gap-3 mt-1.5">
          <div class="h-2.5 bg-muted rounded w-8" />
          <div class="h-2.5 bg-muted rounded w-8" />
        </div>
      </div>
    </div>

    <!-- Empty -->
    <p v-else-if="similarPosts.length === 0 && !loading" class="text-xs text-muted-foreground py-2">
      {{ $t('post.similar.empty') }}
    </p>

    <!-- List -->
    <div v-else class="flex flex-col">
      <div
        v-for="sp in similarPosts"
        :key="sp.id"
        class="group py-4 first:pt-0 border-b border-border/40 last:border-b-0"
      >
        <div class="flex items-start justify-between gap-2">
          <NuxtLink :to="localePath(`/p/${sp.slug}`)" class="text-sm font-bold hover:text-primary transition-colors leading-relaxed flex-1 min-w-0 break-words">
            {{ sp.title }}
          </NuxtLink>
          <!-- Admin merge button -->
          <DropdownMenu v-if="isAdmin">
            <DropdownMenuTrigger as-child>
              <button
                class="flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
                :title="$t('post.merge.tooltip')"
              >
                <Icon name="lucide:git-merge" size="18" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="min-w-[180px]">
              <DropdownMenuItem class="text-xs font-bold gap-2" @click="emit('merge', 'bring', sp)">
                <Icon name="lucide:arrow-down-left" size="14" />
                {{ $t('post.merge.intoCurrent') }}
              </DropdownMenuItem>
              <DropdownMenuItem class="text-xs font-bold gap-2" @click="emit('merge', 'push', sp)">
                <Icon name="lucide:arrow-up-right" size="14" />
                {{ $t('post.merge.currentInto') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <p v-if="sp.excerpt" class="text-[11px] text-muted-foreground line-clamp-1 mt-0.5 mb-2.5">{{ sp.excerpt }}</p>
        <div class="flex items-center gap-3">
          <span class="flex items-center gap-1 text-[10px] font-bold text-muted-foreground">
            <Icon name="lucide:chevron-up" size="14" /> {{ sp.voteCount }}
          </span>
          <span class="flex items-center gap-1 text-[10px] font-bold text-muted-foreground">
            <Icon name="lucide:message-square" size="14" /> {{ sp.commentCount }}
          </span>
          <span
            class="ml-auto inline-flex items-center px-1.5 py-px rounded-full text-[8px] font-bold uppercase tracking-wider border"
            :style="{
              color: `var(${statusConfig(sp.status).cssVar})`,
              backgroundColor: `var(${statusConfig(sp.status).cssVar}-bg)`,
              borderColor: `var(${statusConfig(sp.status).cssVar}-border)`,
            }"
          >
            {{ $t(statusLabelKey(sp.status)) }}
          </span>
        </div>
      </div>
    </div>

    <!-- Expand link -->
    <div v-if="!expanded && similarPosts.length >= 3" class="flex justify-center pt-2">
      <button
        class="inline-flex items-center gap-1 text-xs font-bold text-muted-foreground hover:text-primary transition-colors py-1 group/link"
        @click="handleExpand"
      >
        {{ $t('post.similar.expandAll') }}
        <Icon name="lucide:chevron-right" size="16" class="group-hover/link:translate-x-0.5 transition-transform" />
      </button>
    </div>
  </div>
</template>

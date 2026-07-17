<script setup lang="ts">
import type { SimilarPost } from '#layers/feedlog/server/utils/similar'

const props = defineProps<{
  similarPosts: SimilarPost[]
  loading?: boolean
  defaultExpanded?: boolean
}>()

const emit = defineEmits<{
  select: [post: SimilarPost]
}>()

const expanded = ref(false)
const visible = computed(() => props.loading || props.similarPosts.length > 0)
const hasResults = computed(() => props.similarPosts.length > 0)

// When results arrive, expand with animation
watch(hasResults, (has) => {
  if (has) {
    expanded.value = props.defaultExpanded ?? true
  }
})

defineExpose({ expanded })

function statusConfig(status: string) {
  return STATUS_CONFIG[status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open
}
</script>

<template>
  <!-- Outer wrapper: animates the entire panel in/out -->
  <div
    class="grid transition-[grid-template-rows] duration-300 ease-in-out shrink-0"
    :class="visible ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
  >
  <div class="overflow-hidden">
  <div
    class="border border-border rounded-lg shadow-sm transition-opacity duration-300"
    :class="visible ? 'opacity-100' : 'opacity-0'"
  >
    <!-- Header (toggle) -->
    <button
      class="w-full flex items-center justify-between cursor-pointer select-none px-3.5 py-2.5"
      @click="expanded = !expanded"
    >
      <div class="flex items-center gap-2 text-primary">
        <Icon name="lucide:sparkles" size="16" />
        <h3 class="text-[12px] font-bold tracking-wide font-heading">
          {{ loading && similarPosts.length === 0 ? $t('post.similar.finding') : $t('post.similar.found', { count: similarPosts.length }) }}
        </h3>
        <Spinner v-if="loading" class="w-3 h-3 text-primary/50" />
      </div>
      <Icon
        name="lucide:chevron-down"
        size="16"
        class="text-muted-foreground/60 transition-transform duration-250"
        :class="expanded ? 'rotate-180' : ''"
      />
    </button>

    <!-- Content (animated expand/collapse) -->
    <div
      class="grid transition-[grid-template-rows] duration-250 ease-in-out"
      :class="expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
    >
    <div class="overflow-hidden">
    <div class="pb-1">

      <!-- Items -->
      <div
        v-for="sp in similarPosts"
        :key="sp.id"
        class="group cursor-pointer flex flex-col justify-center py-2 px-3.5 hover:bg-secondary/40 transition-colors"
        @click="emit('select', sp)"
      >
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2.5 overflow-hidden">
            <h4 class="text-[13px] font-bold font-heading group-hover:text-primary transition-colors truncate">
              {{ sp.title }}
            </h4>
            <div class="flex items-center gap-2.5 text-muted-foreground/50 text-[11px] font-bold shrink-0">
              <span class="flex items-center gap-0.5">
                <Icon name="lucide:chevron-up" size="14" /> {{ sp.voteCount }}
              </span>
              <span class="flex items-center gap-0.5">
                <Icon name="lucide:message-square" size="12" /> {{ sp.commentCount }}
              </span>
            </div>
          </div>
          <span
            class="inline-flex items-center px-1.5 py-px rounded-full text-[8px] font-bold uppercase tracking-wider shrink-0 border"
            :style="{
              color: `var(${statusConfig(sp.status).cssVar})`,
              backgroundColor: `var(${statusConfig(sp.status).cssVar}-bg)`,
              borderColor: `var(${statusConfig(sp.status).cssVar}-border)`,
            }"
          >
            {{ $t(statusLabelKey(sp.status)) }}
          </span>
        </div>
        <p v-if="sp.excerpt" class="text-[11px] text-muted-foreground line-clamp-1 mt-0.5">{{ sp.excerpt }}</p>
      </div>
    </div>
    </div>
    </div>
  </div>
  </div>
  </div>
</template>

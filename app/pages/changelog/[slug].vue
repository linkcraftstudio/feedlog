<script setup lang="ts">
import { resolveAttachmentUrl } from '~/utils/attachment'

const { t } = useI18n()
const localePath = useLocalePath()

const CATEGORY_LABEL = computed<Record<string, string>>(() => ({
  new: t('changelog.category.new'),
  improved: t('changelog.category.improved'),
  fixed: t('changelog.category.fixed'),
}))

const CATEGORY_CLASS: Record<string, string> = {
  new: 'bg-primary/10 text-primary border-primary/25',
  improved: 'bg-chart-2/15 text-chart-2 border-chart-2/25',
  fixed: 'bg-success/10 text-success border-success/30',
}

const route = useRoute()
const slug = route.params.slug as string

const { data: entry, error } = await useFetch<ChangelogListItem>(`/api/changelogs/${slug}`)

const coverUrl = computed(() => resolveAttachmentUrl(entry.value?.cover))

const timeAgo = useTimeAgo()
const formatDate = useFormatDate()

usePageOg({
  kind: 'changelogEntry',
  title: () => entry.value?.title,
  content: () => entry.value?.content,
  publishedAt: () => entry.value?.publishedAt,
})

function badgeClass(cat: string) {
  return `inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${CATEGORY_CLASS[cat] ?? 'bg-secondary text-secondary-foreground border-border'}`
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0 max-w-3xl mx-auto w-full min-h-0">
    <!-- Not found -->
    <div v-if="error || !entry" class="flex flex-col items-center justify-center py-20 text-center gap-4">
      <Icon name="lucide:file-question" size="48" class="text-muted-foreground/40" />
      <div>
        <p class="font-heading font-bold text-lg">{{ $t('changelog.notFound') }}</p>
        <p class="text-sm text-muted-foreground mt-1">{{ $t('changelog.notFoundHint') }}</p>
      </div>
      <NuxtLink
        :to="localePath('/changelog')"
        class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-heading font-semibold hover:bg-primary/90 transition-colors"
      >
        <Icon name="lucide:arrow-left" size="16" />
        {{ $t('changelog.back') }}
      </NuxtLink>
    </div>

    <template v-else>
      <nav class="mb-4 sm:mb-6">
        <NuxtLink
          :to="localePath('/changelog')"
          class="inline-flex items-center gap-1.5 min-h-11 -ml-2 pl-2 pr-3 py-2 text-sm font-medium text-muted-foreground hover:text-primary active:text-primary rounded-lg transition-colors touch-manipulation sm:min-h-0 sm:ml-0 sm:px-0 sm:py-0"
        >
          <Icon name="lucide:arrow-left" size="16" />
          {{ $t('changelog.back') }}
        </NuxtLink>
      </nav>

      <article class="bg-card border border-border rounded-md sm:rounded-lg overflow-hidden shadow-sm">
        <div
          v-if="coverUrl"
          class="aspect-[2.5/1] w-full overflow-hidden bg-muted"
        >
          <img
            :src="coverUrl"
            :alt="entry.title"
            class="w-full h-full object-cover"
            width="1200" height="480" loading="lazy"
          >
        </div>

        <div class="p-4 sm:p-5 md:p-8 space-y-3 sm:space-y-4">
          <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-2 sm:gap-y-1">
            <div v-if="entry.categories.length > 0" class="flex flex-wrap items-center gap-2 gap-y-1">
              <span v-for="cat in entry.categories" :key="cat" :class="badgeClass(cat)">
                {{ CATEGORY_LABEL[cat] ?? cat }}
              </span>
            </div>
            <span class="text-xs font-medium text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5 sm:ml-auto sm:shrink-0">
              <Icon name="lucide:calendar" size="14" class="shrink-0" />
              {{ formatDate(entry.publishedAt) }}
              <span class="text-muted-foreground/60">·</span>
              {{ timeAgo(entry.publishedAt) }}
            </span>
          </div>

          <h1 class="font-heading text-xl sm:text-2xl md:text-3xl font-bold leading-tight break-words">
            {{ entry.title }}
          </h1>

          <div class="border-t border-border pt-4 sm:pt-6 min-w-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto">
            <PostContent v-if="entry.content" :content="entry.content" />
          </div>

          <ChangelogReactions
            :changelog-id="entry.id"
            :reaction-counts="entry.reactionCounts"
            :user-reactions="entry.userReactions"
          />
        </div>
      </article>
    </template>
  </div>
</template>

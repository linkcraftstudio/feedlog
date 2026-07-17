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

const props = defineProps<{
  entry: ChangelogListItem
  isLast: boolean
  collapseBodyByDefault: boolean
}>()

const expanded = ref(!props.collapseBodyByDefault)
const mobileExpanded = ref(false)

const coverUrl = computed(() => resolveAttachmentUrl(props.entry.cover))

const timeAgo = useTimeAgo()
const formatDate = useFormatDate()

function badgeClass(cat: string) {
  return `inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${CATEGORY_CLASS[cat] ?? 'bg-secondary text-secondary-foreground border-border'}`
}
</script>

<template>
  <div class="flex gap-0.5 sm:gap-1.5 items-stretch">
    <!-- Date column -->
    <div class="hidden sm:flex shrink-0 self-start flex-col items-end text-right w-[7rem] md:w-[8.5rem]">
      <time class="flex flex-col items-end text-right w-full min-w-0" :datetime="entry.publishedAt">
        <span class="flex h-5 items-center justify-end gap-1 sm:gap-1.5 w-full text-muted-foreground">
          <Icon name="lucide:calendar" size="14" class="shrink-0 opacity-90" />
          <span class="text-[10px] sm:text-xs md:text-sm font-medium tabular-nums leading-tight tracking-tight break-words text-end">
            {{ formatDate(entry.publishedAt) }}
          </span>
        </span>
        <span class="text-[10px] sm:text-[11px] text-muted-foreground tabular-nums leading-none mt-0.5 sm:mt-1">
          {{ timeAgo(entry.publishedAt) }}
        </span>
      </time>
    </div>

    <!-- Timeline rail -->
    <div class="hidden sm:flex flex-col items-center shrink-0 w-4" aria-hidden="true">
      <div class="flex h-5 items-center justify-center w-full shrink-0">
        <div class="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full bg-primary border-2 border-background shadow-sm" />
      </div>
      <div v-if="!isLast" class="flex-1 w-px bg-border min-h-0" />
    </div>

    <article class="flex-1 min-w-0 pb-6 sm:pb-10 md:pb-12" :class="{ 'pb-4 sm:pb-6': isLast }">
      <div class="changelog-card bg-card border border-border rounded-md sm:rounded-lg overflow-hidden transition-shadow duration-200 hover:shadow-[var(--shadow-warm)] active:opacity-[0.99]">
        <!-- Mobile date -->
        <div class="sm:hidden px-3 pt-3 pb-1">
          <time class="inline-flex flex-wrap items-center gap-1.5 text-muted-foreground" :datetime="entry.publishedAt">
            <Icon name="lucide:calendar" size="14" class="shrink-0 opacity-90" />
            <span class="text-xs font-medium tabular-nums leading-none">{{ formatDate(entry.publishedAt) }}</span>
            <span class="text-muted-foreground/60">·</span>
            <span class="text-xs tabular-nums leading-none">{{ timeAgo(entry.publishedAt) }}</span>
          </time>
        </div>

        <!-- Cover image -->
        <NuxtLink
          v-if="coverUrl"
          :to="localePath(`/changelog/${entry.slug}`)"
          class="block aspect-[2.5/1] w-full overflow-hidden bg-muted touch-manipulation"
        >
          <img
            :src="coverUrl"
            :alt="entry.title"
            class="w-full h-full object-cover hover:scale-[1.02] transition-transform duration-300"
            width="1200" height="480" loading="lazy"
          >
        </NuxtLink>

        <div class="relative">
          <div class="p-3 sm:p-4 md:p-5 space-y-2.5 sm:space-y-3" :class="mobileExpanded ? '' : 'max-sm:max-h-[32rem] max-sm:overflow-hidden'">
            <!-- Title + categories -->
            <NuxtLink :to="localePath(`/changelog/${entry.slug}`)" class="group block touch-manipulation">
              <h2 class="font-heading text-base sm:text-lg md:text-xl font-bold leading-snug break-words">
                <span v-if="entry.categories.length > 0" class="mr-2 inline-flex flex-wrap items-center gap-1.5 align-middle">
                  <span v-for="cat in entry.categories" :key="cat" :class="badgeClass(cat)">
                    {{ CATEGORY_LABEL[cat] ?? cat }}
                  </span>
                </span>
                <span class="group-hover:text-primary transition-colors">{{ entry.title }}</span>
              </h2>
            </NuxtLink>

            <!-- Collapsed preview -->
            <div v-if="collapseBodyByDefault && !expanded" class="relative border-t border-border/60 pt-2.5 sm:pt-3">
              <div class="post-content-wrap max-h-40 sm:max-h-48 overflow-hidden">
                <PostContent :content="entry.content" />
              </div>
              <div class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card to-transparent" />
            </div>

            <div v-if="collapseBodyByDefault && !expanded" class="pt-0.5">
              <button
                type="button"
                class="min-h-11 sm:min-h-0 w-full sm:w-auto px-1 -mx-1 sm:mx-0 text-sm font-heading font-semibold text-primary hover:underline touch-manipulation text-left rounded-md active:bg-primary/5"
                @click="expanded = true"
              >
                {{ $t('changelog.showFull') }}
              </button>
            </div>

            <!-- Full content -->
            <div v-if="!collapseBodyByDefault || expanded" class="post-content-wrap border-t border-border/60 pt-2.5 sm:pt-3">
              <PostContent :content="entry.content" />
            </div>

            <!-- Reactions -->
            <ChangelogReactions
              :changelog-id="entry.id"
              :reaction-counts="entry.reactionCounts"
              :user-reactions="entry.userReactions"
            />

            <div class="flex justify-end pt-1">
              <NuxtLink
                :to="localePath(`/changelog/${entry.slug}`)"
                class="inline-flex items-center justify-center gap-1 min-h-11 sm:min-h-0 sm:justify-end px-2 -mx-2 sm:mx-0 py-2 sm:py-0 text-xs font-bold text-muted-foreground hover:text-primary active:text-primary transition-colors touch-manipulation rounded-md active:bg-secondary/60"
              >
                {{ $t('changelog.openFull') }}
                <Icon name="lucide:arrow-right" size="14" />
              </NuxtLink>
            </div>
          </div>

          <!-- Mobile fade + expand -->
          <div v-if="!mobileExpanded" class="pointer-events-none absolute inset-x-0 bottom-0 h-20 sm:hidden bg-gradient-to-t from-card to-transparent" />
          <div v-if="!mobileExpanded" class="sm:hidden px-3 pb-3">
            <button
              type="button"
              class="w-full min-h-11 rounded-lg border border-border bg-background text-sm font-heading font-semibold text-foreground active:bg-secondary/60 transition-colors touch-manipulation"
              @click="mobileExpanded = true"
            >
              {{ $t('changelog.expand') }}
            </button>
          </div>
        </div>
      </div>
    </article>
  </div>
</template>

<style scoped>
.post-content-wrap :deep(.post-content) {
  max-width: none;
}
.post-content-wrap :deep(pre) {
  max-width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
</style>

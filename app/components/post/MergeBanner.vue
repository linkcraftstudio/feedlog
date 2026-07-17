<script setup lang="ts">
defineProps<{
  canonicalPost: { slug: string; title: string }
}>()

const localePath = useLocalePath()
</script>

<template>
  <div class="py-4 px-5 bg-card border border-border rounded-lg flex items-center gap-4 shadow-sm">
    <div class="flex items-center justify-center w-10 h-10 rounded-full bg-primary/10 text-primary shrink-0">
      <Icon name="lucide:git-merge" size="20" />
    </div>
    <div class="flex-1 min-w-0 flex flex-col items-start justify-center">
      <p class="text-xs font-medium text-muted-foreground">
        {{ $t('post.merge.banner') }}
      </p>
      <NuxtLink
        :to="localePath(`/p/${canonicalPost.slug}`)"
        class="text-sm font-bold text-primary hover:underline underline-offset-4 transition-all flex items-center gap-1 group"
      >
        {{ canonicalPost.title }}
        <Icon name="lucide:arrow-right" size="16" class="group-hover:translate-x-1 transition-transform shrink-0" />
      </NuxtLink>
    </div>
  </div>
</template>

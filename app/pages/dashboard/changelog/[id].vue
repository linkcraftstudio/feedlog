<script setup lang="ts">
definePageMeta({ layout: 'dashboard', middleware: 'admin' })

const route = useRoute()
const changelogId = route.params.id as string
</script>

<template>
  <div class="flex-1 overflow-auto">
    <ChangelogEditor :changelog-id="changelogId" />
  </div>
</template>

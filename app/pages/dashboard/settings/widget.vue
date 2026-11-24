<script setup lang="ts">
definePageMeta({
  middleware(to) {
    const localePath = useLocalePath()
    return navigateTo(localePath({ path: '/dashboard/ai-agent/deploy', query: to.query, hash: to.hash || (to.query.install === '1' ? '#installation' : '') }), { replace: true })
  },
})
</script>

<template>
  <div />
</template>

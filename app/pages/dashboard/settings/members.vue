<script setup lang="ts">
definePageMeta({
  middleware(to) {
    const localePath = useLocalePath()
    return navigateTo(localePath({ path: '/dashboard/members', query: to.query, hash: to.hash }), { replace: true })
  },
})
</script>

<template>
  <div />
</template>

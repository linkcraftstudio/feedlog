<script setup lang="ts">
definePageMeta({ layout: false })

const { isOpen, open } = useLoginModal()
const { data } = await useAuthSession()

watch(() => data.value?.user, (user) => {
  if (user) navigateTo('/dashboard')
}, { immediate: true })

onMounted(() => open())
</script>

<template>
  <div class="min-h-screen bg-background font-body flex items-center justify-center px-6">
    <LoginModal v-model:open="isOpen" />
    <button class="font-heading font-semibold text-sm px-4 py-2 rounded-lg bg-primary text-primary-foreground" @click="open()">
      {{ $t('common.signIn') }}
    </button>
  </div>
</template>

<script setup lang="ts">
// Subscription state comes from the post detail response (props); this card
// only writes. Subscribe = POST, unsubscribe = DELETE.
const props = defineProps<{ postId: string; subscribed: boolean }>()
const emit = defineEmits<{ 'update:subscribed': [boolean] }>()

const isSubscribed = ref(props.subscribed)
const pending = ref(false)
watchEffect(() => { isSubscribed.value = props.subscribed })

async function toggle() {
  if (pending.value) return
  pending.value = true
  const next = !isSubscribed.value
  try {
    await useApiFetch(`/api/posts/${props.postId}/subscription`, { method: next ? 'POST' : 'DELETE' })
    isSubscribed.value = next
    emit('update:subscribed', next)
  }
  finally {
    pending.value = false
  }
}
</script>

<template>
  <div>
    <h4 class="font-heading text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
      {{ $t('post.subscribe.title') }}
    </h4>
    <p class="mb-3 text-xs text-muted-foreground leading-snug">{{ $t('post.subscribe.desc') }}</p>
    <button
      class="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px] font-bold transition-colors disabled:opacity-50"
      :class="isSubscribed
        ? 'border-border hover:bg-secondary/50'
        : 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90'"
      :disabled="pending"
      @click="toggle"
    >
      <Icon :name="isSubscribed ? 'lucide:bell-off' : 'lucide:bell'" size="14" />
      {{ isSubscribed ? $t('post.subscribe.unsubscribe') : $t('post.subscribe.subscribe') }}
    </button>
  </div>
</template>

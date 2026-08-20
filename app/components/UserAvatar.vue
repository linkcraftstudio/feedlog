<script setup lang="ts">
import type { DisplayableAuthor } from '~/composables/useAuthorDisplay'
import { avatarHue } from '#layers/feedlog/shared/utils/identity'

// The one place that knows what a person looks like in this product.
//
// Three rungs, ordered by how much identity we actually hold: an uploaded
// picture, initials for someone with an account, and a plain glyph for a guest.
// Colour is derived from the user id at every rung, so colour answers "who" —
// shape is what answers "does this person have an account", which reads without
// anyone having to learn a colour rule and survives colour-blindness.
//
// Deliberately NOT used for the signed-in user's own chip in the header and
// sidebar: that one wears the brand accent, and with exactly one of them on
// screen there is nothing to tell apart.

interface AvatarAuthor extends DisplayableAuthor {
  image?: string | null
}

const props = withDefaults(defineProps<{
  author?: AvatarAuthor | null
  size?: 4 | 5 | 6 | 8 | 9 | 10
  shadow?: boolean
}>(), { author: null, size: 8, shadow: false })

// Callers pass `shadow` rather than a class: a fallthrough class gets merged with
// the internal one in a different order on the server than in the browser, which
// Vue reports as a hydration mismatch. One binding, one order, both sides.
defineOptions({ inheritAttrs: false })

const { authorName, authorInitials } = useAuthorDisplay()

// Spelled out rather than composed: Tailwind only ships classes it can find as
// literals in the source.
const SIZES = {
  4: { box: 'w-4 h-4', text: 'text-[7px]', icon: 9 },
  5: { box: 'w-5 h-5', text: 'text-[9px]', icon: 11 },
  6: { box: 'w-6 h-6', text: 'text-[9px]', icon: 13 },
  8: { box: 'w-8 h-8', text: 'text-xs', icon: 17 },
  9: { box: 'w-9 h-9', text: 'text-xs', icon: 19 },
  10: { box: 'w-10 h-10', text: 'text-sm', icon: 21 },
} as const

const dims = computed(() => SIZES[props.size])
const hue = computed(() => (props.author?.id ? avatarHue(props.author.id) : 0))
const isGuest = computed(() => !!props.author?.isAnonymous)
const hasImage = computed(() => !!props.author?.image)
</script>

<template>
  <span
    role="img"
    :aria-label="authorName(author)"
    :title="authorName(author)"
    :class="[
      'rounded-full shrink-0 inline-flex items-center justify-center overflow-hidden font-bold select-none',
      dims.box,
      dims.text,
      hasImage ? '' : 'user-avatar',
      shadow ? 'shadow-sm' : '',
    ]"
    :style="hasImage ? undefined : { '--avatar-hue': hue }"
  >
    <img v-if="hasImage" :src="author!.image!" alt="" class="w-full h-full object-cover" referrerpolicy="no-referrer">
    <Icon v-else-if="isGuest" name="lucide:user-round" :size="dims.icon" />
    <template v-else>{{ authorInitials(author) }}</template>
  </span>
</template>

<style scoped>
/* Low chroma on purpose: the chip has to read as a background element next to
   whatever primary colour the tenant picked, not compete with it. */
.user-avatar {
  background-color: oklch(0.92 0.05 var(--avatar-hue));
  color: oklch(0.42 0.10 var(--avatar-hue));
}

.dark .user-avatar {
  background-color: oklch(0.34 0.05 var(--avatar-hue));
  color: oklch(0.88 0.09 var(--avatar-hue));
}
</style>

<script setup lang="ts">
// Renders the one piece of markdown the assistant ever emits: the mailto link in
// the contact-support reply. A full markdown renderer would drag its stylesheet
// and dependencies into an iframe that has to stay small, so this walks the
// string and splits it into text and link segments instead — no HTML is built,
// so nothing can be injected through the message.
const props = defineProps<{ text: string }>()

interface Segment { text: string; href?: string }

const LINK = /\[([^\]]+)\]\((mailto:[^)\s]+|https?:\/\/[^)\s]+)\)/g

const segments = computed<Segment[]>(() => {
  const out: Segment[] = []
  let last = 0
  for (const m of props.text.matchAll(LINK)) {
    if (m.index > last) out.push({ text: props.text.slice(last, m.index) })
    out.push({ text: m[1]!, href: m[2]! })
    last = m.index + m[0].length
  }
  if (last < props.text.length) out.push({ text: props.text.slice(last) })
  return out
})
</script>

<template>
  <span class="whitespace-pre-wrap"><template v-for="(s, i) in segments" :key="i"><a
    v-if="s.href"
    :href="s.href"
    target="_blank"
    rel="noopener noreferrer"
    class="underline underline-offset-2 font-semibold hover:opacity-80"
  >{{ s.text }}</a><template v-else>{{ s.text }}</template></template></span>
</template>

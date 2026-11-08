<script setup lang="ts">
import { defineComponent, h } from 'vue'
// Retain the Markdown and slot contract with a separate client editing bundle.
defineOptions({ inheritAttrs: false })
const instance = ref<Record<string, (...args: unknown[]) => unknown>>()
const methods = ['triggerSave', 'focus', 'getSelectedText', 'resetHistory', 'getEditorView', 'setMode']
defineExpose(Object.fromEntries(methods.map(name => [name, (...args: unknown[]) => instance.value?.[name]?.(...args)])))
const model = defineModel<string>()
// Keep the engine as the root so caller sizing and scoped styles reach its frame.
const mounted = ref(false)
onMounted(() => { mounted.value = true })
const { t } = useI18n()
const Loading = defineComponent({
  inheritAttrs: false,
  setup(_props, { attrs }) {
    return () => h('div', {
      class: ['md-editor fdl-editor-loading flex min-h-[120px] w-full flex-col border border-border bg-background text-muted-foreground', attrs.class],
      style: [{ height: '500px' }, attrs.style],
      role: 'status', 'aria-busy': 'true',
    }, [
      h('div', { class: 'flex h-10 shrink-0 items-center gap-3 border-b border-border px-3', 'aria-hidden': 'true' },
        Array.from({ length: 7 }, () => h('span', { class: 'size-4 animate-pulse rounded bg-muted' }))),
      h('div', { class: 'flex flex-1 items-center justify-center text-sm' }, t('markdownEditor.loading')),
    ])
  },
})
const Editor = defineAsyncComponent({ loader: () => import('./TiptapMarkdownEditor.client.vue'), loadingComponent: Loading, delay: 0, suspensible: false })
</script>

<template>
  <Editor v-if="mounted" ref="instance" v-model="model" v-bind="$attrs">
    <template v-for="(_, name) in $slots" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps ?? {}" />
    </template>
  </Editor>
  <Loading v-else v-bind="$attrs" />
</template>

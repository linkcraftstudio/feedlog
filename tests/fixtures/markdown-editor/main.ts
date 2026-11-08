import '../../../app/assets/css/tailwind.css'
import * as Vue from 'vue'
import ThemedMdPreview from '../../../app/components/ThemedMdPreview.vue'
import { renderMarkdown } from '../../../app/lib/markdown-render'
import Fixture from './EditorFixture.vue'
import messages from '../../../i18n/locales/en.json'
import chineseMessages from '../../../i18n/locales/zh.json'
const theme = Vue.ref('light')
// Nuxt auto-imports these in production. The isolated fixture supplies the same
// Vue APIs without starting auth/database/AI services.
Object.assign(globalThis, { ...Vue, useEditorTheme: () => theme, useI18n: () => ({ t: (key: string, _params?: unknown, options?: { locale?: string }) => (options?.locale === 'zh' ? chineseMessages : messages).markdownEditor[key.split('.')[1] as keyof typeof messages.markdownEditor] }) })
Object.assign(window, { renderMarkdown })
const app = Vue.createApp(Fixture)
app.component('ClientOnly', { template: '<slot />' })
app.component('Icon', { props: ['name'], template: '<span :data-icon="name" style="display:inline-block;width:18px;height:18px">◇</span>' })
app.component('ThemedMdPreview', ThemedMdPreview)
app.mount('#app')
Object.assign(window, { theme })

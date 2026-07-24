import { config } from 'md-editor-v3'
import { resolveAttachmentUrls } from '~/utils/attachment'

export default defineNuxtPlugin(() => {
  config({
    codeMirrorExtensions(extensions) {
      return extensions.filter(ext => ext.type !== 'linkShortener')
    },
    markdownItConfig(md) {
      md.core.ruler.before('normalize', 'resolve_attachments', (state) => {
        state.src = resolveAttachmentUrls(state.src)
      })
    },
  })
})

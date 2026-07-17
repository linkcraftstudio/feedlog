import { config } from 'md-editor-v3'

export default defineNuxtPlugin(() => {
  config({
    codeMirrorExtensions(extensions) {
      return extensions.filter(ext => ext.type !== 'linkShortener')
    },
  })
})

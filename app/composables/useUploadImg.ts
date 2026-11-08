// Shared image upload handler for the Markdown editor.
export function useUploadImg(beforeUpload?: () => boolean | Promise<boolean>) {
  async function onUploadImg(files: File[], callback: (urls: string[]) => void) {
    if (!files.length || (beforeUpload && !await beforeUpload())) return
    const urls: string[] = []
    let failed = false

    for (const file of files) {
      const formData = new FormData()
      formData.append('file', file)

      try {
        const result = await $fetch<{ key: string }>('/api/upload', {
          method: 'POST',
          body: formData,
        })
        if (typeof result.key !== 'string' || !result.key.trim()) throw new Error('Missing uploaded image key')
        urls.push(`attachment:${result.key}`)
      } catch {
        failed = true
      }
    }

    if (urls.length) callback(urls)
    if (failed) throw new Error(urls.length ? 'partialUpload' : 'uploadFailed')
  }

  return { onUploadImg }
}

import { heicTo } from 'heic-to/next'

self.onmessage = async (event: MessageEvent<Blob>) => {
  try {
    const blob = await heicTo({ blob: event.data, type: 'image/jpeg', quality: 0.9 })
    self.postMessage({ blob })
  } catch { self.postMessage({ error: true }) }
}

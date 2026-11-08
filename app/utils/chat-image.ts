import DOMPurify from 'dompurify'
import { CHAT_IMAGE_UPLOAD_BYTES, CHAT_IMAGE_TARGET_BYTES, CHAT_IMAGE_STANDARD_EDGE, CHAT_IMAGE_MAX_EDGE, CHAT_IMAGE_INPUT_BYTES, CHAT_IMAGE_TYPES, ChatImageError } from '#layers/feedlog/shared/agent/images'

function convertHeic(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/heic.ts', import.meta.url), { type: 'module' })
    const finish = (blob?: Blob) => {
      clearTimeout(timer)
      worker.terminate()
      if (blob) resolve(blob)
      else reject(new ChatImageError('image_unsupported'))
    }
    const timer = setTimeout(() => finish(), 30000)
    worker.onmessage = (event: MessageEvent<{ blob?: Blob }>) => finish(event.data.blob)
    worker.onerror = () => finish()
    worker.postMessage(file)
  })
}

async function rasterSource(file: File): Promise<Blob> {
  const header = new Uint8Array(await file.slice(0, 64).arrayBuffer())
  const brands = new TextDecoder().decode(header)
  if (/\.(heic|heif)$/i.test(file.name) || /image\/hei[cf]/i.test(file.type)
    || (brands.slice(4, 8) === 'ftyp' && /heic|heix|hevc|hevx|mif1|msf1/.test(brands))) return convertHeic(file)
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
    const source = await file.text()
    const original = new DOMParser().parseFromString(source, 'image/svg+xml')
    if (original.documentElement.localName !== 'svg' || original.querySelector('parsererror')) throw new ChatImageError('image_invalid')
    // Image-mode SVG cannot load external resources. Reject those documents
    // instead of silently deleting visible content. Internal references and CSS stay intact.
    if (original.querySelector('foreignObject') || /<\?xml-stylesheet/i.test(source)) throw new ChatImageError('image_unsupported')
    for (const element of original.querySelectorAll('*')) {
      for (const attr of element.attributes) {
        if (attr.localName === 'href' && element.localName !== 'a'
          && !attr.value.trim().startsWith('#')
          && !/^data:image\/(?:png|jpeg|webp);base64,/i.test(attr.value.trim())) throw new ChatImageError('image_unsupported')
      }
      const css = element.localName === 'style' ? element.textContent || '' : element.getAttribute('style') || ''
      const values = [css, ...Array.from(element.attributes, attr => attr.value)].join(' ')
      if (/@import|\\/i.test(css)) throw new ChatImageError('image_unsupported')
      for (const match of values.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
        if (!match[2]?.trim().startsWith('#') && !/^data:image\/(?:png|jpeg|webp);base64,/i.test(match[2]?.trim() || '')) throw new ChatImageError('image_unsupported')
      }
    }
    const clean = DOMPurify.sanitize(source, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: ['use', 'style'],
      FORBID_TAGS: ['script', 'animate', 'set', 'animateMotion', 'animateTransform'],
    })
    const doc = new DOMParser().parseFromString(clean, 'image/svg+xml')
    const svg = doc.documentElement
    if (svg.localName !== 'svg' || doc.querySelector('parsererror')) throw new ChatImageError('image_invalid')
    const box = svg.getAttribute('viewBox')?.trim().split(/[ ,]+/).map(Number)
    const width = Number.parseFloat(svg.getAttribute('width') || '') || box?.[2] || 300
    const height = Number.parseFloat(svg.getAttribute('height') || '') || box?.[3] || 150
    if (!(width > 0 && height > 0 && Number.isFinite(width + height))) throw new ChatImageError('image_invalid')
    const scale = Math.min(1, CHAT_IMAGE_MAX_EDGE / Math.max(width, height))
    if (!box) svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    svg.setAttribute('width', String(Math.max(1, Math.round(width * scale))))
    svg.setAttribute('height', String(Math.max(1, Math.round(height * scale))))
    return new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' })
  }
  return file
}

// Complete preparation before upload. Preserve full frames and avoid repeatedly shrinking text.
export async function prepareChatImage(file: File, targetMaxBytes = CHAT_IMAGE_UPLOAD_BYTES): Promise<File> {
  const maxBytes = Math.min(CHAT_IMAGE_UPLOAD_BYTES, targetMaxBytes)
  const targetBytes = Math.min(CHAT_IMAGE_TARGET_BYTES, maxBytes)
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || file.size > CHAT_IMAGE_INPUT_BYTES) throw new ChatImageError('image_too_large')
  if (!file.size) throw new ChatImageError('image_invalid')
  const blob = await rasterSource(file)
  const url = URL.createObjectURL(blob)
  const image = new Image()
  const canvas = document.createElement('canvas')
  try {
    image.src = url
    try { await image.decode() } catch { throw new ChatImageError('image_unsupported') }
    const { naturalWidth: width, naturalHeight: height } = image
    if (!width || !height) throw new ChatImageError('image_invalid')
    const longImage = Math.max(width, height) / Math.min(width, height) > 3
    const edge = longImage ? CHAT_IMAGE_MAX_EDGE : CHAT_IMAGE_STANDARD_EDGE
    const scale = Math.min(1, edge / Math.max(width, height))
    if (CHAT_IMAGE_TYPES.some(type => type === blob.type) && blob.size <= targetBytes && scale === 1) {
      return blob === file ? file : new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: blob.type })
    }
    const context = canvas.getContext('2d')
    if (!context) throw new ChatImageError('image_invalid')
    let fallback: Blob | undefined
    // Long screenshots retain more pixels and never enter the further downscale passes.
    for (const factor of longImage ? [1] : [1, 2 / 3, 1 / 2]) {
      canvas.width = Math.max(1, Math.round(width * scale * factor))
      canvas.height = Math.max(1, Math.round(height * scale * factor))
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      for (const quality of [0.85, 0.78, 0.7]) {
        const output = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', quality))
        // Some browsers fall back to PNG. Keep that supported format if it fits.
        if (!output || !['image/webp', 'image/png'].includes(output.type)) throw new ChatImageError('image_unsupported')
        if (output.size <= maxBytes && !fallback) fallback = output
        if (output.size <= targetBytes) return encodedImage(output, file.name)
      }
      // Prefer the higher-resolution acceptable result over shrinking to chase a soft target.
      if (fallback) return encodedImage(fallback, file.name)
    }
    throw new ChatImageError('image_too_large')
  } finally { URL.revokeObjectURL(url); canvas.width = canvas.height = 0 }
}

function encodedImage(blob: Blob, name: string): File {
  return new File([blob], `${name.replace(/\.[^.]+$/, '')}.${blob.type === 'image/webp' ? 'webp' : 'png'}`, { type: blob.type })
}

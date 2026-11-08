import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateAgentImage } from '../server/lib/agent/images'
import { imageExecutionError } from '../server/lib/agent/errors'
import { ChatImageError, CHAT_IMAGE_MAX_BYTES } from '../shared/agent/images'
import { customerContent } from '../shared/agent/content'

test('customer messages accept ten images with text and reject eleven images', () => {
  const images = Array.from({ length: 11 }, (_, i) => ({ type: 'image', storage_key: `uploads/image-${i}.png` }))
  const text = { type: 'text', text: 'Compare these screenshots' }
  assert.equal(customerContent.safeParse({ parts: images.slice(0, 10) }).success, true)
  assert.equal(customerContent.safeParse({ parts: [text, ...images.slice(0, 10)] }).success, true)
  assert.equal(customerContent.safeParse({ parts: images }).success, false)
  assert.equal(customerContent.safeParse({ parts: [text, ...images] }).success, false)
})

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=', 'base64')
const code = (value: string) => (error: unknown) => error instanceof ChatImageError && error.code === value

test('model image validation reads actual bytes, rejects unsupported content and enforces limits', () => {
  assert.equal(validateAgentImage(png), 'image/png')
  const atLimit = Buffer.alloc(16 * 1024 * 1024)
  png.copy(atLimit)
  assert.equal(CHAT_IMAGE_MAX_BYTES, atLimit.length)
  assert.equal(validateAgentImage(atLimit), 'image/png')
  assert.throws(() => validateAgentImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')), code('image_unsupported'))
  assert.throws(() => validateAgentImage(Buffer.from('not a PNG')), code('image_unsupported'))
  assert.throws(() => validateAgentImage(Buffer.alloc(0)), code('image_invalid'))
  assert.throws(() => validateAgentImage(Buffer.alloc(CHAT_IMAGE_MAX_BYTES + 1)), code('image_too_large'))
  const wide = Buffer.from(png); wide.writeUInt32BE(10000, 16)
  assert.throws(() => validateAgentImage(wide), code('image_too_large'))
})

test('provider image errors are recoverable input failures, not automatic human transfers', () => {
  assert.equal(imageExecutionError(new Error('unsupported image format'))?.code, 'image_invalid')
  assert.equal(imageExecutionError({ error: new Error('image exceeds size limit') })?.code, 'image_too_large')
  assert.equal(imageExecutionError(new Error('rate limit exceeded')), undefined)
  assert.equal(imageExecutionError(new Error('service unavailable')), undefined)
})

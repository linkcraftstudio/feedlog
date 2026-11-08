import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { H3Event } from 'h3'
import { customerMemoryMessage } from '../server/lib/agent/agent'

test('ten valid images totaling more than 16 MiB pass message validation for downstream batching', async () => {
  const globals = globalThis as unknown as Record<string, unknown>
  const savedConfig = globals.useRuntimeConfig, savedStorage = globals.blobStorage
  const bytes = new Uint8Array(2 * 1024 * 1024)
  bytes.set(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=', 'base64'))
  globals.useRuntimeConfig = () => ({ public: { uploadPrefix: 'uploads' } })
  globals.blobStorage = { head: async () => ({ size: bytes.byteLength, contentType: 'image/png', httpEtag: 'version' }), get: () => { throw new Error('Preflight must not read pixels') } }
  try {
    const message = await customerMemoryMessage({} as H3Event, {
      id: 'item', conversation_id: 'conversation', seq: 1, created_at: new Date(),
      content: { parts: Array.from({ length: 10 }, (_, i) => ({ type: 'image', storage_key: `uploads/org/${i}.png` })) },
    }, 'org:conversation', 'org')
    assert.equal(message.content.parts.filter(part => part.type === 'file').length, 0)
    assert.equal((message.content.metadata?.imageReferences as unknown[]).length, 10)
  } finally {
    if (savedConfig === undefined) Reflect.deleteProperty(globals, 'useRuntimeConfig')
    else globals.useRuntimeConfig = savedConfig
    if (savedStorage === undefined) Reflect.deleteProperty(globals, 'blobStorage')
    else globals.blobStorage = savedStorage
  }
})

for (const stage of ['head'] as const) {
  test(`a stalled image ${stage} times out and late storage completion cannot continue preparation`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const globals = globalThis as unknown as Record<string, unknown>
    const savedConfig = globals.useRuntimeConfig, savedStorage = globals.blobStorage
    let finish!: (value: unknown) => void
    let bodyReads = 0
    const stalled = new Promise(resolve => { finish = resolve })
    globals.useRuntimeConfig = () => ({ public: { uploadPrefix: 'uploads' } })
    const blob = { arrayBuffer: () => { bodyReads++; return stalled } }
    globals.blobStorage = { head: () => stalled }
    try {
      const pending = customerMemoryMessage({} as H3Event, {
        id: 'item', conversation_id: 'conversation', seq: 1, created_at: new Date(),
        content: { parts: [{ type: 'image', storage_key: 'uploads/org/test.png' }] },
      }, 'org:conversation', 'org')
      const rejected = assert.rejects(pending, /timed out/)
      for (let i = 0; i < 20; i++) await Promise.resolve()
      t.mock.timers.tick(15_000)
      await rejected
      finish(blob)
      for (let i = 0; i < 20; i++) await Promise.resolve()
      assert.equal(bodyReads, 0)
    } finally {
      globals.useRuntimeConfig = savedConfig
      globals.blobStorage = savedStorage
    }
  })
}

test('run cancellation interrupts image reads even for historical attachments', async () => {
  const globals = globalThis as unknown as Record<string, unknown>
  const savedConfig = globals.useRuntimeConfig, savedStorage = globals.blobStorage
  globals.useRuntimeConfig = () => ({ public: { uploadPrefix: 'uploads' } })
  globals.blobStorage = { head: () => new Promise(() => {}) }
  const controller = new AbortController()
  try {
    const pending = customerMemoryMessage({} as H3Event, {
      id: 'item', conversation_id: 'conversation', seq: 1, created_at: new Date(),
      content: { parts: [{ type: 'image', storage_key: 'uploads/org/test.png' }] },
    }, 'org:conversation', 'org', true, true, controller.signal)
    const rejected = assert.rejects(pending, /Run cancelled/)
    controller.abort(new Error('Run cancelled'))
    await rejected
  } finally {
    globals.useRuntimeConfig = savedConfig
    globals.blobStorage = savedStorage
  }
})

test('new submissions enforce stored byte budgets even when AI is unavailable', async () => {
  const globals = globalThis as unknown as Record<string, unknown>
  const savedConfig = globals.useRuntimeConfig, savedStorage = globals.blobStorage
  globals.useRuntimeConfig = () => ({ public: { uploadPrefix: 'uploads' } })
  globals.blobStorage = { head: async () => ({ size: 2 * 1024 * 1024, contentType: 'image/png', httpEtag: 'version' }) }
  const item = { id: 'item', conversation_id: 'conversation', seq: 1, created_at: new Date(),
    content: { parts: Array.from({ length: 6 }, (_, i) => ({ type: 'image' as const, storage_key: `uploads/org/${i}.png` })) } }
  try {
    for (const forModel of [true, false]) {
      await assert.rejects(customerMemoryMessage({} as H3Event, item, 'org:conversation', 'org', false, forModel, undefined, true), /image_total_too_large/)
    }
    await assert.doesNotReject(customerMemoryMessage({} as H3Event, item, 'org:conversation', 'org', true))
  } finally { globals.useRuntimeConfig = savedConfig; globals.blobStorage = savedStorage }
})

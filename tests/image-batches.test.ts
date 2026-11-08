import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planImageBatches, analyzeImageReferences, type ImageBatchAnalyzer, type ImageLoader } from '../server/lib/agent/image-batches'
const limits = { maxImages: 4, maxBytes: 16 * 1024 * 1024 }
const refs = (count: number, bytes = 16 * 1024 * 1024) => Array.from({ length: count }, (_, i) => ({ index: i + 1, key: `image-${i}`, etag: '', bytes }))
const load: ImageLoader = async ref => ({ index: ref.index, bytes: ref.bytes, data: 'bounded-image' })
const analyze: ImageBatchAnalyzer = async images => images.map(image => ({ image: image.index, observations: `Observed ${image.index}`, uncertainty: '' }))

test('batch planning uses metadata without image bytes', () => {
  assert.deepEqual(planImageBatches(refs(10, 4 * 1024 * 1024), limits).map(b => b.length), [4, 4, 2])
  assert.deepEqual(planImageBatches(refs(10), limits).map(b => b.length), Array(10).fill(1))
})
test('independent conversations are not held behind a process-wide model queue', async () => {
  let active = 0, peak = 0, reads = 0
  const results = await Promise.all(Array.from({ length: 3 }, () => analyzeImageReferences(refs(10), '', new AbortController().signal,
    async (...args) => { await new Promise(resolve => setTimeout(resolve, 1)); active--; return analyze(...args) },
    async ref => { active++; reads++; peak = Math.max(peak, active); return load(ref, new AbortController().signal) })))
  assert.equal(peak, 6); assert.equal(reads, 30)
  for (const result of results) assert.deepEqual(result.map(item => item.image), refs(10).map(item => item.index))
})
test('failure and cancellation allow a successful explicit retry', async () => {
  const signal = new AbortController().signal
  await assert.rejects(analyzeImageReferences(refs(2), '', signal, async () => { throw new Error('Provider unavailable') }, load), /Provider unavailable/)
  await assert.rejects(analyzeImageReferences(refs(4, 4), '', signal, async () => [{ image: 1, observations: 'One only', uncertainty: '' }], load), /omitted or mismatched/)
  const controller = new AbortController(); let reads = 0
  await assert.rejects(analyzeImageReferences(refs(10), '', controller.signal, async (...args) => { controller.abort(); return analyze(...args) }, async (...args) => { reads++; return load(...args) }))
  assert.ok(reads <= 2)
  assert.equal((await analyzeImageReferences(refs(10), '', signal, analyze, load)).length, 10)
})
test('aborted metadata reads do not prevent other conversations from running', async () => {
  const controller = new AbortController()
  let finishRead!: () => void, startedRead!: () => void
  const started = new Promise<void>(resolve => { startedRead = resolve })
  const first = analyzeImageReferences(refs(1), '', controller.signal, analyze, async ref => {
    startedRead()
    await new Promise<void>(resolve => { finishRead = resolve })
    return load(ref, new AbortController().signal)
  })
  const rejected = assert.rejects(first)
  await started; controller.abort(); await rejected
  assert.equal((await analyzeImageReferences(refs(1), '', new AbortController().signal, analyze, load)).length, 1)
  finishRead()
})

test('ten compressed images use one analysis request within the default byte budget', async () => {
  let calls = 0
  const result = await analyzeImageReferences(refs(10, 210_000), '', new AbortController().signal,
    async (...args) => { calls++; return analyze(...args) }, load)
  assert.equal(calls, 1)
  assert.equal(result.length, 10)
})

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { embeddingModel, visionModel } from '../server/utils/ai-models'

const names = ['OPENAI_EMBEDDING_MODEL', 'OPENAI_VISION_MODEL', 'OPENAI_TEXT_MODEL']
const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))

afterEach(() => {
  for (const name of names) {
    if (saved[name] === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = saved[name]
  }
})

test('embedding model keeps the current default', () => {
  Reflect.deleteProperty(process.env, 'OPENAI_EMBEDDING_MODEL')
  assert.equal(embeddingModel(), 'text-embedding-3-large')
})

test('embedding model reads the environment at call time', () => {
  process.env.OPENAI_EMBEDDING_MODEL = 'custom-embedding'
  assert.equal(embeddingModel(), 'custom-embedding')
})

test('vision model falls back to the text model', () => {
  Reflect.deleteProperty(process.env, 'OPENAI_VISION_MODEL')
  process.env.OPENAI_TEXT_MODEL = 'text-model'
  assert.equal(visionModel(), 'text-model')
})

test('vision model overrides the text model', () => {
  process.env.OPENAI_TEXT_MODEL = 'text-model'
  process.env.OPENAI_VISION_MODEL = 'vision-model'
  assert.equal(visionModel(), 'vision-model')
})

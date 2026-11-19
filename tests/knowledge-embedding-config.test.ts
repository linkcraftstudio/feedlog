import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

test('knowledge embedding model and dimensions are configurable without changing other vector features', () => {
  for (const model of ['text-embedding-3-small', 'custom-embedding']) {
    const script = `
      const { HELP_EMBEDDING_MODEL, HELP_EMBEDDING_DIMENSIONS, HELP_INDEX_VERSION, embedHelpTexts } = await import('./server/lib/help-search/embedding.ts');
      let payload;
      globalThis.fetch = async (_url, input) => { payload=JSON.parse(input.body);return new Response(JSON.stringify({data:[{index:0,embedding:[1,0,0]}]}),{status:200}) };
      const vectors=await embedHelpTexts(['question']);
      console.log(JSON.stringify({model:HELP_EMBEDDING_MODEL, dimensions:HELP_EMBEDDING_DIMENSIONS, version:HELP_INDEX_VERSION, payload, vectors}));
    `
    const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, KNOWLEDGE_EMBEDDING_MODEL: model, KNOWLEDGE_EMBEDDING_DIMENSIONS: '3', OPENAI_API_KEY: 'fixture' },
    }))
    assert.equal(result.model, model); assert.equal(result.dimensions, 3)
    assert.match(result.version, /dim-3$/)
    assert.deepEqual(result.vectors, [[1, 0, 0]])
    assert.equal(result.payload.dimensions, model.startsWith('text-embedding-3-') ? 3 : undefined)
  }
})

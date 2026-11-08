import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const nuxtRequire = createRequire(require.resolve('nuxt/package.json'))
const { parse, compileScript } = nuxtRequire('vue/compiler-sfc')
const { build } = createRequire(require.resolve('tsx/package.json'))('esbuild')
const catalog = JSON.parse(readFileSync(resolve(root, 'i18n/locales/en.json'), 'utf8'))

// Render the actual component and SSE parser. Only its environment, transport,
// and message presentation are fixtures; stream/history timing is controlled.
const source = `
import * as Vue from 'vue';
import Chat from 'fixture:chat';
Object.assign(window, Vue);
const catalog = ${JSON.stringify(catalog)};
const t = key => key.split('.').reduce((value, key) => value?.[key], catalog) ?? key;
window.useI18n = () => ({ t });
window.useConversationTime = () => () => 'just now';
let app;
window.mountChat = (restoreRunning = false) => {
  app?.unmount();
  sessionStorage.clear();
  window.historyStarted = false;
  window.lastBusy = false;
  window.nextHistoryFails = false;
  const now = new Date().toISOString();
  const run = { id: 'run-1', triggerItemId: 'customer-1', status: 'running', error: null, startedAt: now, deadlineAt: new Date(Date.now() + 120000).toISOString(), finishedAt: null };
  const state = { conversation: { id: 'thread', handling: 'ai', lastSeq: 1 }, items: [], runs: restoreRunning ? [run] : [], nextBeforeSeq: null, nextAfterSeq: 1 };
  const snapshot = () => JSON.parse(JSON.stringify(state));
  let deferHistory = false;
  const widget = {
    user: Vue.ref({ id: 'customer' }), imageMaxBytes: Vue.ref(16 * 1024 * 1024), ensureIdentity: async () => true,
    widgetFetch: async () => {
      if (!deferHistory) return snapshot();
      window.historyStarted = true;
      return new Promise((resolve, reject) => {
        window.releaseHistory = () => {
          deferHistory = false;
          if (window.nextHistoryFails) reject(new Error('Synthetic history failure'));
          else resolve(snapshot());
        };
      });
    },
    widgetRequest: async (_path, options) => {
      const input = JSON.parse(options.body);
      const customer = { ...input.message, seq: state.items.length + 1, authorType: 'customer', createdAt: now };
      state.items.push(customer);
      run.id = crypto.randomUUID(); run.triggerItemId = customer.id; run.status = 'running';
      state.runs = [{ ...run }];
      deferHistory = true;
      return new Response(new ReadableStream({ start(controller) {
        const emit = (name, data) => controller.enqueue(new TextEncoder().encode('event: ' + name + '\\ndata: ' + JSON.stringify(data) + '\\n\\n'));
        const replyId = crypto.randomUUID();
        emit('run', { runId: run.id, itemId: replyId, run: { ...run } });
        window.sendText = () => emit('text', { delta: 'The complete answer.' });
        window.finishReply = () => {
          const content = { parts: [{ type: 'text', text: 'The complete answer.' }] };
          const reply = { id: replyId, seq: customer.seq + 1, authorType: 'agent', agentRunId: run.id, content, createdAt: now };
          state.items.push(reply); run.status = 'completed'; state.runs = [{ ...run }];
          state.conversation.lastSeq = reply.seq; state.nextAfterSeq = reply.seq;
          emit('finish', { runId: run.id, itemId: replyId, lastSeq: reply.seq, content });
        };
        window.takeOver = () => {
          state.conversation.handling = 'human';
          state.conversation.lastSeq++; state.nextAfterSeq = state.conversation.lastSeq;
          emit('handoff', { runId: run.id, lastSeq: state.conversation.lastSeq, handling: 'human' });
        };
        window.closeStream = () => controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    },
  };
  app = Vue.createApp({ render: () => Vue.h(Chat, { productName: 'Test', openId: restoreRunning ? 'thread' : null, onBusy: value => { window.lastBusy = value; } }) });
  app.provide('widget-key', widget);
  app.provide('protocol-key', { requestPageContext: async () => ({}) });
  app.component('Icon', { render: () => null });
  app.component('WidgetEmbedParts', { props: ['content'], render() { return Vue.h('span', this.content.parts.filter(part => part.type === 'text').map(part => part.text).join('')); } });
  app.component('WidgetEmbedMarkdown', { props: ['text'], render() { return Vue.h('span', { 'data-transient': '' }, this.text); } });
  app.mount('#app');
};
`

const built = await build({
  stdin: { contents: source, resolveDir: root }, bundle: true, write: false, format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  plugins: [{ name: 'chat-fixture', setup(builder) {
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: nuxtRequire.resolve('vue/dist/vue.esm-bundler.js') }))
    builder.onResolve({ filter: /^fixture:chat$/ }, () => ({ path: 'chat', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => {
      const filename = resolve(root, 'app/components/WidgetEmbed/WidgetEmbedChat.vue')
      const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
      return { contents: compileScript(descriptor, { id: 'chat', inlineTemplate: true }).content, loader: 'ts', resolveDir: root }
    })
    builder.onResolve({ filter: /useWidgetEmbed|useWidgetProtocol|chat-image$|\.vue$/ }, args => ({ path: args.path, namespace: 'stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const widgetEmbedKey="widget-key"; export const widgetProtocolKey="protocol-key"; export const prepareChatImage=()=>{throw new Error("Unexpected upload")}; export default {render:()=>null};' }))
    builder.onResolve({ filter: /^#layers\/feedlog\// }, args => ({ path: resolve(root, args.path.replace('#layers/feedlog/', '') + '.ts') }))
  } }],
})

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  args: ['--no-sandbox'],
})
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('https://widget.test/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="app"></div>' }))
  await page.goto('https://widget.test')
  await page.addScriptTag({ content: built.outputFiles[0].text })
  const thinking = page.getByRole('status', { name: catalog.widget.thinking, exact: true })
  const replies = page.locator('[data-author=agent]')
  async function send() {
    await page.locator('textarea').fill('hi')
    await page.locator('textarea').press('Enter')
    await thinking.waitFor()
    await page.evaluate(() => window.sendText())
    await page.locator('[data-transient]').waitFor()
    assert.equal(await thinking.count(), 0, 'streaming text replaces the thinking indicator')
  }
  async function finish() {
    await page.evaluate(() => window.finishReply())
    await replies.first().waitFor()
    assert.equal(await thinking.count(), 0, 'finish must hide thinking even while the stream remains open')
    assert.equal(await page.locator('[data-transient]').count(), 0)
    assert.equal(await page.evaluate(() => window.lastBusy), true, 'transport still prevents overlapping sends')
  }
  async function closeAndRefresh(fail = false) {
    await page.evaluate(fail => { window.nextHistoryFails = fail; window.closeStream() }, fail)
    await page.waitForFunction(() => window.historyStarted)
    assert.equal(await thinking.count(), 0, 'slow history refresh must not restart thinking')
    await page.evaluate(() => window.releaseHistory())
    await page.waitForFunction(() => !window.lastBusy)
    assert.equal(await thinking.count(), 0)
    assert.equal(await page.getByText(catalog.widget.replyInterrupted, { exact: true }).count(), 0)
  }

  await page.evaluate(() => window.mountChat())
  await send(); await finish(); await closeAndRefresh()
  assert.equal(await replies.count(), 1, 'history must not duplicate the committed reply')
  console.log('PASS completed reply stays visible without thinking during stream and history delays')
  await send(); await finish(); await closeAndRefresh()
  assert.equal(await replies.count(), 2)
  console.log('PASS the next turn shows thinking normally and completes without flicker')

  await page.evaluate(() => window.mountChat())
  await send(); await finish(); await closeAndRefresh(true)
  assert.equal(await replies.count(), 1)
  console.log('PASS failed history refresh preserves the confirmed reply without thinking or an error')

  await page.evaluate(() => window.mountChat())
  await send(); await finish()
  await page.evaluate(() => window.takeOver())
  await closeAndRefresh()
  assert.equal(await replies.count(), 1)
  assert.equal(await page.locator('[data-handoff-message]').count(), 0)
  console.log('PASS deferred takeover keeps the complete answer without a customer-facing system message')

  await page.evaluate(() => window.mountChat(true))
  await thinking.waitFor()
  console.log('PASS reopening a genuinely running AI reply still shows thinking')
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
}

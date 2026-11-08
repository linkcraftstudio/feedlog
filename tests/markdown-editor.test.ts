import { useUploadImg } from '../app/composables/useUploadImg'
import { prepareLegacyAttachments } from '../app/utils/attachment'
import { renderMarkdown } from '../app/lib/markdown-render'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { getSchema, type Editor } from '@tiptap/core'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { mapTextOffset, projectMarkdownDraft, markdownSelection, restoreMarkdownSelection } from '../app/lib/markdown-selection'
import { createMarkdownManager, loadMarkdown, markdownExtensions, parseMarkdownDocument, requiresSourcePreservation, serializeMarkdown, withinMarkdownLimit } from '../app/lib/markdown-editor'

const manager = createMarkdownManager()
const fixtures = [
  '', 'Plain text', '中文输入 😀\n第二行', '## Heading\n\n**bold** *italic* ~~deleted~~ `code`',
  '- first\n- second\n  - nested', '1. first\n2. second', '- [ ] todo\n- [x] done',
  '> quote\n>\n> - nested', '---', '| A | B |\n| --- | --- |\n| one | two |',
  '[文档](https://example.com/中文)', '参考这个页面 https://example.com。后面还有话',
  '```html\n<img width="300">\n```', '![alt](attachment:uploads/a.png)',
  '![截屏](attachment:uploads/截屏 (1) #test?.png)', 'before ![alt](attachment:uploads/a.png) after',
  '```md\n![alt](attachment:uploads/a b.png)\n```', 'Prices are $20 and $30.',
]
for (const source of fixtures) {
  test(`preserves original bytes on untouched load: ${source.slice(0, 45)}`, () => {
    const loaded = loadMarkdown(source, manager)
    assert.equal(serializeMarkdown(loaded.json, loaded, manager), source)
    getSchema(markdownExtensions()).nodeFromJSON(loaded.json).check()
  })
}
for (const source of ['<div>old HTML</div>', '<img src="/a.png" style="float:right">', 'Text[^1]\n\n[^1]: footnote', '[ref]: https://example.com\n\n[ref]', '$$x^2$$', '::: unknown\nmessage\n:::']) {
  test(`preserves unsupported historical source: ${source.slice(0, 40)}`, () => {
    assert.equal(loadMarkdown(source, manager).sourceOnly, true)
  })
}
test('supports ordinary structural documents without source fallback', () => {
  for (const source of fixtures.filter(value => !value.includes('Prices'))) {
    assert.equal(loadMarkdown(source, manager).sourceOnly, false, source)
  }
})
test('keeps attachment storage keys through edits and resolves only for display', () => {
  const original = '![alt](attachment:uploads/截屏 (1) #?.png)'
  const loaded = loadMarkdown(original, manager)
  loaded.json.content!.push({ type: 'paragraph', content: [{ type: 'text', text: 'added' }] })
  const saved = manager.serialize(loaded.json)
  assert.match(saved, /attachment:uploads\/截屏 \(1\) #\?\.png/)
  assert.doesNotMatch(saved, /api\/files/)
  assert.match(renderMarkdown(saved), /\/api\/files\/uploads\/%E6/)
  assert.match(renderMarkdown(saved), /%281%29%20%23%3F.png/)
  assert.deepEqual(parseMarkdownDocument(saved, manager), loaded.json)
})
test('does not alter attachment examples inside code', () => {
  for (const source of ['`![x](attachment:a b.png)`', '```md\n![x](attachment:a b.png)\n```', '```md\n![x](attachment:a b.png)', '````md\n```\n![x](attachment:a b.png)\n````', '`example\n![x](attachment:a b.png)`', '    ![x](attachment:a b.png)']) {
    assert.equal(prepareLegacyAttachments(source), source)
    assert.equal(requiresSourcePreservation(source), false)
  }
})
test('does not turn Chinese prose into a link or break explicit international URLs', () => {
  const bare = parseMarkdownDocument('参考 https://example.com。后面还有话', manager)
  assert.doesNotMatch(JSON.stringify(bare), /"type":"link"/)
  const explicit = parseMarkdownDocument('[文档](https://example.com/中文)', manager)
  assert.match(JSON.stringify(explicit), /"href":"https:\/\/example.com\/中文"/)
})
test('length constraints count stored Markdown and allow shrinking existing over-limit text', () => {
  assert.equal(withinMarkdownLimit('**hello**', 'hello', 5), false)
  assert.equal(withinMarkdownLimit('123456', '1234567', 5), true)
  assert.equal(withinMarkdownLimit('12345678', '1234567', 5), false)
})

function editedRoundtrip(source: string) {
  const loaded = loadMarkdown(source, manager)
  assert.equal(loaded.sourceOnly, false, source)
  const edited = structuredClone(loaded.json)
  edited.content!.push({ type: 'paragraph', content: [{ type: 'text', text: 'Added paragraph' }] })
  const saved = manager.serialize(edited)
  assert.equal(JSON.stringify(parseMarkdownDocument(saved, manager)), JSON.stringify(edited))
  return { loaded, saved }
}

test('combined code marks and differently ordered link marks retain their semantics', () => {
  for (const source of ['**`parameter`**', '[`parameter`](https://example.com)', '[**link**](https://example.com)', '**[link](https://example.com)**']) {
    const { loaded } = editedRoundtrip(source)
    assert.equal(loaded.json.content![0]!.content![0]!.marks!.length, 2)
  }
})
test('code fences grow beyond nested fences and preserve literal code on edits', () => {
  const source = '````text\nExample:\n```ts\nconst x = 1\n```\n````'
  const { loaded, saved } = editedRoundtrip(source)
  assert.equal(loaded.json.content![0]!.type, 'codeBlock')
  assert.equal(loaded.json.content![0]!.content![0]!.text, 'Example:\n```ts\nconst x = 1\n```')
  assert.match(saved, /^````text/)
})
test('legacy directives are editable containers with editable titles and bodies', () => {
  for (const kind of ['tip', 'warning', 'info', 'danger', 'details', 'code-group']) {
    const { loaded, saved } = editedRoundtrip(`::: ${kind} Title\nBody **bold**\n:::`)
    assert.equal(loaded.json.content![0]!.type, 'legacyContainer')
    assert.equal(loaded.json.content![0]!.content![0]!.type, 'legacyContainerTitle')
    assert.match(saved, new RegExp(`^::: ${kind} Title`))
  }
})
test('nested containers and code examples containing closing directives remain intact', () => {
  editedRoundtrip('::: details Outer\n::: tip Inner\ntext\n:::\n```text\n:::\n```\n:::')
})
test('HTML figures preserve image dimensions, captions, anchors and literal punctuation', () => {
  const source = '<figure class="agent-screenshot">\n<img src="/image.png" alt="A &amp; B" width="496" height="776">\n<figcaption>Literal *text* and <strong>bold</strong></figcaption>\n</figure>\n\n<span id="section"></span>'
  const { loaded, saved } = editedRoundtrip(source)
  assert.equal(loaded.json.content![0]!.type, 'legacyFigure')
  assert.equal(loaded.json.content![0]!.content![0]!.attrs!.width, '496')
  assert.equal(loaded.json.content![0]!.content![1]!.content![0]!.text, 'Literal *text* and ')
  assert.equal(loaded.json.content![1]!.type, 'legacyAnchor')
  assert.match(saved, /width="496" height="776"/)
  assert.match(saved, /<strong>bold<\/strong>/)
  assert.match(saved, /<span id="section"><\/span>/)
})
test('standalone and inline HTML images remain actual images, not escaped text', () => {
  for (const source of ['<img src="/a.png" width="300">', 'before <img src="/a.png" width="300"> after']) {
    const { loaded, saved } = editedRoundtrip(source)
    assert.ok(loaded.json.content![0]!.content!.some(node => node.type === 'image'))
    assert.match(saved, /<img src="\/a.png" width="300">/)
  }
})
test('unimplemented HTML attributes or caption elements still preserve source', () => {
  for (const source of ['<figure><img src="/a.png" onclick="bad()"><figcaption>Text</figcaption></figure>', '<figure><img src="/a.png"><figcaption><span class="custom">Text</span></figcaption></figure>']) {
    assert.equal(loadMarkdown(source, manager).sourceOnly, true)
  }
})

test('unfinished feedback templates retain empty numbered list items', () => {
  for (const source of ['### Steps\n1. \n2. \n3. \n\n### Environment\n- Browser:']) {
    const { loaded } = editedRoundtrip(source)
    const lists = loaded.json.content!.filter(node => ['orderedList', 'bulletList', 'taskList'].includes(node.type!))
    assert.ok(lists.length)
    for (const list of lists) for (const item of list.content!) assert.equal(item.content![0]!.type, 'paragraph')
  }
})

test('ordinary prose mentioning directive punctuation is not a directive block', () => {
  editedRoundtrip('## Help\n\n正文中提到 ::: 语法，不应触发源码回退。')
  assert.equal(loadMarkdown('::: unknown\nbody\n:::', manager).sourceOnly, true)
})


test('selection mapping preserves original Markdown spelling and UTF-16 offsets', () => {
  const canonical = '| A | B |\n| --- | --- |\n| 😀 alpha beta | end |'
  const original = '| A    | B |\n| ----- | --- |\n| 😀 alpha beta   | end |\n'
  assert.equal(mapTextOffset(canonical, original, canonical.indexOf('beta')), original.indexOf('beta'))
  assert.equal(mapTextOffset(original, canonical, original.indexOf('beta')), canonical.indexOf('beta'))
  assert.equal(projectMarkdownDraft('before after', 'before ****after', 'before after\n'), 'before ****after\n')
})

test('source caret retains the distinction between inside and outside inline code', () => {
  const schema = getSchema(markdownExtensions())
  const source = '`test`'
  let state = EditorState.create({ schema, doc: schema.nodeFromJSON(parseMarkdownDocument(source, manager)) })
  const editor = {
    get state() { return state }, schema,
    getJSON() { return state.doc.toJSON() },
    view: { dispatch(transaction: Parameters<EditorState['apply']>[0]) { state = state.apply(transaction) } },
  } as unknown as Editor
  restoreMarkdownSelection(editor, manager, source, source.length - 1)
  assert.equal(state.selection.from, 5)
  assert.deepEqual(state.storedMarks?.map(mark => mark.type.name), ['code'])
  restoreMarkdownSelection(editor, manager, source, source.length)
  assert.equal(state.selection.from, 5)
  assert.deepEqual(state.storedMarks, [])
  const mapped = markdownSelection(editor, manager)
  assert.equal(mapped.from, source.length, 'explicit plain input state maps outside the code fence')
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)))
  assert.equal(markdownSelection(editor, manager).from, 3)
})

test('inline code saves Markdown delimiters rather than escaped literal backticks', () => {
  for (const text of ['test', 'a`b', '`test`', "'test'", 'a ** b']) {
    const json = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'code' }] }] }] }
    const saved = manager.serialize(json)
    assert.equal(saved.startsWith('\\`'), false)
    assert.deepEqual(parseMarkdownDocument(saved, manager), json)
  }
})

// Public rendering must remain safe and deterministic without browser globals.
test('public preview renders Markdown, task lists, legacy HTML and containers on the server', () => {
  const html = renderMarkdown('## Title\n\n- [x] done\n\n::: tip **Note**\nBody\n:::\n\n<figure><img src="attachment:uploads/image.png" width="320"><figcaption>Caption</figcaption></figure>')
  assert.match(html, /<h2 id="heading-0">Title<\/h2>/)
  assert.match(html, /type="checkbox" disabled checked/)
  assert.match(html, /data-md-container="tip"/)
  assert.match(html, /<strong>Note<\/strong>/)
  assert.match(html, /src="\/api\/files\/uploads\/image.png" width="320"/)
  assert.match(html, /<figcaption>Caption<\/figcaption>/)
})
test('public preview preserves the heading-id callback contract and indexes', () => {
  const seen: unknown[] = []
  const html = renderMarkdown('# A\n\n## B', heading => { seen.push(heading); return `custom-${heading.index}` })
  assert.deepEqual(seen, [{ text: 'A', level: 1, index: 0 }, { text: 'B', level: 2, index: 1 }])
  assert.match(html, /id="custom-1"/)
})
test('public preview removes executable HTML, unsafe URLs and caller-injected HTML', () => {
  const html = renderMarkdown('<script>alert(1)</script><img src="javascript:alert(1)" onerror="alert(1)"><iframe src="https://example.com"></iframe><input type="text" autofocus onfocus="alert(1)">', undefined, value => value + '<script>injected()</script><a href="javascript:alert(2)">unsafe</a>')
  assert.doesNotMatch(html, /script|iframe|javascript:|onerror|onfocus|autofocus/)
  assert.match(html, /<input type="checkbox" disabled/)
})
test('public preview keeps code fences literal, including attachment examples and HTML', () => {
  const html = renderMarkdown('```html\n<script>example()</script>\n<img src="attachment:uploads/a.png">\n```')
  assert.match(html, /&lt;script&gt;example\(\)&lt;\/script&gt;/)
  assert.match(html, /attachment:uploads\/a.png/)
})
test('historical superscript and subscript still render in public previews', () => {
  assert.match(renderMarkdown('H~2~O and x^2^'), /H<sub>2<\/sub>O and x<sup>2<\/sup>/)
})
test('server-rendered code retains frame, language, line numbers and nested fence text', () => {
  const html = renderMarkdown('````text\n嵌套代码示例：\n```js\nconsole.log("hello")\n```\n````')
  assert.match(html, /class="md-editor-code fdl-code-view"/)
  assert.match(html, /class="md-editor-code-head"/)
  assert.match(html, /class="fdl-code-language-label">Plain text<\/span>/)
  assert.match(html, /class="fdl-code-lines" aria-hidden="true">1\n2\n3\n4<\/div>/)
  assert.match(html, /console.log\("hello"\)/)
  assert.match(html, /<button type="button" class="fdl-code-collapse" aria-label="Collapse or expand code" aria-expanded="true">/)
})
test('code labels and HTML-like fence metadata stay escaped and safe', () => {
  const html = renderMarkdown('```<img/onerror=alert(1)>\n<script>literal()</script>\n```', undefined, undefined, { collapse: '收起代码', plainText: '纯文本' })
  assert.match(html, /aria-label="收起代码"/)
  assert.doesNotMatch(html, /<script|<img/)
  assert.match(html, /&lt;script&gt;literal\(\)&lt;\/script&gt;/)
  assert.match(renderMarkdown('    indented code'), /class="fdl-code-view"|class="md-editor-code fdl-code-view"/)
})

test('image uploads gate identity and report total, malformed and partial failures', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, '$fetch')
  t.after(() => { if (previous) Object.defineProperty(globalThis, '$fetch', previous); else Reflect.deleteProperty(globalThis, '$fetch') })
  let calls = 0
  let results: unknown[] = []
  Object.defineProperty(globalThis, '$fetch', { configurable: true, value: async () => {
    calls++
    const result = results.shift()
    if (result instanceof Error) throw result
    return result
  } })
  const file = new File(['image'], 'image.png', { type: 'image/png' })
  const inserted: string[][] = []
  const callback = (urls: string[]) => { inserted.push(urls) }
  await useUploadImg(async () => false).onUploadImg([file], callback)
  assert.equal(calls, 0)
  assert.deepEqual(inserted, [])
  results = [new Error('401')]
  await assert.rejects(useUploadImg().onUploadImg([file], callback), /uploadFailed/)
  results = [{}]
  await assert.rejects(useUploadImg().onUploadImg([file], callback), /uploadFailed/)
  assert.deepEqual(inserted, [])
  results = [{ key: 'valid.png' }, new Error('500')]
  await assert.rejects(useUploadImg().onUploadImg([file, file], callback), /partialUpload/)
  assert.deepEqual(inserted, [['attachment:valid.png']])
})

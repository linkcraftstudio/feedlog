import type { Editor } from '@tiptap/core'
import { diffChars } from 'diff'
import type { Mark } from '@tiptap/pm/model'
import { Selection, TextSelection } from '@tiptap/pm/state'
import type { MarkdownManager } from '@tiptap/markdown'
import { parseMarkdownDocument } from './markdown-editor'

let markerSequence = 0
function selectionMarker(source: string, kind: string) {
  let marker: string
  do { marker = `FDL${kind}${++markerSequence}END` } while (source.includes(marker))
  return marker
}

// Map UTF-16 editor offsets through Markdown normalization without rewriting source.
export function mapTextOffset(before: string, after: string, offset: number, association = 1) {
  if (before === after) return Math.max(0, Math.min(offset, after.length))
  let oldPos = 0, newPos = 0
  for (const change of diffChars(before, after)) {
    const length = change.value.length
    if (change.added) {
      if (offset === oldPos && association < 0) return newPos
      newPos += length
    } else if (change.removed) {
      if (offset < oldPos + length) return newPos
      oldPos += length
    } else {
      if (offset < oldPos + length || (offset === oldPos + length && association < 0)) return newPos + offset - oldPos
      oldPos += length; newPos += length
    }
  }
  return newPos
}

// Apply only pending-format changes to the original source, retaining its spelling.
export function projectMarkdownDraft(normalized: string, draft: string, original: string) {
  const edits: { from: number, to: number, insert: string }[] = []
  let position = 0
  let edit: typeof edits[number] | undefined
  for (const change of diffChars(normalized, draft)) {
    if (!change.added && !change.removed) {
      if (edit) edits.push(edit)
      edit = undefined
      position += change.value.length
    } else {
      edit ??= { from: position, to: position, insert: '' }
      if (change.added) edit.insert += change.value
      else { position += change.value.length; edit.to = position }
    }
  }
  if (edit) edits.push(edit)
  let result = original
  for (const item of edits.reverse()) {
    const from = mapTextOffset(normalized, original, item.from)
    const to = item.to === item.from ? from : mapTextOffset(normalized, original, item.to, -1)
    result = result.slice(0, from) + item.insert + result.slice(Math.max(from, to))
  }
  return result
}

// Mark a disposable document, never the live editor or saved Markdown.
export function markdownSelection(editor: Editor, manager: MarkdownManager, includePendingMarks = true) {
  const { from, to } = editor.state.selection
  const source = manager.serialize(editor.getJSON())
  if (from === 0 && to === editor.state.doc.content.size) return { source, from: 0, to: source.length }
  const start = selectionMarker(source, 'START')
  const end = selectionMarker(source, 'END')
  try {
    const transaction = editor.state.tr
    if (!includePendingMarks) transaction.setStoredMarks(null)
    if (from === to) {
      transaction.insertText(start, from)
      const marked = manager.serialize(transaction.doc.toJSON())
      const offset = marked.indexOf(start)
      if (offset >= 0) return { source: marked.replace(start, ''), from: offset, to: offset }
    }
    transaction.setStoredMarks(editor.state.doc.resolve(to).marks()).insertText(end, to)
    transaction.setStoredMarks(editor.state.doc.resolve(from).marks()).insertText(start, from)
    const marked = manager.serialize(transaction.doc.toJSON())
    const left = marked.indexOf(start), right = marked.indexOf(end)
    if (left >= 0 && right >= left) return { source: marked.replace(start, '').replace(end, ''), from: left, to: right - start.length }
  } catch { /* A selected block has no inline insertion position. */ }
  return { source, from: source.length, to: source.length }
}

export function restoreMarkdownSelection(editor: Editor, manager: MarkdownManager, source: string, from: number, to = from) {
  const position = (offset: number) => {
    const marker = selectionMarker(source, 'CARET')
    const json = parseMarkdownDocument(source.slice(0, offset) + marker + source.slice(offset), manager)
    const document = editor.schema.nodeFromJSON(json)
    let found: number | undefined
    let marks: readonly Mark[] = []
    document.descendants((node, pos) => {
      if (found !== undefined) return false
      if (node.isText && node.text?.includes(marker)) { found = pos + node.text.indexOf(marker); marks = node.marks }
      // A code-language placeholder is syntax, not editable code text.
      else if (Object.values(node.attrs).some(value => typeof value === 'string' && value.includes(marker))) found = pos + 1
    })
    return { position: Math.max(0, Math.min(found ?? editor.state.doc.content.size, editor.state.doc.content.size)), marks }
  }
  const start = position(from), end = from === to ? start : position(to)
  const anchor = start.position, head = end.position
  const doc = editor.state.doc
  const selection = doc.resolve(anchor).parent.inlineContent && doc.resolve(head).parent.inlineContent
    ? TextSelection.create(doc, anchor, head) : Selection.near(doc.resolve(head))
  editor.view.dispatch(editor.state.tr.setSelection(selection).setStoredMarks(selection.empty ? start.marks : null))
}

import { Extension } from '@tiptap/core'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export function writingAffordances() {
  return Extension.create({
    name: 'writingAffordances',
    addProseMirrorPlugins() {
      const editor = this.editor
      return [new Plugin({
        // A deliberate move out of a block should land in a real writing position.
        appendTransaction(transactions, _previous, state) {
          if (!editor.isEditable || !transactions.some(tr => tr.selectionSet) || state.selection.toJSON().type !== 'gapcursor') return null
          const pos = state.selection.from
          const paragraph = state.schema.nodes.paragraph
          if (!paragraph || !state.selection.$from.parent.canReplaceWith(state.selection.$from.index(), state.selection.$from.index(), paragraph)) return null
          const tr = state.tr.insert(pos, paragraph.create())
          return tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView()
        },
        props: {
          decorations(state) {
            const { selection, storedMarks, schema } = state
            const code = schema.marks.code
            if (!selection.empty || !code || !storedMarks?.some(mark => mark.type === code)) return null
            const { nodeBefore, nodeAfter } = selection.$from
            if ([nodeBefore, nodeAfter].some(node => node?.marks.some(mark => mark.type === code))) return null
            return DecorationSet.create(state.doc, [Decoration.widget(selection.from, view => {
              const hint = document.createElement('code')
              hint.className = 'fdl-pending-code'
              hint.setAttribute('aria-hidden', 'true')
              hint.addEventListener('mousedown', event => { event.preventDefault(); view.focus() })
              return hint
            }, { side: 1, key: 'pending-inline-code' })])
          },
        },
      })]
    },
  })
}

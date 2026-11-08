# Markdown editor

FeedLog uses Tiptap 3 for visual editing and CodeMirror 6 for Markdown source
editing. The toolbar, mode switch, menus, upload controls and footer belong to
FeedLog. There is no dependency on a second complete editor or an external editor
service. Markdown remains the stored body format; API requests, database columns,
search extraction and embedding inputs are unchanged.

## Ownership

- `ThemedMdEditor.vue` preserves the callers' Markdown model and named slots,
  loading `TiptapMarkdownEditor.client.vue` asynchronously after client mount.
  The engine remains the component root so caller sizing and scoped styles reach
  the actual editor frame.
- `TiptapMarkdownEditor.client.vue` owns the Tiptap instance, content limits,
  mode transitions, selection mapping, uploads and stored input marks.
- `MarkdownEditorShell.vue` owns the toolbar, menus, source CodeMirror instance,
  mode switch, preview toggle, footer and source commands. Visual commands invoke Tiptap
  directly, without executing commands against a hidden Markdown editor.
- `markdown-editor-ui.ts` groups toolbar labels and types, responsive overflow,
  keyboard navigation. Toolbar menus reuse the shared DropdownMenu components.
  `MarkdownAddressDialog.vue` shares labeled link/image fields across both modes
  using the existing Dialog, Input and Button components.
- `MarkdownLinkControls.vue` reuses Reka Popover and shared Buttons for nearby
  link actions without moving the writing caret or managing a second selection.
- `utils/attachment.ts` owns storage-key resolution, historical attachment syntax
  and Markdown image serialization, shared by editing and preview.
- `markdown-editor.css` owns the editor frame and interaction styles;
  `markdown-content.css` owns shared document typography and historical containers.
- `markdown-editor.ts` defines the schema and Markdown parsing/serialization.
  `markdown-selection.ts` maps selection through Markdown and original spacing.
- `markdown-writing.ts` provides empty inline-code affordances and continuation
  paragraphs after tables and code blocks.
- `markdown-legacy-nodes.ts` supports historical containers, figures, image
  dimensions, captions and anchors. `markdown-code-view.ts` provides code language
  selection and collapse controls, keeping the code itself editable. Its server-safe
  markup also renders public code blocks; shared document CSS keeps the dark
  frame, language label, colored header dots, line numbers and typography aligned.
- `ThemedMdPreview.vue` renders read-only public content using
  `markdown-render.ts`: Markdown parsing, legacy containers, attachment resolution,
  heading identifiers and final HTML sanitization. It works on the server and
  client. No global client plugin is required for preview configuration.

The six editing integrations are help articles, post submission, post editing,
comments, changelogs and portal welcome content. The changelog AI action is an
ordinary button in the custom toolbar slot. Native form fields and chat inputs
are unaffected.

## Behavior

Visual editing is the default for supported content. Source editing exposes the
original Markdown and uses syntax insertion commands. Both modes share one
compact toolbar and a neutral mode capsule. Format buttons expose pressed state
only in visual mode, reflecting the caret, selected text and pending input marks.
Active and hover states use neutral surfaces rather than saturated brand colors.
The heading button displays the current H1–H6 level, and the shared radio menu
marks that level on the right. Menu labels use full localized names without a
separate H1–H6 prefix. Mixed levels do not claim a single level. Paragraph reset
remains an ordinary menu action without a selected indicator.

A caret inside a link activates the link button and shows nearby URL, edit and
unlink actions. The non-modal popover preserves editor focus; Escape, leaving
the link, source mode and read-only mode dismiss it. Opening the URL uses an
explicit external-link action. Edit reuses the address dialog, with the full
anchor text and destination filled in. Updating only the destination preserves
nested emphasis; unlink keeps the text and its other marks. Visual mode also
supports Ctrl/Cmd+K for link insertion and editing.

The editor wrapper shows an immediate, localized loading frame while its client
bundle loads. The feedback dialog warms that bundle during browser idle time
before its first open; loading preserves caller sizing and prefilled content.

Visual and source surfaces share the body font family; rendered code keeps its
monospace font. Source mode retains Markdown syntax highlighting.

Portal post and comment image uploads establish a guest identity through the
existing per-action guest policy before calling the authenticated upload API.
The first guest identity does not reload the page or discard the current draft;
account switches still refresh per-user state. Failed or malformed upload
responses never insert empty content. Partial batches insert successful images
and report the failures; a retry clears the previous upload error.

External paste uses the clipboard's original text for prose without semantic
formatting, preserving line breaks and keeping an empty editor's source
byte-identical until edited. Rich HTML retains marks, lists, links, tables and
code; layout-only spacer paragraphs are removed. Known emoji images with
Unicode alt text become characters so mode changes cannot enlarge them.
Internal ProseMirror clipboard slices, real images, code whitespace and empty
table/list paragraphs retain their original meaning.

The right-hand mode capsule cannot shrink or wrap. When the toolbar no longer
fits, its formatting controls collapse into a vertical ellipsis. Hover, click
and keyboard activation open the controls; Escape closes them and restores focus
to the trigger. Mode and formatting controls preserve the document selection.
The same controls remain mounted when the available width changes. The former
500px default editor height and white/black theme surfaces are retained; caller
classes and explicit styles control the height in each page.

Mode transitions retain the Tiptap DOM and map the caret or selected range to
source offsets. Unchanged transitions restore the original selection and stored
marks. Empty pending emphasis/code delimiters are temporary source drafts and
are not persisted until the user types content. Backward selections and offsets
in non-normalized Markdown are retained. Async transitions are discarded after
an external document replacement or a newer transition.

The original source and canonical document snapshot are retained in memory.
Opening a document, changing the selection or switching modes does not rewrite
its Markdown. Undo to the original document restores the original bytes. Actual
body edits may normalize equivalent Markdown. External model replacements reset
history so undo cannot revive a previously submitted or different document.

Unsupported or unstable historical syntax is editable in source mode. Attempts
to enter visual mode show an explanation rather than silently dropping content.
Ordinary headings, emphasis, lists, tasks, blockquotes, fences, links, images,
tables, horizontal rules and supported historical containers remain structural.
Attachment keys stay opaque in storage and resolve only for rendering.

Empty inline code has a one-character orange decoration, without hint text or
stored placeholder content. New tables have blank cells with the caret in the
first header cell. Continuation paragraphs allow typing after tables and code
blocks without a large bottom padding or a custom blank-area click handler.
Code blocks reuse the shared shadcn Select for language selection and provide a collapse control, without
an editing-surface copy button. Public and editor previews retain a copy button
that copies only code, with localized feedback and an HTTP-compatible clipboard
fallback. Blank language and text/txt/plain/plaintext aliases share one plain-text
option; opening existing fences does not rewrite their stored language. Language labels use conventional names (JavaScript, TypeScript, C++, C#) in both editing and preview, while saved fences retain Markdown language identifiers.

Image paste/drop and upload menus use the existing asynchronous upload callback.
Uploads insert at the current caret after any intervening typing. Results are
ignored after a document replacement, unmount or transition into read-only mode.
Link/image addresses and image cropping reuse the shared Dialog components for
focus trapping, Escape/outside dismissal, stacking and focus restoration. The crop
dialog retains its former 668 × 421 frame, adjustable header, image selection
inside the dialog, freely resizable crop box and adjacent live preview. Cropper.js
is a standalone local dependency; the Markdown editor package is not restored.
Toolbar hover opens and switches menus immediately; ordinary tools dismiss any
previous menu. There are no hover timers or menu animations. Pointer interaction
preserves editor focus and selection; keyboard-opened menus retain normal focus
navigation and Escape restoration. Preview attachment resolution is centralized in the renderer; callers
do not rewrite Markdown or supply attachment-only HTML callbacks.

Limits apply to persisted Markdown. Existing over-limit documents remain
readable and can be shortened. Read-only mode disables document changes in both
surfaces while allowing mode changes and preview. Theme tokens and English /
Chinese labels apply to both modes and editor preview. Preview disables hidden
editing controls, and choosing an editing mode leaves preview. Fullscreen exposes
its state and exits with Escape. Source block commands act on complete lines;
code fences inserted within a paragraph are separated into standalone blocks.
Table selection supports pointer/arrow navigation, dimension feedback and a
rectangular highlight. Heading menus include a normal paragraph option.

## Validation

- `pnpm editor:test` checks round trips, source preservation, historical content,
  attachment handling, offset mapping and structural continuations.
- `pnpm editor:test:browser` runs the isolated Vue fixture against the production
  components and the project Tailwind stylesheet, without starting auth, database or AI services. It checks modes,
  selection, pending formats, undo, composition, uploads, limits, table controls,
  preview, responsive overflow, dark mode and localized labels.
- `pnpm i18n:check` checks translation key parity.

The browser runner accepts `CHROMIUM_PATH` and an optional `LD_LIBRARY_PATH` for
hosts without a system Chromium installation. Optional `EDITOR_CORPUS_PATH` and
`EDITOR_RENDER_CORPUS_PATH` enable local historical-content audits; these data
files are not committed.

Upgrade Tiptap packages together and rerun compatibility tests. The Markdown
extension is beta. CodeMirror dependencies are direct and pinned; source editing
does not rely on undocumented DOM/API behavior of a complete third-party editor.
Public preview is independently sanitized even when a caller supplies an HTML
transform. Existing `.md-editor-*` class hooks remain local CSS compatibility
hooks for page typography and sizing, not imports from the removed editor.

export function webSourceInputTypeForUrl(value: string): 'website' | 'sitemap' | 'robots' {
  const path = value.split(/[?#]/)[0] || ''
  return /\/robots\.txt\/?$/i.test(path) ? 'robots' : /\.xml(?:\.gz)?\/?$/i.test(path) ? 'sitemap' : 'website'
}
export type WebSourceTreePage = { url: string; title?: string }
export type WebSourceTreeNode<T extends WebSourceTreePage> = {
  key: string; label: string; depth: number; pages: T[]
} & ({ kind: 'folder'; children: WebSourceTreeNode<T>[] } | { kind: 'page'; page: T })

function readablePath(value: string) { try { return decodeURIComponent(value) } catch { return value } }
// Management caps nesting at three levels; discovery can show the full path tree.
export function webSourcePageTree<T extends WebSourceTreePage>(pages: T[], maxLevels = 3): WebSourceTreeNode<T>[] {
  const root: WebSourceTreeNode<T>[] = []
  for (const page of pages) {
    const segments = new URL(page.url).pathname.split('/').filter(Boolean)
    const parents = segments.slice(0, -1).slice(0, Math.max(0, maxLevels - 1))
    let container = root
    for (const [depth, part] of parents.entries()) {
      const key = '/' + parents.slice(0, depth + 1).join('/') + '/'
      let folder = container.find((node): node is WebSourceTreeNode<T> & { kind: 'folder' } => node.kind === 'folder' && node.key === key)
      if (!folder) { folder = { kind: 'folder', key, label: readablePath((depth ? '' : '/') + part), depth, pages: [], children: [] }; container.push(folder) }
      folder.pages.push(page); container = folder.children
    }
    container.push({ kind: 'page', key: page.url, label: readablePath((parents.length ? '' : '/') + segments.slice(parents.length).join('/')), depth: parents.length, pages: [page], page })
  }
  const sort = (nodes: WebSourceTreeNode<T>[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'folder' ? -1 : 1))
    for (const node of nodes) if (node.kind === 'folder') sort(node.children)
  }
  sort(root)
  return root
}
export function flattenWebSourcePageTree<T extends WebSourceTreePage>(nodes: WebSourceTreeNode<T>[], opened: ReadonlySet<string>, searching = false): WebSourceTreeNode<T>[] {
  return nodes.flatMap(node => node.kind === 'folder' && (searching || opened.has(node.key)) ? [node, ...flattenWebSourcePageTree(node.children, opened, searching)] : [node])
}

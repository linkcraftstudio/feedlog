const MAX_CACHE_SIZE = 20

export const usePostDetailStore = defineStore('postDetail', () => {
  // ---- State (plain objects for SSR serialization) ----
  const posts = ref<Record<string, PostDetail>>({})
  const commentsMap = ref<Record<string, CommentItem[]>>({})
  const commentCursors = ref<Record<string, string | null>>({})

  const postLoadingMap = ref<Record<string, boolean>>({})        // key: slug
  const commentLoadingMap = ref<Record<string, boolean>>({})     // key: postId
  const moreCommentLoadingMap = ref<Record<string, boolean>>({}) // key: postId

  // In-flight fetchPost promises for dedup (private, not serialized)
  const postFetchPromises = new Map<string, Promise<void>>()

  // Access order tracking for LRU eviction
  const accessOrder = ref<string[]>([])

  // ---- Accessor helpers ----

  function getPost(slug: string): PostDetail | null {
    return posts.value[slug] ?? null
  }

  function getComments(slug: string): CommentItem[] {
    const postId = posts.value[slug]?.id
    if (!postId) return []
    return commentsMap.value[postId] ?? []
  }

  function getCommentCursor(slug: string): string | null {
    const postId = posts.value[slug]?.id
    if (!postId) return null
    return commentCursors.value[postId] ?? null
  }

  function isPostLoading(slug: string): boolean {
    return postLoadingMap.value[slug] ?? false
  }

  function isCommentLoading(slug: string): boolean {
    const postId = posts.value[slug]?.id
    if (!postId) return false
    return commentLoadingMap.value[postId] ?? false
  }

  function isMoreCommentLoading(slug: string): boolean {
    const postId = posts.value[slug]?.id
    if (!postId) return false
    return moreCommentLoadingMap.value[postId] ?? false
  }

  // ---- Cache management ----
  function touchCache(slug: string) {
    const order = accessOrder.value
    const idx = order.indexOf(slug)
    if (idx !== -1) order.splice(idx, 1)
    order.push(slug)

    while (order.length > MAX_CACHE_SIZE) {
      const evicted = order.shift()!
      const evictedPost = posts.value[evicted]
      delete posts.value[evicted]
      if (evictedPost) {
        delete commentsMap.value[evictedPost.id]
        delete commentCursors.value[evictedPost.id]
      }
    }
  }

  // ---- Actions ----

  function prefill(slug: string, item: PostListItem) {
    if (posts.value[slug]) return
    posts.value[slug] = {
      id: item.id,
      slug: item.slug,
      title: item.title,
      content: '',
      status: item.status,
      boardId: item.boardId,
      voteCount: item.voteCount,
      commentCount: item.commentCount,
      mergedCount: item.mergedCount,
      mergedTo: null,
      hasVoted: item.hasVoted,
      author: item.author,
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
    }
    touchCache(slug)
  }

  function setPost(slug: string, data: PostDetail) {
    posts.value[slug] = data
    touchCache(slug)
  }

  async function fetchPost(slug: string): Promise<void> {
    // Dedup concurrent calls so callers that fire fetchPost + fetchComments
    // in parallel only trigger one network request.
    const inflight = postFetchPromises.get(slug)
    if (inflight) return inflight

    postLoadingMap.value[slug] = true
    const promise = (async () => {
      try {
        const data = await useApiFetch<PostDetail>(`/api/posts/${slug}`)
        posts.value[slug] = data
        touchCache(slug)
      } finally {
        postLoadingMap.value[slug] = false
        postFetchPromises.delete(slug)
      }
    })()
    postFetchPromises.set(slug, promise)
    return promise
  }

  function setComments(slug: string, comments: CommentItem[], nextCursor: string | null) {
    const p = posts.value[slug]
    if (!p) return
    commentsMap.value[p.id] = comments
    commentCursors.value[p.id] = nextCursor
  }

  async function fetchComments(slug: string, sort: string = 'newest') {
    // Comments API is keyed by postId, so the post must be loaded first.
    // Ensure it here instead of relying on every caller to await fetchPost.
    if (!posts.value[slug]) {
      await fetchPost(slug)
    }
    const p = posts.value[slug]
    if (!p) return

    commentLoadingMap.value[p.id] = true
    try {
      const data = await useApiFetch<{ data: CommentItem[]; pagination: { nextCursor: string | null } }>(
        `/api/posts/${p.id}/comments`,
        { query: { sort, withChildren: 'true', limit: 10 } },
      )
      commentsMap.value[p.id] = data.data
      commentCursors.value[p.id] = data.pagination.nextCursor
    } finally {
      commentLoadingMap.value[p.id] = false
    }
  }

  async function loadMoreComments(slug: string, sort: string = 'newest') {
    const p = posts.value[slug]
    if (!p) return
    const cursor = commentCursors.value[p.id]
    if (!cursor) return

    moreCommentLoadingMap.value[p.id] = true
    try {
      const data = await useApiFetch<{ data: CommentItem[]; pagination: { nextCursor: string | null } }>(
        `/api/posts/${p.id}/comments`,
        { query: { sort, withChildren: 'true', limit: 10, cursor } },
      )
      const existing = commentsMap.value[p.id] ?? []
      commentsMap.value[p.id] = [...existing, ...data.data]
      commentCursors.value[p.id] = data.pagination.nextCursor
    } finally {
      moreCommentLoadingMap.value[p.id] = false
    }
  }

  async function loadMoreChildren(slug: string, parentId: string) {
    const p = posts.value[slug]
    if (!p) return
    const list = commentsMap.value[p.id]
    if (!list) return
    const parent = list.find(c => c.id === parentId)
    if (!parent?.children?.length) return

    const lastChild = parent.children[parent.children.length - 1]
    const cursor = btoa(JSON.stringify({
      s: new Date(lastChild.createdAt).toISOString(),
      id: lastChild.id,
    })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

    const data = await useApiFetch<{ data: CommentItem[]; pagination: { nextCursor: string | null } }>(
      `/api/posts/${p.id}/comments`,
      { query: { parentId, limit: 10, cursor } },
    )
    parent.children.push(...data.data)
  }

  async function vote(slug: string) {
    const p = posts.value[slug]
    if (!p || p.hasVoted) return

    p.hasVoted = true
    p.voteCount++

    try {
      const res = await useApiFetch<{ voted: boolean; voteCount: number }>(
        `/api/posts/${p.id}/vote`,
        { method: 'POST' },
      )
      p.voteCount = res.voteCount
      p.hasVoted = res.voted
      p.subscribed = true // voting auto-subscribes on the backend
    } catch {
      p.hasVoted = false
      p.voteCount--
    }
  }

  async function unvote(slug: string) {
    const p = posts.value[slug]
    if (!p || !p.hasVoted) return

    p.hasVoted = false
    p.voteCount--

    try {
      const res = await useApiFetch<{ voted: boolean; voteCount: number }>(
        `/api/posts/${p.id}/vote`,
        { method: 'DELETE' },
      )
      p.voteCount = res.voteCount
      p.hasVoted = res.voted
    } catch {
      p.hasVoted = true
      p.voteCount++
    }
  }

  async function addComment(
    slug: string,
    content: string,
    opts: { parentId?: string; replyToId?: string; notify?: boolean } = {},
  ) {
    const { parentId, replyToId, notify } = opts
    const p = posts.value[slug]
    if (!p) return

    const res = await useApiFetch<CommentItem>(
      `/api/posts/${p.id}/comments`,
      { method: 'POST', body: { content, parentId, replyToId, notifyVoters: notify } },
    )

    const list = commentsMap.value[p.id]
    if (list) {
      if (parentId) {
        const parent = list.find(c => c.id === parentId)
        if (parent) {
          if (!parent.children) parent.children = []
          parent.children.push(res)
          parent.replyCount = (parent.replyCount ?? 0) + 1
        }
      } else {
        list.unshift(res)
      }
    }

    p.commentCount++
    return res
  }

  async function updateComment(slug: string, commentId: string, content: string) {
    const res = await useApiFetch<CommentItem>(
      `/api/comments/${commentId}`,
      { method: 'PATCH', body: { content } },
    )
    updateCommentInList(slug, commentId, res)
    return res
  }

  async function deleteComment(slug: string, commentId: string) {
    await useApiFetch(`/api/comments/${commentId}`, { method: 'DELETE' })

    const p = posts.value[slug]
    if (!p) return
    const list = commentsMap.value[p.id]
    if (!list) return

    const topIdx = list.findIndex(c => c.id === commentId)
    if (topIdx !== -1) {
      const removed = list[topIdx]
      const removedCount = 1 + (removed.replyCount ?? 0)
      list.splice(topIdx, 1)
      p.commentCount -= removedCount
    } else {
      for (const parent of list) {
        if (!parent.children) continue
        const childIdx = parent.children.findIndex(c => c.id === commentId)
        if (childIdx !== -1) {
          parent.children.splice(childIdx, 1)
          parent.replyCount = Math.max((parent.replyCount ?? 0) - 1, 0)
          p.commentCount--
          break
        }
      }
    }
  }

  async function likeComment(slug: string, commentId: string) {
    const target = findComment(slug, commentId)
    if (!target || target.hasLiked) return
    target.hasLiked = true
    target.likeCount++

    try {
      const res = await useApiFetch<{ liked: boolean; likeCount: number }>(
        `/api/comments/${commentId}/like`,
        { method: 'POST' },
      )
      target.likeCount = res.likeCount
      target.hasLiked = res.liked
    } catch {
      target.hasLiked = false
      target.likeCount--
    }
  }

  async function unlikeComment(slug: string, commentId: string) {
    const target = findComment(slug, commentId)
    if (!target || !target.hasLiked) return
    target.hasLiked = false
    target.likeCount--

    try {
      const res = await useApiFetch<{ liked: boolean; likeCount: number }>(
        `/api/comments/${commentId}/like`,
        { method: 'DELETE' },
      )
      target.likeCount = res.likeCount
      target.hasLiked = res.liked
    } catch {
      target.hasLiked = true
      target.likeCount++
    }
  }

  async function updatePost(
    slug: string,
    data: { title?: string; content?: string; status?: string; boardId?: string | null },
    isAdmin = false,
  ) {
    const p = posts.value[slug]
    if (!p) return
    const endpoint = isAdmin ? `/api/admin/posts/${p.id}` : `/api/posts/${p.id}`
    const res = await useApiFetch<any>(endpoint, { method: 'PATCH', body: data })
    if (res.title) p.title = res.title
    if (res.content !== undefined) p.content = res.content
    if (res.status) p.status = res.status
    if (res.boardId !== undefined) p.boardId = res.boardId
    if (res.updatedAt) p.updatedAt = res.updatedAt
  }

  async function deletePost(slug: string) {
    const p = posts.value[slug]
    if (!p) return
    await useApiFetch(`/api/admin/posts/${p.id}`, { method: 'DELETE' })
    delete posts.value[slug]
    delete commentsMap.value[p.id]
    delete commentCursors.value[p.id]
  }

  // ---- Private helpers ----

  function findComment(slug: string, commentId: string): CommentItem | null {
    const postId = posts.value[slug]?.id
    if (!postId) return null
    const list = commentsMap.value[postId] ?? []
    for (const c of list) {
      if (c.id === commentId) return c
      if (c.children) {
        const child = c.children.find(ch => ch.id === commentId)
        if (child) return child
      }
    }
    return null
  }

  function updateCommentInList(slug: string, commentId: string, updated: CommentItem) {
    const postId = posts.value[slug]?.id
    if (!postId) return
    const list = commentsMap.value[postId] ?? []
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === commentId) {
        list[i] = { ...updated, children: list[i].children }
        return
      }
      if (list[i].children) {
        for (let j = 0; j < list[i].children!.length; j++) {
          if (list[i].children![j].id === commentId) {
            list[i].children![j] = updated
            return
          }
        }
      }
    }
  }

  return {
    // Accessors
    getPost,
    getComments,
    getCommentCursor,
    isPostLoading,
    isCommentLoading,
    isMoreCommentLoading,
    // Actions
    prefill,
    setPost,
    fetchPost,
    setComments,
    fetchComments,
    loadMoreComments,
    loadMoreChildren,
    vote,
    unvote,
    addComment,
    updateComment,
    deleteComment,
    likeComment,
    unlikeComment,
    updatePost,
    deletePost,
  }
})

import { guestTag } from '#layers/feedlog/shared/utils/identity'

// How an author's name is shown.
//
// The name stored on a guest row is English by construction, and `user.name` is a
// global field that can't carry a locale — so the label is composed here from the
// user id instead of rendered from the column.
//
// The avatar itself lives in <UserAvatar>.

export interface DisplayableAuthor {
  id?: string | null
  name?: string | null
  isAnonymous?: boolean | null
}

export function useAuthorDisplay() {
  const { t } = useI18n()

  function authorName(author?: DisplayableAuthor | null): string {
    if (author?.isAnonymous && author.id) return t('common.guest', { tag: guestTag(author.id) })
    return author?.name || t('common.anonymous')
  }

  // Guests never reach this: their avatar is a glyph, because two characters sat
  // between a comment count and a clock read as a number, not as a person.
  function authorInitials(author?: DisplayableAuthor | null): string {
    return (author?.name || '?').slice(0, 2).toUpperCase()
  }

  return { authorName, authorInitials }
}

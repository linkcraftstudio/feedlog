// Things derived from a user id rather than stored: they can never drift from
// the row they describe, and they cost no column.

// FNV-1a folded to 16 bits. Not a hash for security — it only has to be stable
// and evenly spread across ids.
export function stableIdHash(seed: string): number {
  let h = 0x811C9DC5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return ((h >>> 16) ^ (h & 0xFFFF)) & 0xFFFF
}

// Short tag appended to a guest's display name, so two guests in one thread read
// as two people while one guest reads as the same person across their posts.
export function guestTag(userId: string): string {
  return stableIdHash(userId).toString(16).padStart(4, '0')
}

// Hue for the generated avatar, for everyone — not just guests. Colour answers
// "who is this"; the avatar's shape (picture / initials / glyph) is what answers
// "how much identity do we have", which reads without learning a colour rule and
// survives colour-blindness.
export function avatarHue(userId: string): number {
  return (stableIdHash(`hue:${userId}`) * 360) >> 16
}

import { z } from 'zod/v4'

export const DEFAULT_BRAND_COLOR = '#C45A46'
export const DEFAULT_WELCOME_TITLE = ''
export const DEFAULT_WELCOME_DESCRIPTION = ''

export const portalThemeSchema = z.enum(['system', 'light', 'dark'])
export type PortalTheme = z.infer<typeof portalThemeSchema>

export const brandingSchema = z.object({
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  defaultTheme: portalThemeSchema.optional(),
  welcomeTitle: z.string().max(160).optional(),
  welcomeDescription: z.string().max(10000).optional(),
})

export type Branding = z.infer<typeof brandingSchema>

export interface ResolvedBranding {
  primaryColor: string
  defaultTheme: PortalTheme
  welcomeTitle: string
  welcomeDescription: string
}

interface Oklch {
  l: number
  c: number
  h: number
}

const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)

function hexToLinear(hex: string): [number, number, number] {
  const raw = hex.replace('#', '').trim()
  return [
    lin(parseInt(raw.slice(0, 2), 16) / 255),
    lin(parseInt(raw.slice(2, 4), 16) / 255),
    lin(parseInt(raw.slice(4, 6), 16) / 255),
  ]
}

function linearToOklch([lr, lg, lb]: [number, number, number]): Oklch {
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
  const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
  const b = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  const c = Math.sqrt(a * a + b * b)
  let h = Math.atan2(b, a) * 180 / Math.PI
  if (h < 0) h += 360
  return { l: L, c, h }
}

function oklchToLinear({ l: L, c: C, h: H }: Oklch): [number, number, number] {
  const hr = H * Math.PI / 180
  const a = C * Math.cos(hr)
  const b = C * Math.sin(hr)
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  return [
    clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_),
  ]
}

const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const contrast = (y1: number, y2: number) => (Math.max(y1, y2) + 0.05) / (Math.min(y1, y2) + 0.05)
const WHITE_FG = { css: 'oklch(1 0 0)', y: 1 }
const DARK_FG = { css: 'oklch(0.275 0.009 28.9)', y: luminance(oklchToLinear({ l: 0.275, c: 0.009, h: 28.9 })) }

function pickForeground(accent: Oklch): string {
  const y = luminance(oklchToLinear(accent))
  return contrast(y, WHITE_FG.y) >= contrast(y, DARK_FG.y) ? WHITE_FG.css : DARK_FG.css
}

const round = (n: number, d = 3) => Number(n.toFixed(d))
const oklchStr = ({ l, c, h }: Oklch) => `oklch(${round(l)} ${round(c)} ${round(h, 1)})`

export function isValidBrandHex(hex: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(hex.trim())
}

export function normalizeBrandHex(hex: string | undefined | null): string {
  if (!hex) return DEFAULT_BRAND_COLOR
  const trimmed = hex.trim()
  const normalized = trimmed.startsWith('#') ? trimmed : `#${trimmed}`
  return isValidBrandHex(normalized) ? normalized.toUpperCase() : DEFAULT_BRAND_COLOR
}

export function deriveBrandVars(seedHex: string, isDark: boolean): Record<string, string> {
  const normalized = normalizeBrandHex(seedHex)
  const seed = linearToOklch(hexToLinear(normalized))
  const hue = round(seed.h, 1)
  const primary: Oklch = isDark
    ? { l: Math.min(0.85, Math.max(seed.l + 0.05, 0.62)), c: seed.c, h: seed.h }
    : seed
  // The base theme ships a distinct, brighter accent (orange) sitting next to the
  // terracotta primary. With a single tenant seed we approximate that lift so
  // accent-driven highlights (menu focus, identity chips) track the brand instead
  // of staying FeedLog orange. Foreground is contrast-picked per accent lightness.
  const accent: Oklch = isDark
    ? { l: Math.min(0.88, Math.max(primary.l + 0.06, 0.68)), c: seed.c, h: seed.h }
    : { l: Math.min(0.80, seed.l + 0.10), c: seed.c, h: seed.h }

  return {
    '--primary': oklchStr(primary),
    '--ring': oklchStr(primary),
    '--primary-foreground': pickForeground(primary),
    '--accent': oklchStr(accent),
    '--accent-foreground': pickForeground(accent),
    '--secondary': isDark
      ? `oklch(0.300 0.020 ${hue})`
      : `oklch(0.959 0.016 ${hue})`,
  }
}

// Full neutral set per mode (pure gray, chroma 0). Both modes list every neutral
// token the portal surfaces use so the override is self-contained: the in-dashboard
// live preview can render either mode without inheriting the dashboard's own theme
// for any un-listed token (e.g. --card / --border), and the portal SSR override is
// likewise complete.
const LIGHT_NEUTRALS: Record<string, [number, number]> = {
  '--background': [0.983, 0],
  '--foreground': [0.275, 0],
  '--card': [1, 0],
  '--muted': [0.983, 0],
  '--muted-foreground': [0.644, 0],
  '--border': [0.911, 0],
  '--input': [0.911, 0],
}

const DARK_NEUTRALS: Record<string, [number, number]> = {
  '--background': [0.200, 0],
  '--foreground': [0.985, 0],
  '--card': [0.250, 0],
  '--muted': [0.300, 0],
  '--muted-foreground': [0.708, 0],
  '--border': [0.320, 0],
  '--input': [0.320, 0],
}

export function deriveNeutralVars(isDark: boolean): Record<string, string> {
  const set = isDark ? DARK_NEUTRALS : LIGHT_NEUTRALS
  return Object.fromEntries(Object.entries(set).map(([key, [l, c]]) => [key, `oklch(${l.toFixed(3)} ${c} 0)`]))
}

export function derivePortalThemeVars(seedHex: string, isDark: boolean): Record<string, string> {
  return {
    ...deriveNeutralVars(isDark),
    ...deriveBrandVars(seedHex, isDark),
  }
}

export function styleObjectToCss(vars: Record<string, string>): string {
  return Object.entries(vars).map(([key, value]) => `${key}: ${value};`).join(' ')
}

export type OrgMetadataInput = string | Record<string, unknown> | null | undefined

export function parseOrgMetadata(metadata: OrgMetadataInput): Record<string, unknown> {
  if (!metadata) return {}
  if (typeof metadata === 'object' && !Array.isArray(metadata)) return metadata
  try {
    const parsed = JSON.parse(metadata)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export function parseBranding(metadata: OrgMetadataInput): Branding {
  const raw = parseOrgMetadata(metadata).branding
  const result = brandingSchema.safeParse(raw)
  return result.success ? result.data : {}
}

export function resolveBranding(metadata: OrgMetadataInput): ResolvedBranding {
  const branding = parseBranding(metadata)
  return {
    primaryColor: normalizeBrandHex(branding.primaryColor),
    defaultTheme: branding.defaultTheme ?? 'system',
    welcomeTitle: branding.welcomeTitle?.trim() ?? DEFAULT_WELCOME_TITLE,
    welcomeDescription: branding.welcomeDescription?.trim() ?? DEFAULT_WELCOME_DESCRIPTION,
  }
}

export function mergeBrandingMetadata(metadata: OrgMetadataInput, branding: Branding): Record<string, unknown> {
  const current = parseOrgMetadata(metadata)
  return {
    ...current,
    branding: brandingSchema.parse(branding),
  }
}

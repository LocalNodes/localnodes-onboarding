import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Guard for the design tokens on the Nuxt side (fresh3 22.1-08, DES-01, D-03, D-08).
 *
 * Every colour in this app comes from app/assets/css/ln-tokens.css, which
 * fresh3's scripts/tokens/build_tokens.mjs generates from the one token source.
 * This test fails when:
 *   - the generated file loses its GENERATED header, or main.css stops importing it,
 *   - app.config.ts stops naming the role palettes ln-brand, ln-accent, ln-neutral,
 *   - any other file under app/ holds a hex, rgb or hsl literal, a Tailwind palette
 *     utility (black and white included) or a hue-named palette.
 * So a palette swap stays a token change plus a regenerate, with no component edit.
 */
const root = resolve(__dirname, '../..')
const appDir = join(root, 'app')
const GENERATED = join(appDir, 'assets/css/ln-tokens.css')

const read = (path: string) => readFileSync(path, 'utf8')

/** All files under dir (absolute paths), skipping nothing. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

/** Colour words Tailwind and Nuxt UI know as palettes. */
const HUES = 'slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
/** Hue names for role-palette checks: `neutral` is also a role name (ln-neutral), so it is not a hue here. */
const HUE_NAMES = HUES.replace('neutral|', '')
/** Utilities that take a colour. */
const COLOR_UTILS = 'bg|text|border|ring|ring-offset|outline|divide|fill|stroke|from|via|to|shadow|accent|caret|decoration|placeholder'

/**
 * What the app may not hold outside the generated file. Each rule has a name for the failure message.
 * Semantic utilities (bg-default, text-muted, bg-primary, border-accented...) are allowed: they are
 * not in the palette list and resolve through the tokens.
 */
const RULES: Array<{ name: string, pattern: RegExp }> = [
  { name: 'hex colour', pattern: /#[0-9a-fA-F]{3,8}\b/ },
  { name: 'rgb()/rgba() colour', pattern: /\brgba?\(/ },
  { name: 'hsl()/hsla() colour', pattern: /\bhsla?\(/ },
  { name: 'oklch()/oklab()/lab()/lch() colour', pattern: /\b(oklch|oklab|lab|lch)\(/ },
  {
    name: 'Tailwind palette utility',
    pattern: new RegExp(`(^|[\\s"'\`:!])(?:[a-z-]+:)*-?(${COLOR_UTILS})-(${HUES})-\\d{2,3}\\b`),
  },
  {
    name: 'black or white colour utility',
    pattern: new RegExp(`(^|[\\s"'\`:!])(?:[a-z-]+:)*-?(${COLOR_UTILS})-(black|white)\\b`),
  },
  { name: 'hue-named palette (ln-teal, ln-amber, --color-ln-<hue>)', pattern: new RegExp(`\\bln-(${HUE_NAMES})\\b`) },
  { name: 'built-in palette variable (var(--color-<hue>-NNN))', pattern: new RegExp(`--color-(${HUES})-\\d{2,3}\\b`) },
]

/** The first rule a text breaks, with the matching line, or null. */
function violation(text: string): string | null {
  const lines = text.split('\n')
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      if (rule.pattern.test(lines[i]!)) return `${rule.name} on line ${i + 1}: ${lines[i]!.trim()}`
    }
  }
  return null
}

const TEXT_FILE = /\.(vue|ts|js|mjs|css|scss|html|json|yml|yaml|md|svg)$/

/** Every violation under app/, except the generated file. */
function scanApp(): string[] {
  const found: string[] = []
  for (const file of walk(appDir)) {
    if (file === GENERATED || !TEXT_FILE.test(file)) continue
    const hit = violation(read(file))
    if (hit) found.push(`${file.slice(root.length + 1)}: ${hit}`)
  }
  return found
}

describe('Nuxt design tokens', () => {
  it('ln-tokens.css is generated and says so in its first three lines', () => {
    expect(existsSync(GENERATED)).toBe(true)
    const head = read(GENERATED).split('\n').slice(0, 3).join('\n')
    expect(head).toMatch(/GENERATED/)
    expect(head).toMatch(/build_tokens\.mjs/)
  })

  it('the generated file holds the role palettes and both role blocks', () => {
    const css = read(GENERATED)
    for (const palette of ['brand', 'accent', 'neutral']) {
      for (const shade of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
        expect(css).toContain(`--color-ln-${palette}-${shade}:`)
      }
    }
    expect(css).toMatch(/@theme static \{/)
    expect(css).toMatch(/:root \{/)
    expect(css).toMatch(/\.dark \{/)
    expect(css).toContain('--ui-primary:')
  })

  it('main.css imports the generated file after tailwindcss and @nuxt/ui', () => {
    const css = read(join(appDir, 'assets/css/main.css'))
    const tailwind = css.indexOf('@import "tailwindcss"')
    const ui = css.indexOf('@import "@nuxt/ui"')
    const tokens = css.search(/@import\s+["']\.\/ln-tokens\.css["']/)
    expect(tailwind).toBeGreaterThanOrEqual(0)
    expect(ui).toBeGreaterThan(tailwind)
    expect(tokens).toBeGreaterThan(ui)
  })

  it('app.config.ts names ln-brand, ln-accent and ln-neutral as the Nuxt UI colours', () => {
    const config = read(join(appDir, 'app.config.ts'))
    expect(config).toMatch(/primary:\s*'ln-brand'/)
    expect(config).toMatch(/secondary:\s*'ln-accent'/)
    expect(config).toMatch(/neutral:\s*'ln-neutral'/)
  })

  it('no file under app/ other than the generated one holds a raw colour, palette utility or hue name', () => {
    expect(scanApp()).toEqual([])
  })
})

describe('the raw-colour scan fires (it is not vacuous)', () => {
  it('flags each kind of literal it claims to catch', () => {
    const bad = [
      'color: #0f766e;',
      'color: #fff;',
      'background: rgb(1 2 3);',
      'background: rgba(1, 2, 3, .5);',
      'color: hsl(10 20% 30%);',
      'color: oklch(0.5 0.1 200);',
      '<div class="bg-teal-600 text-white">',
      '<div class="hover:bg-blue-500">',
      '<div class="dark:border-zinc-800">',
      '<div class="text-white">',
      '<div class="bg-black/50">',
      "primary: 'ln-teal'",
      'fill: var(--color-zinc-800);',
    ]
    for (const line of bad) expect(violation(line), line).not.toBeNull()
  })

  it('lets the semantic utilities through', () => {
    const ok = [
      '<div class="bg-default text-muted border-default">',
      '<div class="bg-primary text-inverted ring-primary">',
      '<div class="bg-elevated text-highlighted border-accented">',
      '<UButton color="primary" variant="solid" />',
      'font-size: 1rem; background: var(--ui-bg);',
    ]
    for (const line of ok) expect(violation(line), line).toBeNull()
  })

  it('fails the app scan when a planted literal sits in a component (written and removed here)', () => {
    const planted = join(appDir, 'components/__token_guard_probe__.vue')
    mkdirSync(join(appDir, 'components'), { recursive: true })
    try {
      writeFileSync(planted, '<template><p style="color: #0f766e">x</p></template>\n')
      const found = scanApp()
      expect(found.length).toBeGreaterThan(0)
      expect(found.some((line) => line.includes('__token_guard_probe__.vue'))).toBe(true)
    } finally {
      rmSync(planted, { force: true })
    }
    expect(existsSync(planted)).toBe(false)
  })
})

// --- solid secondary buttons (orchestrator hand-off from 22.1-05, 2026-11-08) ---
// Nuxt UI draws a solid secondary button as white text (text-inverted) on the
// amber fill, 1.62:1. Nothing on the sign-up site uses one yet; app.config.ts
// guards it with dark text (text-default), checked here against the tokens.
describe('a solid secondary button has readable text', () => {
  const tokens = read(GENERATED)
  const light = tokens.slice(tokens.indexOf(':root {'), tokens.indexOf('}', tokens.indexOf(':root {')))
  const role = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6});`).exec(light)?.[1] ?? ''
  const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  const lum = ([r, g, b]: number[]) => {
    const c = (v: number) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * c(r!) + 0.7152 * c(g!) + 0.0722 * c(b!)
  }
  const ratio = (a: number[], b: number[]) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi! + 0.05) / (lo! + 0.05)
  }
  /** The fill at 75% over the white page (Nuxt UI's hover:bg-secondary/75). */
  const over = (fill: number[], alpha: number, bg: number[]) => fill.map((v, i) => Math.round(v * alpha + bg[i]! * (1 - alpha)))

  it('app.config.ts gives a solid secondary button text-default, next to the primary entries', () => {
    const config = read(join(appDir, 'app.config.ts'))
    expect(config).toMatch(/\{ color: 'secondary', variant: 'solid', class: 'text-default' \}/)
  })

  it('Nuxt UI\'s own white text on the secondary fill is under 4.5:1 (why the guard exists)', () => {
    expect(ratio(rgb(role('--ui-text-inverted')), rgb(role('--ui-secondary')))).toBeLessThan(4.5)
  })

  it('text-default on the secondary fill, and on its 75% hover over white, is at least 4.5:1', () => {
    const text = rgb(role('--ui-text'))
    const fill = rgb(role('--ui-secondary'))
    expect(ratio(text, fill)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(text, over(fill, 0.75, rgb(role('--ui-bg'))))).toBeGreaterThanOrEqual(4.5)
  })
})

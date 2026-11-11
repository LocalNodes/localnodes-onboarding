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

// --- the one home-page colour file ---
// The home page restates the brand scale and the --ui-* roles per context, so
// colour literals have to live somewhere. They live in app/assets/css/home-v5.css
// only, only as custom-property declarations with an allowed name, only under
// the four allowed selectors. Everything else in that file, and every other
// file under app/, still holds no colour literal.
const HOME_CSS = join(appDir, 'assets/css/home-v5.css')
const HOME_SELECTORS = new Set(['html.ln-home', 'html.ln-home .home-dark', 'html.ln-home .home-light', 'html.ln-home .home-note'])
const HOME_PROPERTY = /^--(ui-[a-z0-9-]+|home-[a-z0-9-]+|color-ln-brand-(50|100|200|300|400|500|600|700|800|900|950))$/
const MEDIA_OK = /^@media\s+\(\s*(prefers-reduced-motion\s*:\s*(reduce|no-preference)|(min|max)-width\s*:\s*[0-9.]+(px|em|rem))\s*\)(\s+and\s+\(\s*(min|max)-width\s*:\s*[0-9.]+(px|em|rem)\s*\))*$/i
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|lab|lch)\(/
// Every CSS named colour (CSS Color 4; transparent and currentcolor are not literals). A name counts
// only as a whole word: not inside a longer name, a custom property or a function (var(--ui-red-text)).
const NAMED_COLOURS = 'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(' ')
const NAMED_COLOUR = new RegExp(`(?<![\\w-])(${NAMED_COLOURS.join('|')})(?![\\w(-])`, 'i')

interface CssBlock { prelude: string, body: string, children: CssBlock[], hasBlock: boolean }

/**
 * The CSS with comments, string contents and escapes made inert, so a brace, quote or semicolon
 * inside one cannot move a block edge: a comment becomes one space, the inside of a string
 * becomes underscores (the quotes stay), a backslash and the character it escapes become
 * underscores, and an unquoted url( is read to its closing paren. Anything it cannot read
 * throws, so the guard fails closed: an unterminated string or comment, a newline in a
 * string, an unmatched or unclosed brace or paren, or a quote, paren or brace in an unquoted url.
 */
function sanitizeCss(css: string): string {
  const n = css.length
  let out = ''
  let i = 0
  let braces = 0
  let parens = 0
  const fail = (why: string): never => {
    throw new Error(`unparseable CSS: ${why} (offset ${i})`)
  }
  while (i < n) {
    const c = css[i]!
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      if (end < 0) fail('unterminated comment')
      out += ' '
      i = end + 2
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let s = c
      for (;;) {
        if (j >= n) fail('unterminated string')
        const d = css[j]!
        if (d === '\\') {
          if (j + 1 >= n) fail('unterminated string')
          s += '__'
          j += 2
        } else if (d === c) {
          s += c
          j++
          break
        } else if (d === '\n') {
          fail('newline in a string')
        } else {
          s += '_'
          j++
        }
      }
      out += s
      i = j
      continue
    }
    if (c === '\\') {
      if (i + 1 >= n) fail('backslash at the end')
      out += '__'
      i += 2
      continue
    }
    if ((c === 'u' || c === 'U') && css.slice(i, i + 4).toLowerCase() === 'url(' && (i === 0 || !/[\w-]/.test(css[i - 1]!))) {
      let j = i + 4
      while (j < n && /\s/.test(css[j]!)) j++
      if (css[j] !== '"' && css[j] !== "'") {
        // Unquoted url: opaque up to the closing paren.
        let s = css.slice(i, i + 4)
        for (j = i + 4; ; j++) {
          if (j >= n) fail('unterminated url(')
          const d = css[j]!
          if (d === ')') break
          if (d === '"' || d === "'" || d === '(' || d === '{' || d === '}') fail(`${d} inside an unquoted url(`)
          if (d === '\\') {
            s += '__'
            j++
          } else s += /\s/.test(d) ? ' ' : '_'
        }
        out += s + ')'
        i = j + 1
        continue
      }
    }
    if (c === '{') braces++
    else if (c === '}') {
      if (--braces < 0) fail('unmatched }')
    } else if (c === '(') parens++
    else if (c === ')') {
      if (--parens < 0) fail('unmatched )')
    }
    out += c
    i++
  }
  if (braces !== 0) fail('unclosed {')
  if (parens !== 0) fail('unclosed (')
  return out
}

/** A small CSS reader: statements and blocks, nested at-rules read as children. Throws on CSS it cannot read. */
function parseCss(css: string): CssBlock[] {
  const src = sanitizeCss(css)
  function readLevel(from: number, to: number): CssBlock[] {
    const out: CssBlock[] = []
    let i = from
    while (i < to) {
      let j = i
      while (j < to && src[j] !== '{' && src[j] !== ';') j++
      const prelude = src.slice(i, j).trim()
      if (j >= to || src[j] === ';') {
        if (prelude) out.push({ prelude, body: '', children: [], hasBlock: false })
        i = j + 1
        continue
      }
      let depth = 1
      let k = j + 1
      while (k < to && depth > 0) {
        if (src[k] === '{') depth++
        else if (src[k] === '}') depth--
        k++
      }
      const body = src.slice(j + 1, k - 1)
      const isAt = prelude.startsWith('@')
      out.push({ prelude, body, children: isAt ? readLevel(j + 1, k - 1) : [], hasBlock: true })
      i = k
    }
    return out
  }
  return readLevel(0, src.length)
}

/** The declarations in a rule body, split on top-level semicolons. */
function declarations(body: string): Array<{ prop: string, value: string }> {
  const out: Array<{ prop: string, value: string }> = []
  let depth = 0
  let cur = ''
  const push = () => {
    const at = cur.indexOf(':')
    if (at > 0) out.push({ prop: cur.slice(0, at).trim().toLowerCase(), value: cur.slice(at + 1).trim() })
    cur = ''
  }
  for (const ch of body) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ';' && depth === 0) push()
    else cur += ch
  }
  push()
  return out
}

/** The custom properties a rule with exactly this selector declares (all matching rules, in order). */
function scopeVars(css: string, selector: string): Record<string, string> {
  const vars: Record<string, string> = {}
  const visit = (blocks: CssBlock[]) => {
    for (const b of blocks) {
      if (b.prelude.startsWith('@')) {
        if (b.prelude.toLowerCase().startsWith('@media')) visit(b.children)
        continue
      }
      if (b.prelude.split(',').map((x) => x.trim().replace(/\s+/g, ' ')).includes(selector)) {
        for (const d of declarations(b.body)) if (d.prop.startsWith('--')) vars[d.prop] = d.value
      }
    }
  }
  visit(parseCss(css))
  return vars
}

/** Everything wrong with the home colour file's text (empty means clean). */
function homeCssViolations(css: string): string[] {
  const found: string[] = []
  const visit = (blocks: CssBlock[], inKeyframes: boolean) => {
    for (const b of blocks) {
      const p = b.prelude.trim()
      if (p.startsWith('@')) {
        const name = /^@([a-z-]+)/i.exec(p)?.[1]?.toLowerCase() ?? ''
        if (name === 'keyframes') {
          visit(b.children, true)
        } else if (name === 'media') {
          if (!MEDIA_OK.test(p)) found.push(`at-rule not allowed: ${p}`)
          visit(b.children, inKeyframes)
        } else {
          found.push(`at-rule not allowed: @${name}`)
        }
        continue
      }
      if (!b.hasBlock) continue
      if (b.body.includes('{')) found.push(`nested rule inside ${p}`)
      const selectors = p.split(',').map((x) => x.trim().replace(/\s+/g, ' '))
      for (const d of declarations(b.body)) {
        // A hex, a colour function or a CSS named colour is a literal; all three follow the same rules.
        if (LITERAL.test(d.value) || NAMED_COLOUR.test(d.value)) {
          if (!d.prop.startsWith('--') || !HOME_PROPERTY.test(d.prop)) {
            found.push(`colour literal in a property that is not an approved custom property: ${d.prop}: ${d.value}`)
          } else if (inKeyframes || selectors.some((sel) => !HOME_SELECTORS.has(sel))) {
            found.push(`colour literal under a selector that is not approved (${p}): ${d.prop}: ${d.value}`)
          }
        }
      }
    }
  }
  try {
    visit(parseCss(css), false)
  } catch (e) {
    found.push((e as Error).message)
  }
  return found
}

/** Every violation under app/, except the generated file; the home colour file has its own rules. */
function scanApp(): string[] {
  const found: string[] = []
  for (const file of walk(appDir)) {
    if (file === GENERATED || !TEXT_FILE.test(file)) continue
    const text = read(file)
    const where = file.slice(root.length + 1)
    if (file === HOME_CSS) {
      for (const v of homeCssViolations(text)) found.push(`${where}: ${v}`)
      continue
    }
    const hit = violation(text)
    if (hit) found.push(`${where}: ${hit}`)
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

// --- the home colour file ---
describe('the home colour file guard fires (it is not vacuous)', () => {
  const ok = [
    'html.ln-home { --ui-primary: #0f766e; --color-ln-brand-700: #0f766e; --home-band: #f3f3f3; }',
    'html.ln-home .home-dark { --home-glow: rgb(20 184 166 / .34); --ui-bg: #09090b; }',
    'html.ln-home .home-light, html.ln-home .home-note { --home-shadow: 0 2px 8px rgb(24 24 27 / .06); }',
    '@media (max-width: 900px) { html.ln-home .home-light { --home-band: #ffffff; } }',
    '@media (prefers-reduced-motion: reduce) { .home-x { transition: none; } }',
    '@keyframes home-blink { 50% { opacity: 0; } }',
    '.home-hero { color: var(--ui-text); background: var(--home-band); box-shadow: var(--home-shadow); }',
    // Strings, comments and escapes are read as strings, comments and escapes.
    '.home-x { content: "}"; color: var(--ui-text); }',
    '.home-x { content: "a { b ; c } d"; color: var(--ui-text); }',
    '/* } " { */ .home-x { color: var(--ui-text); }',
    '.home-x { content: "\\""; color: var(--ui-text); }',
    '.md\\:home-x { color: var(--ui-text); }',
    '.home-x { background: url(x.png); color: var(--ui-text); }',
    // A hue inside a longer name is not a colour name.
    '.home-x { color: var(--ui-red-text); background: var(--color-ln-brand-500); }',
    '.home-x { color: transparent; background: currentColor; }',
  ]
  for (const css of ok) it(`lets this through: ${css.slice(0, 60)}`, () => expect(homeCssViolations(css)).toEqual([]))

  const bad: Array<[string, string]> = [
    ['a plain colour property', 'html.ln-home .home-dark { color: #fff; }'],
    ['color: #fff on a home class', '.home-hero { color: #fff; }'],
    ['a literal under a selector that is not approved', 'html.ln-home .other { --ui-primary: #000; }'],
    ['a literal under :root', ':root { --home-x: #000; }'],
    ['a literal under .dark', '.dark { --ui-primary: #000; }'],
    ['an unapproved custom property name', 'html.ln-home { --evil: #000; }'],
    ['an approved name under a second selector in a list', 'html.ln-home, .other { --home-x: #000; }'],
    ['a brand shade that does not exist', 'html.ln-home { --color-ln-brand-1000: #000; }'],
    ['an rgb() in a normal property', '.home-hero { box-shadow: 0 1px rgb(0 0 0 / .5); }'],
    ['a named colour', '.home-hero { color: white; }'],
    ['@layer', '@layer base { html.ln-home { --home-x: 1; } }'],
    ['@import', '@import url("x.css");'],
    ['@font-face', '@font-face { font-family: x; src: url(x.woff2); }'],
    ['@property', '@property --home-x { syntax: "<color>"; inherits: false; initial-value: red; }'],
    ['@supports', '@supports (color: color-mix(in srgb, red, blue)) { .home-x { color: var(--ui-text); } }'],
    ['@media print', '@media print { .home-x { display: none; } }'],
    ['@media prefers-color-scheme', '@media (prefers-color-scheme: dark) { .home-x { display: none; } }'],
    ['a literal inside @keyframes', '@keyframes home-x { to { --home-y: #fff; } }'],
    ['a nested rule', 'html.ln-home { .inner { --home-x: #000; } }'],
    // Quoted braces, escapes and comments do not move the block edges.
    ['a quoted brace hiding a literal', 'body { content: "}"; color: #fff; }'],
    ['a quoted brace hiding a following @font-face', '.home-x { content: "}" } @font-face { font-family: x; src: url(x.woff2); }'],
    ['a quoted brace in single quotes hiding a literal', ".home-x { content: '}'; color: #fff; }"],
    ['an escaped quote then a brace in a string, then a literal', '.home-x { content: "\\"}"; color: #fff; }'],
    ['a literal after a comment holding a quote', '/* " */ .home-x { color: #fff; }'],
    ['an unterminated string (fails closed)', '.home-x { content: "}; color: var(--ui-text); }'],
    ['an unterminated comment (fails closed)', '.home-x { color: var(--ui-text); } /* @font-face { src: url(x) }'],
    ['an unmatched closing brace (fails closed)', '.home-x { color: var(--ui-text); } } .home-y { color: #fff; }'],
    ['an unclosed block (fails closed)', '.home-x { color: var(--ui-text);'],
    ['an unclosed paren (fails closed)', '.home-x { color: rgb(1 2 3; background: var(--ui-bg); }'],
    ['an unquoted url holding a quote (fails closed)', '.home-x { background: url(a"b); color: #fff; }'],
    // Named colours get the same property, selector and keyframe rules as hex.
    ['a named colour in a custom property that is not approved', '.other { --evil: red; color: var(--evil); }'],
    ['a named colour under a selector that is not approved', 'html.ln-home .other { --ui-primary: teal; }'],
    ['a named colour in an approved property under :root', ':root { --home-x: tomato; }'],
    ['a named colour inside @keyframes, custom property', '@keyframes home-x { to { --home-y: red; } }'],
    ['a named colour inside @keyframes, colour property', '@keyframes home-x { to { color: rebeccapurple; } }'],
    ['a named colour that is not a hue word (crimson)', '.home-hero { border-color: crimson; }'],
    ['a named colour in a property the colour list does not name', '.home-hero { scrollbar-color: red blue; }'],
    ['a named colour in upper case', '.home-hero { color: WHITE; }'],
  ]
  for (const [name, css] of bad) it(`flags ${name}`, () => expect(homeCssViolations(css), css).not.toEqual([]))

  it('fails the app scan for a hex in a second CSS file (written and removed here)', () => {
    const planted = join(appDir, 'assets/css/__second_colour_file__.css')
    try {
      writeFileSync(planted, 'html.ln-home { --home-sneaky: #123456; }\n')
      const found = scanApp()
      expect(found.some((line) => line.includes('__second_colour_file__.css'))).toBe(true)
    } finally {
      rmSync(planted, { force: true })
    }
    expect(existsSync(planted)).toBe(false)
  })
})

describe('the home colour file (app/assets/css/home-v5.css)', () => {
  const css = () => read(HOME_CSS)

  it('exists and holds no literal outside the allowed custom properties and selectors', () => {
    expect(existsSync(HOME_CSS)).toBe(true)
    expect(homeCssViolations(css())).toEqual([])
  })

  it('restates the teal brand scale on html.ln-home, every shade', () => {
    const v = scopeVars(css(), 'html.ln-home')
    for (const shade of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
      expect(v[`--color-ln-brand-${shade}`], `shade ${shade}`).toMatch(/^#[0-9a-f]{6}$/i)
    }
    expect(v['--ui-primary']).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('only app/pages/index.vue imports the file or sets the ln-home class', () => {
    const users = walk(appDir)
      .filter((f) => TEXT_FILE.test(f) && f !== HOME_CSS)
      .filter((f) => /home-v5|\bln-home\b/.test(read(f)))
      .map((f) => f.slice(root.length + 1))
    expect(users).toEqual(['app/pages/index.vue'])
    const index = read(join(appDir, 'pages/index.vue'))
    expect(index).toMatch(/home-v5\.css/)
    expect(index).toMatch(/ln-home/)
  })

  // Every pair the home page draws, measured from the file itself. The browser
  // spec measures the rendered button states again (CONTRAST.md).
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const lum = ([r, g, b]: number[]) => {
    const c = (n: number) => {
      const x = n / 255
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * c(r!) + 0.7152 * c(g!) + 0.0722 * c(b!)
  }
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(hex(a)), lum(hex(b))].sort((x, y) => y - x)
    return (hi! + 0.05) / (lo! + 0.05)
  }

  const contexts: Array<[string, string, string]> = [
    ['light page', 'html.ln-home', 'html.ln-home'],
    ['light window and bands', 'html.ln-home .home-light', 'html.ln-home'],
    ['dark bands', 'html.ln-home .home-dark', 'html.ln-home']
  ]
  for (const [name, selector, base] of contexts) {
    it(`${name}: button label, hover label, links, body text and the focus ring pass`, () => {
      const v = { ...scopeVars(css(), base), ...scopeVars(css(), selector) }
      const g = (k: string) => v[k] ?? ''
      expect(g('--ui-primary'), '--ui-primary').toMatch(/^#/)
      // solid primary button: label on fill, and on the hover fill (brand-900)
      expect(ratio(g('--ui-text-inverted'), g('--ui-primary')), 'button label').toBeGreaterThanOrEqual(4.5)
      expect(ratio(g('--ui-text-inverted'), g('--color-ln-brand-900')), 'button label on hover').toBeGreaterThanOrEqual(4.5)
      // primary links and body text on the page and band surfaces
      for (const surface of ['--ui-bg', '--ui-bg-muted']) {
        expect(ratio(g('--ui-primary'), g(surface)), `link on ${surface}`).toBeGreaterThanOrEqual(4.5)
        expect(ratio(g('--ui-text'), g(surface)), `text on ${surface}`).toBeGreaterThanOrEqual(4.5)
        expect(ratio(g('--ui-text-muted'), g(surface)), `muted text on ${surface}`).toBeGreaterThanOrEqual(4.5)
        expect(ratio(g('--home-focus'), g(surface)), `focus ring on ${surface}`).toBeGreaterThanOrEqual(3)
      }
      // field borders (the email input) against the surface they sit on
      expect(ratio(g('--ui-border-accented'), g('--ui-bg-elevated')), 'input border').toBeGreaterThanOrEqual(3)
    })
  }
})

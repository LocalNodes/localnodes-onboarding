// Fixes from a design critique of the sign-up flow and the landing page. Each
// test is a rule the brand guide already states (BRAND.md sections 5, 6 and 7);
// the critique found the page breaking it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

/** The text between `selector {` and its closing brace. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, `${selector} block exists`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('\n}', start))
}

/** The value of `--name: value;` inside a CSS block. */
function prop(css: string, name: string): string {
  const m = css.match(new RegExp(`${name}:\\s*([^;]+);`))
  expect(m, `${name} is set`).not.toBeNull()
  return m![1].trim().toLowerCase()
}

describe('the dark bands are the approved band blue, not zinc (BRAND.md section 5)', () => {
  // Read the expected colours from the same generated file, not as literals:
  // the band roles alias the brand scale, so a palette swap in the token source
  // must keep this test green.
  const tokens = read('app/assets/css/ln-tokens.css')
  const dark = block(tokens, '.dark')
  const brand = (step: number) => prop(tokens, `--color-ln-brand-${step}`)

  it('takes the band background, muted text and button text from the token source', () => {
    expect(prop(dark, '--ui-bg')).toBe(brand(950))
    expect(prop(dark, '--ui-text-muted')).toBe(brand(200))
    expect(prop(dark, '--ui-text-inverted')).toBe(brand(950))
    expect(dark).not.toContain('#09090b')
  })
})

describe('/cancel is on the brand type scale and the task-page layout (BRAND.md section 6)', () => {
  const page = read('app/pages/cancel.vue')
  const h1 = page.match(/<h1\b[^>]*class="([^"]*)"/)?.[1] ?? ''

  it('has one 28px, weight 600 h1, like /onboarding and /success', () => {
    expect(h1).toContain('text-[28px]')
    expect(h1).toContain('font-semibold')
    expect(h1).not.toMatch(/\bfont-bold\b|\btext-2xl\b/)
  })

  it('is left aligned in the same container, with no decorative icon', () => {
    expect(page).toContain('<UContainer class="max-w-2xl py-16">')
    expect(page).not.toMatch(/text-center|mx-auto text-center|<UIcon/)
  })

  it('keeps its words', () => {
    expect(page).toContain('Payment cancelled')
    expect(page).toContain("No charges were made. You can try again whenever you're ready.")
    expect(page).toContain('Try Again')
  })
})

describe('the header\'s early-access button is not a second primary on the task pages (BRAND.md section 5)', () => {
  const header = read('app/components/AppHeader.vue')

  it('is solid on the landing page and outlined everywhere else', () => {
    expect(header).toContain(`:variant="onLanding ? 'solid' : 'outline'"`)
  })

  it('uses the neutral outline off the landing page, the 3:1 border the form\'s other secondary buttons have', () => {
    expect(header).toContain(`:color="onLanding ? 'primary' : 'neutral'"`)
  })
})

describe('the landing page sections use the four brand sizes (BRAND.md section 6)', () => {
  it('has no 30px, 36px, 18px or 12px text class', () => {
    for (const name of ['LandingCTA', 'EarlyAccessForm']) {
      const text = read(`app/components/${name}.vue`)
      expect(text, name).not.toMatch(/\btext-(3xl|lg|xs)\b/)
      expect(text, name).not.toMatch(/\b(sm:)?text-4xl\b/)
    }
  })
})

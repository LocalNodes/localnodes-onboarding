// Fixes from the Impeccable critique of the sign-up flow and the landing page
// (fresh3 22.1-12, DES-01). Each test is a rule the brand already states
// (fresh3 .planning/brand/BRAND.md sections 5, 6 and 7); the critique found the
// page breaking it.
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

describe('the dark bands are the approved band blue, not zinc (BRAND.md section 5, Tom card 7)', () => {
  // Read the expected colours from the same generated file, not as literals:
  // the band roles alias the brand scale, so a palette swap in the token source
  // must keep this test green (fresh3 22.1-14 swap proof, WINDOWS 50).
  const tokens = read('app/assets/css/ln-tokens.css')
  const dark = block(tokens, '.dark')
  const brand = (step: number) => prop(tokens, `--color-ln-brand-${step}`)

  it('takes the band background, muted text and button text from the token source', () => {
    expect(prop(dark, '--ui-bg')).toBe(brand(950))
    expect(prop(dark, '--ui-text-muted')).toBe(brand(200))
    expect(prop(dark, '--ui-text-inverted')).toBe(brand(950))
    expect(dark).not.toContain('#09090b')
  })

  it('draws the answer card and the source chip from the band palette', () => {
    const demo = read('app/components/HeroSearchDemo.vue')
    expect(demo).toMatch(/\bbg-ln-brand-900\b/)
    expect(demo).toMatch(/\bbg-ln-brand-100\b/)
    expect(demo).not.toMatch(/\bbg-elevated\b/)
    expect(demo).not.toMatch(/\bbg-inverted\b/)
  })

  it('no longer carries the interim TODO the band colour left behind', () => {
    for (const file of ['HeroSection', 'RoadmapSection', 'AppHeader']) {
      expect(read(`app/components/${file}.vue`), file).not.toContain('TODO(22.1-08)')
    }
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

describe('the landing page uses the four brand sizes plus the 48/36 hero (BRAND.md section 6)', () => {
  const LANDING = [
    'ProblemSection', 'WhoItsFor', 'FeaturesSection', 'RoadmapSection', 'SocialProof',
    'HowItWorks', 'OpenSourceSection', 'LandingCTA', 'EarlyAccessForm', 'HeroSection', 'HeroSearchDemo'
  ]

  it('has no 30px, 36px (outside the hero), 18px or 12px text class', () => {
    for (const name of LANDING) {
      const text = read(`app/components/${name}.vue`)
      expect(text, name).not.toMatch(/\btext-(3xl|lg|xs)\b/)
      if (name !== 'HeroSection') expect(text, name).not.toMatch(/\b(sm:)?text-4xl\b/)
    }
  })

  it('keeps a 16px lead paragraph to 72 characters (max-w-xl), which max-w-3xl and max-w-2xl no longer do at this size', () => {
    for (const name of ['ProblemSection', 'FeaturesSection', 'OpenSourceSection', 'HeroSection']) {
      const lead = read(`app/components/${name}.vue`).match(/<p class="text-base[^"]*(max-w-[a-z0-9]+)[^"]*"/)?.[1]
      expect(lead, name).toBe('max-w-xl')
    }
  })

  it('keeps the hero at 36px under 640px and 48px above', () => {
    expect(read('app/components/HeroSection.vue')).toMatch(/\btext-4xl sm:text-5xl\b/)
  })

  it('sets section headings at 28px and the pause button at the label size', () => {
    expect(read('app/components/ProblemSection.vue')).toContain('text-[28px]')
    expect(read('app/components/HeroSearchDemo.vue')).not.toContain('size="sm"')
  })
})

// The invite pages and their route rules (fresh3 23-28, D-01, D-24), checked
// from source, the way tokens.test.ts checks the design tokens: nothing in
// tests/ mounts a component (no jsdom, no @vue/test-utils, and no new package
// is allowed), so the rules that matter are read from the files that carry
// them. The page logic itself is covered in invite-flow.test.ts.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { INVITE_COPY } from '~/utils/invite-flow'

const root = resolve(__dirname, '../..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

const ENTRY = 'app/pages/invite/index.vue'
const VERIFY = 'app/pages/invite/verify.vue'

describe('route files', () => {
  it('/invite is app/pages/invite/index.vue, not invite.vue: invite.vue would turn verify.vue into a child page that never shows', () => {
    expect(existsSync(join(root, ENTRY))).toBe(true)
    expect(existsSync(join(root, 'app/pages/invite.vue'))).toBe(false)
    expect(existsSync(join(root, VERIFY))).toBe(true)
  })
})

describe('/invite/verify never spends the token on page load (research Pitfall 2)', () => {
  const src = () => read(VERIFY)

  it('reads the token from location.hash', () => {
    expect(src()).toMatch(/location\.hash/)
  })
  it('never reads the query string', () => {
    expect(src()).not.toMatch(/\.query\b|location\.search|useRoute\(\)\.query|URLSearchParams/)
  })
  it('reads the address only after mount, so server rendering never sees a token', () => {
    expect(src()).toMatch(/onMounted/)
    const script = src().split('</script>')[0]!
    expect(script.indexOf('location.hash')).toBeGreaterThan(script.indexOf('onMounted'))
  })
  it('posts only from the button press: consumeSignInLink is called inside one function, never at setup or in onMounted', () => {
    const script = src().split('</script>')[0]!
    expect(script.match(/consumeSignInLink\(/g)).toHaveLength(1)
    const start = script.indexOf('onMounted(')
    const mounted = script.slice(start, script.indexOf('\n})', start))
    expect(mounted.length).toBeGreaterThan(20)
    expect(mounted).not.toMatch(/consumeSignInLink|\$fetch/)
  })
  it('goes on to /onboarding with a full page load, so server rendering reads the new cookie (23-24)', () => {
    expect(src()).toMatch(/navigateTo\(\s*'\/onboarding'\s*,\s*\{\s*external:\s*true\s*\}\s*\)/)
  })
  it('has the one primary button with the approved label', () => {
    expect(src()).toContain('INVITE_COPY.verify')
    expect(src()).toContain('copy.button')
    expect(INVITE_COPY.verify.button).toBe('Continue to sign-up')
  })
  it('is forced light, one h1, and the expired state is a focusable box read once by the focus move (F8), with a link back to /invite', () => {
    const s = src()
    expect(s).toMatch(/colorMode:\s*'light'/)
    expect(s.match(/<h1\b/g)).toHaveLength(1)
    expect(s).toMatch(/to="\/invite"/)
    // The refusal box takes focus and carries no alert role: the focus move
    // reads it once (fresh3 23-39, F8; orchestrator 2026-11-08; 23-UI-SPEC section 2).
    const box = s.match(/<[a-z]+\b[^>]*\sref="refusal"[^>]*>/)?.[0]
    expect(box, 'the element with ref refusal').toBeTruthy()
    expect(box).toContain('tabindex="-1"')
    expect(box).not.toMatch(/\srole=/)
  })
  it('showRefusal still moves focus to the refusal box (F8 keeps the focus move)', () => {
    const script = src().split('</script>')[0]!
    const start = script.indexOf('async function showRefusal(')
    expect(start).toBeGreaterThan(-1)
    const body = script.slice(start, script.indexOf('\n}', start))
    expect(body).toMatch(/refusal\.value\?\.focus\(\)/)
  })
  it('the server-error alert takes no focus and keeps its alert role: the attribute appears exactly once in the file, on that alert', () => {
    const s = src()
    expect(s.match(/role="alert"/g)).toHaveLength(1)
    const serverError = s.match(/<UAlert\b[^>]*v-if="phase === 'server-error'"[^>]*>/s)?.[0] ?? ''
    expect(serverError).toContain('role="alert"')
    expect(serverError).toContain('copy.serverError')
  })
})

describe('/invite', () => {
  const src = () => read(ENTRY)

  it('is forced light with one h1 and a 640px column', () => {
    const s = src()
    expect(s).toMatch(/colorMode:\s*'light'/)
    expect(s.match(/<h1\b/g)).toHaveLength(1)
    expect(s).toMatch(/max-w-2xl/)
  })
  it('the email field is type email with autocomplete email and paste is not blocked', () => {
    const s = src()
    expect(s).toMatch(/type="email"/)
    expect(s).toMatch(/autocomplete="email"/)
    expect(s).toMatch(/inputmode="email"/)
    expect(s).not.toMatch(/@paste|onpaste|paste\.prevent/i)
  })
  it('has a honeypot named hpField that is hidden from assistive technology and keyboard', () => {
    const s = src()
    expect(s).toMatch(/aria-hidden="true"/)
    expect(s).toMatch(/tabindex="-1"/)
    expect(s).toMatch(/autocomplete="off"/)
    expect(s).toMatch(/hpField/)
  })
  it('shows no puzzle CAPTCHA', () => {
    expect(src()).not.toMatch(/captcha|recaptcha|turnstile|hcaptcha/i)
  })
  it('has one aria-live polite region', () => {
    const s = src()
    expect(s.match(/aria-live="polite"/g)).toHaveLength(1)
  })
  it('the sent reply is the same constant for every address and the page never writes the address back', () => {
    const s = src()
    expect(s).toContain('INVITE_COPY.entry')
    expect(s).toContain('copy.sentReply')
    // The address is only ever a v-model on the field, never printed.
    expect(s).not.toMatch(/\{\{\s*email\b/)
  })
  it('links to the privacy section on the landing page', () => {
    expect(src()).toMatch(/to="\/#privacy"/)
    expect(INVITE_COPY.entry.helpLink).toBe('How we handle your details')
  })
  it('the button is disabled only while its own request runs', () => {
    const s = src()
    expect(s).toMatch(/:loading="sending"/)
    expect(s).not.toMatch(/:disabled="!/)
  })
})

describe('nuxt.config.ts route rules', () => {
  const cfg = () => read('nuxt.config.ts')

  it('/invite and /invite/verify are server-rendered', () => {
    expect(cfg()).toMatch(/'\/invite':\s*\{\s*ssr:\s*true\s*\}/)
    expect(cfg()).toMatch(/'\/invite\/verify':\s*\{[^}]*ssr:\s*true/)
  })
  it('/invite/verify answers Cache-Control no-store and Referrer-Policy no-referrer', () => {
    const rule = cfg().match(/'\/invite\/verify':\s*\{[\s\S]*?\n\s{4}\}/)
    expect(rule, 'a /invite/verify route rule').not.toBeNull()
    expect(rule![0]).toMatch(/'Cache-Control':\s*'no-store'/)
    expect(rule![0]).toMatch(/'Referrer-Policy':\s*'no-referrer'/)
  })
  it('the invite pages are not on the gated page list: the closed gate must let a stranger reach them', async () => {
    const { GATED_PAGES, gateDecision } = await import('#shared/launch')
    expect(GATED_PAGES).not.toContain('/invite')
    expect(gateDecision('/invite', false)).toBe('pass')
    expect(gateDecision('/invite/verify', false)).toBe('pass')
  })
})

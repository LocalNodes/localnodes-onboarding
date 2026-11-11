// What a person reads on the sign-up path, checked as a whole. One case per path
// (a free pilot invite, a paid sign-up, and the neutral words shown while the
// offer is not known). Each case gathers the words the form, the progress page
// and (for a pilot) the continue page and the end-of-pilot notice show, and
// checks them against the plain-words rules below. The checker itself is tested
// with strings that break each rule, so a rule that stopped firing would show.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createSSRApp, defineComponent, h, ref, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { SIGNUP_COPY } from '~/utils/onboarding-flow'
import { SUCCESS_COPY } from '~/utils/reason-copy'
import { mapStagesToState } from '~/composables/useProvisioningStatus'
import { PILOT_CONTINUE_COPY } from '~/utils/pilot-continue-flow'
import { AI_CHOICE_COPY } from '../../shared/ai-choice'
import { buildPilotEndMail } from '../../server/utils/mail-copy'
import AiChoiceField from '../../app/components/AiChoiceField.vue'
import TopicTypesEditor from '../../app/components/TopicTypesEditor.vue'
import PromoCodeField from '../../app/components/PromoCodeField.vue'
import OnboardingForm from '../../app/components/OnboardingForm.vue'
import SubdomainPreview from '../../app/components/SubdomainPreview.vue'

const g = globalThis as Record<string, unknown>

// --- the rules ------------------------------------------------------------------

type Path = 'pilot' | 'paid' | 'neutral'

/** "account" is allowed only inside the glossary's compound terms. */
const BARE_ACCOUNT = /(?<!(?:Gemini|OpenRouter) )\baccounts?\b/i

/** Every rule a string set breaks, by name. An empty list means the words pass. */
function problemsIn(strings: string[], path: Path): string[] {
  const text = strings.join('\n')
  const found: string[] = []
  const rule = (name: string, pattern: RegExp) => { if (pattern.test(text)) found.push(name) }
  rule('square bracket', /[[\]]/)
  rule('subscription', /subscription/i)
  rule('full price', /full price/i)
  rule('about 4 minutes', /about 4 minutes/i)
  rule('for free', /for free/i)
  if (BARE_ACCOUNT.test(text)) found.push('bare account')
  // The yes works only before the free end, and no second question is ever sent.
  rule('works after the free period', /\bworks? after (?:the|your) free\b/i)
  rule('we will ask', /\bwe(?:'ll| will) ask\b/i)
  rule('after those months', /after those months/i)
  if (path === 'pilot') {
    rule('first payment on a pilot', /first payment/i)
    rule('charge only once the site is live on a pilot', /charge it only once your site is live/i)
  }
  return found
}

describe('the checker catches each rule', () => {
  const clean = ['Free for three months, then $20 a month only if you choose to continue.']
  it('passes plain words', () => {
    expect(problemsIn(clean, 'pilot')).toEqual([])
    expect(problemsIn([...clean, 'Use a key from your own OpenRouter account.', 'Your own Gemini account'], 'paid')).toEqual([])
  })

  it.each([
    ['square bracket', 'Your site is at [address].', ['pilot', 'paid', 'neutral']],
    ['square bracket', 'Hello ]', ['paid']],
    ['subscription', 'We start your subscription later.', ['pilot', 'paid', 'neutral']],
    ['full price', 'Then the full price applies.', ['pilot', 'paid', 'neutral']],
    ['about 4 minutes', 'This takes About 4 minutes.', ['pilot', 'paid', 'neutral']],
    ['for free', 'Try it for free.', ['pilot', 'paid', 'neutral']],
    ['bare account', 'We could not create your account.', ['pilot', 'paid', 'neutral']],
    ['bare account', 'Sign in to your Google account.', ['paid']],
    ['works after the free period', 'The Keep my site button works after the free period.', ['pilot', 'paid', 'neutral']],
    ['works after the free period', 'It works after your free months.', ['paid']],
    ['we will ask', 'We will ask you again.', ['pilot', 'paid', 'neutral']],
    ['we will ask', 'We\'ll ask you again.', ['paid']],
    ['after those months', 'A later charge needs your choice after those months.', ['pilot', 'paid', 'neutral']]
  ] as const)('%s: "%s"', (name, sentence, paths) => {
    for (const path of paths) expect(problemsIn([...clean, sentence], path)).toContain(name)
  })

  it('first payment and the paid charge line are banned on the pilot path only', () => {
    expect(problemsIn(['Taking your first payment'], 'pilot')).toContain('first payment on a pilot')
    expect(problemsIn(['Taking your first payment'], 'paid')).toEqual([])
    expect(problemsIn(['Taking your first payment'], 'neutral')).toEqual([])
    const under = 'We\'ll save your card now and charge it only once your site is live.'
    expect(problemsIn([under], 'pilot')).toContain('charge only once the site is live on a pilot')
    expect(problemsIn([under], 'paid')).toEqual([])
  })

  it('the glossary compounds are the only accounts allowed', () => {
    expect(problemsIn(['Your own Gemini account'], 'paid')).toEqual([])
    expect(problemsIn(['Use a key from your own OpenRouter account.'], 'paid')).toEqual([])
    expect(problemsIn(['Your own Cloud account'], 'paid')).toContain('bare account')
  })
})

// --- gathering what each path shows -----------------------------------------------

const stubs: Record<string, Component> = {
  UContainer: defineComponent((_, { slots }) => () => h('div', slots.default?.())),
  UFormField: defineComponent({
    props: ['label', 'help', 'error', 'name'],
    setup: (p, { slots }) => () => h('div', [
      p.label ? h('label', p.label) : null,
      slots.default?.(),
      p.help ? h('p', p.help) : null,
      p.error ? h('p', p.error) : null
    ])
  }),
  UInput: defineComponent({ props: ['modelValue'], setup: (p, { attrs }) => () => h('input', { ...attrs, value: p.modelValue }) }),
  UTextarea: defineComponent({ props: ['modelValue'], setup: (p, { attrs }) => () => h('textarea', attrs, p.modelValue) }),
  UButton: defineComponent({ props: ['label'], setup: (p, { attrs, slots }) => () => h('button', attrs, p.label ?? slots.default?.()) }),
  URadioGroup: defineComponent({
    props: ['modelValue', 'items', 'legend'],
    setup: (p, { slots }) => () => h('fieldset', [
      h('legend', slots.legend ? slots.legend() : p.legend),
      ...(p.items as Array<{ value: string, label: string, description: string }>).map(item =>
        h('div', [h('span', item.label), h('p', item.description)]))
    ])
  }),
  UCheckbox: defineComponent({ props: ['label'], setup: p => () => h('label', [h('input', { type: 'checkbox' }), p.label]) }),
  UAlert: defineComponent({ props: ['description'], setup: (p, { attrs }) => () => h('div', attrs, p.description) }),
  UBadge: defineComponent({ props: ['label'], setup: p => () => h('span', p.label) }),
  UIcon: defineComponent(() => () => h('span', { 'aria-hidden': 'true' }))
}

let fetchAnswers: Record<string, unknown>
let states: Map<string, { value: unknown }>

function installNuxt(openRouter: boolean) {
  fetchAnswers = {}
  states = new Map()
  states.set('ln-openrouter-choice', ref(openRouter))
  g.useFetch = (url: string) => ({ data: ref(fetchAnswers[url] ?? null), error: ref(null), status: ref('success'), refresh: vi.fn() })
  g.useState = (key: string, init?: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(init?.()) as { value: unknown })
    return states.get(key)
  }
  g.definePageMeta = vi.fn()
  g.useSeoMeta = vi.fn()
  g.$fetch = vi.fn()
  g.navigateTo = vi.fn()
}

async function mount(component: Component, props: Record<string, unknown> = {}): Promise<string> {
  const app = createSSRApp(component, props)
  for (const [name, stub] of Object.entries(stubs)) app.component(name, stub)
  app.component('SubdomainPreview', SubdomainPreview)
  app.component('TopicTypesEditor', TopicTypesEditor)
  app.component('AiChoiceField', AiChoiceField)
  app.component('PromoCodeField', PromoCodeField)
  return renderToString(app)
}

const textOf = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

const publicSignup = () => states.delete('ln-invite-details')
const invited = (promoCode: string) => states.set('ln-invite-details', ref({ email: 'organizer@example.org', promoCode }))

/** The AI choice with each option picked, so the key help and the OpenRouter lines are read too. */
async function aiChoiceStrings(): Promise<string[]> {
  const out: string[] = []
  for (const choice of ['default', 'gemini', 'openrouter']) out.push(textOf(await mount(AiChoiceField, { modelValue: choice })))
  return out
}

/** The progress page's words: its fixed lines and the step labels, as the page shows them for what the status reply said. */
function progressStrings(pilot: boolean | null): string[] {
  const p = SUCCESS_COPY.progress
  return [p.title, p.intro, p.retriedIntro, p.underSteps, p.readError, ...mapStagesToState(0, pilot).map(s => s.label)]
}

const DATE = 'March 12, 2027'
const PRICE = '$49 a month'

/** The continue page and the end-of-pilot notice: a pilot's words only. */
function continueAndNoticeStrings(): string[] {
  const c = PILOT_CONTINUE_COPY
  return [
    c.title, c.loading, c.ends(DATE), c.cost(DATE, PRICE), c.priceMissing, c.button, c.buttonWorking, c.retry,
    c.continued(PRICE), c.continued(''), c.ended, c.invalid, c.serverError,
    buildPilotEndMail({ date: DATE, price: PRICE, link: 'https://localnodes.xyz/pilot/continue?t=x' }).text
  ]
}

describe('what each path of the sign-up shows', () => {
  beforeEach(() => installNuxt(true))
  afterEach(() => { for (const k of ['useFetch', 'useState', 'definePageMeta', 'useSeoMeta', '$fetch', 'navigateTo']) delete g[k] })

  const PAID_UNDER = SIGNUP_COPY.submit.under.paid[0]!
  const NEUTRAL_UNDER = SIGNUP_COPY.submit.under.neutral[0]!

  async function pilotStrings(months = 3): Promise<string[]> {
    invited('PILOT-ONE')
    fetchAnswers['/api/price'] = { line: PRICE, inviteCode: { code: 'PILOT-ONE', offer: 'pilot', months } }
    return [
      textOf(await mount(OnboardingForm)),
      ...await aiChoiceStrings(),
      SIGNUP_COPY.code.accepted.pilot(months),
      SIGNUP_COPY.price.pilot(months, PRICE),
      ...SIGNUP_COPY.submit.under.pilot(months),
      ...progressStrings(true),
      ...continueAndNoticeStrings()
    ]
  }

  async function paidStrings(): Promise<string[][]> {
    // No code at all: the public sign-up.
    publicSignup()
    fetchAnswers['/api/price'] = { line: PRICE }
    const none = [textOf(await mount(OnboardingForm)), ...await aiChoiceStrings(), ...progressStrings(false)]
    // A discount that is not a free pilot, applied on an invited session.
    invited('TEN-OFF')
    fetchAnswers['/api/price'] = { line: PRICE, inviteCode: { code: 'TEN-OFF', offer: 'paid' } }
    const discount = [
      textOf(await mount(OnboardingForm)), ...await aiChoiceStrings(), SIGNUP_COPY.code.accepted.paid, ...progressStrings(false)
    ]
    publicSignup()
    return [none, discount]
  }

  async function neutralStrings(): Promise<string[]> {
    // A code in the field that nobody has classified, and a status reply that has not said yet.
    invited('SOME-CODE')
    fetchAnswers['/api/price'] = { line: PRICE }
    return [textOf(await mount(OnboardingForm)), ...await aiChoiceStrings(), ...SIGNUP_COPY.submit.under.neutral, ...progressStrings(null)]
  }

  it('a pilot invite: the plain-words rules hold, for three months and for six', async () => {
    for (const months of [3, 6]) expect(problemsIn(await pilotStrings(months), 'pilot')).toEqual([])
  })

  it('a paid sign-up: the rules hold with no code and with an applied discount', async () => {
    for (const strings of await paidStrings()) expect(problemsIn(strings, 'paid')).toEqual([])
  })

  it('the neutral words: the rules hold, and no pilot promise is made', async () => {
    const strings = await neutralStrings()
    expect(problemsIn(strings, 'neutral')).toEqual([])
    expect(strings.join('\n')).not.toMatch(/Free for|pilot costs nothing/)
  })

  it('each path still has its own words', async () => {
    const pilot = (await pilotStrings()).join('\n')
    expect(pilot).toContain('Free for three months, then $49 a month only if you choose to continue.')
    expect(pilot).toContain('your three-month pilot costs nothing')
    expect(pilot).toContain('Confirming your free pilot')
    expect(pilot).not.toContain(PAID_UNDER)
    expect(pilot).not.toContain(NEUTRAL_UNDER)

    const [none, discount] = (await paidStrings()).map(s => s.join('\n')) as [string, string]
    for (const paid of [none, discount]) {
      expect(paid).toContain(PAID_UNDER)
      expect(paid).toContain('Taking your first payment')
      expect(paid).not.toContain('Free for')
      expect(paid).not.toContain('Confirming your free pilot')
    }
    // A one-time discount can make the first bill zero, so it speaks of the first bill, not a payment.
    expect(SIGNUP_COPY.code.accepted.paid).toBe('Code applied. Your discount starts with your site\'s first bill.')
    expect(SIGNUP_COPY.code.accepted.paid).not.toMatch(/payment|subscription/i)

    const neutral = (await neutralStrings()).join('\n')
    expect(neutral).toContain(NEUTRAL_UNDER)
    expect(neutral).toContain('Confirming your card')
    expect(neutral).not.toContain(PAID_UNDER)
  })

  it('the AI choice is on the pilot form: Gemini always, OpenRouter only while its flag is on', async () => {
    invited('PILOT-ONE')
    fetchAnswers['/api/price'] = { line: PRICE, inviteCode: { code: 'PILOT-ONE', offer: 'pilot', months: 3 } }
    const flagOn = textOf(await mount(OnboardingForm))
    expect(flagOn).toContain(AI_CHOICE_COPY.legend)
    expect(flagOn).toContain('Your own Gemini account')
    expect(flagOn).toContain('Your own OpenRouter account')
    states.set('ln-openrouter-choice', ref(false))
    const flagOff = textOf(await mount(OnboardingForm))
    expect(flagOff).toContain('Use the included AI service')
    expect(flagOff).toContain('Your own Gemini account')
    expect(flagOff).not.toContain('OpenRouter')
  })
})

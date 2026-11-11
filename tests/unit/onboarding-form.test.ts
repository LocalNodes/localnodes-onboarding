// The sign-up form at /onboarding (fresh3 23-19; D-06, D-08, D-20, D-21, D-24;
// T-2, T-3; rulings C and P(a)). Every behaviour bullet of the plan's Task 1 has
// a named test here. The form's logic lives in app/utils/onboarding-flow.ts and
// is tested with a fake fetcher; the rendered states are tested by mounting the
// real components with Vue's server renderer (vue/server-renderer, compiled by
// @vitejs/plugin-vue in vitest.config.ts) and small stand-ins for the Nuxt UI
// components and Nuxt's useFetch and useState.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as v from 'valibot'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createSSRApp, defineComponent, h, ref, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3'
import { onboardingSchema } from '~/utils/onboarding-schema'
import {
  MAX_PAGE_TYPES,
  SIGNUP_COPY,
  addTopicType,
  applyCode,
  checkAiKey,
  browserTimeZone,
  checkoutBody,
  descriptionProblem,
  mergeSuggestions,
  readPrice,
  removeLabel,
  removeTopicType,
  startCheckout,
  submitLabel,
  suggestTopicTypes,
  type Fetcher
} from '~/utils/onboarding-flow'
import {
  AI_CHOICE_COPY,
  GEMINI_BILLING_MESSAGE,
  KEY_FAILED_MESSAGE,
  KEY_NOT_CHECKED_MESSAGE,
  SERVER_ERROR_MESSAGE,
  TOO_MANY_KEY_CHECKS_MESSAGE
} from '../../shared/ai-choice'
import { FULL_MESSAGE } from '../../server/utils/capacity'
import { PROMO_REFUSED_MESSAGE } from '../../server/utils/promo'
import { PRICE_UNAVAILABLE_MESSAGE } from '../../server/utils/price'
import { createInvitedSession, invitedDetails, INVITE_COOKIE } from '../../server/utils/invites'
import { FakeRedis } from './helpers/fake-redis'
import AiChoiceField from '../../app/components/AiChoiceField.vue'
import TopicTypesEditor from '../../app/components/TopicTypesEditor.vue'
import PromoCodeField from '../../app/components/PromoCodeField.vue'
import OnboardingForm from '../../app/components/OnboardingForm.vue'
import SubdomainPreview from '../../app/components/SubdomainPreview.vue'
import OnboardingPage from '../../app/pages/onboarding.vue'

const root = resolve(__dirname, '../..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const g = globalThis as Record<string, unknown>
/** The page state app/plugins/ai-choice.server.ts copies the OpenRouter flag into. */
const OPENROUTER_STATE = 'ln-openrouter-choice'

/** A $fetch stand-in: answers by URL; a status other than 2xx throws the way ofetch does. */
function fakeFetch(answers: Record<string, { status: number, body?: unknown }>) {
  const calls: Array<{ url: string, opts: unknown }> = []
  const fetcher: Fetcher = async (url, opts) => {
    calls.push({ url, opts })
    const a = answers[url]
    if (!a) throw Object.assign(new Error('no route'), { statusCode: 404, data: { message: 'Not Found' } })
    if (a.status >= 200 && a.status < 300) return a.body
    throw Object.assign(new Error(`HTTP ${a.status}`), { statusCode: a.status, status: a.status, data: a.body })
  }
  return { fetcher, calls }
}

// --- the client schema ----------------------------------------------------------

describe('the client schema', () => {
  const base = { communityName: 'Repair Collective', description: '', topicTypes: [], code: '' }

  it('accepts a submission with aiChoice default and no key', () => {
    const r = v.safeParse(onboardingSchema, { ...base, aiChoice: 'default', keyChecked: false })
    expect(r.success).toBe(true)
  })

  it('refuses openrouter until the key check has succeeded, with "Check your key before continuing." at the key', () => {
    const r = v.safeParse(onboardingSchema, { ...base, aiChoice: 'openrouter', keyChecked: false })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.issues.map(i => i.message)).toContain(KEY_NOT_CHECKED_MESSAGE)
      expect(r.issues.find(i => i.message === KEY_NOT_CHECKED_MESSAGE)?.path?.[0]?.key).toBe('keyChecked')
    }
    expect(v.safeParse(onboardingSchema, { ...base, aiChoice: 'openrouter', keyChecked: true }).success).toBe(true)
  })

  it('refuses gemini the same way until its key is checked', () => {
    expect(v.safeParse(onboardingSchema, { ...base, aiChoice: 'gemini', keyChecked: false }).success).toBe(false)
    expect(v.safeParse(onboardingSchema, { ...base, aiChoice: 'gemini', keyChecked: true }).success).toBe(true)
  })

  it('an empty community name gives "Enter a name for your community."', () => {
    const r = v.safeParse(onboardingSchema, { ...base, communityName: '  ', aiChoice: 'default' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.issues[0]?.message).toBe('Enter a name for your community.')
  })

  it('the description is optional, but a short or long one gives the UI-SPEC lines', () => {
    expect(v.safeParse(onboardingSchema, { ...base, description: '' }).success).toBe(true)
    const short = v.safeParse(onboardingSchema, { ...base, description: 'Too short' })
    const long = v.safeParse(onboardingSchema, { ...base, description: 'x'.repeat(401) })
    expect(short.success ? '' : short.issues[0]?.message).toBe('Write at least 10 characters so we can make useful suggestions.')
    expect(long.success ? '' : long.issues[0]?.message).toBe('Keep it to 400 characters or fewer.')
    expect(descriptionProblem('   ')).toBeNull()
    expect(descriptionProblem('We fix bikes together.')).toBeNull()
  })

  it('reuses the page-type label rules from shared/signup.ts, not a copy of them', () => {
    expect(read('app/utils/onboarding-schema.ts')).toMatch(/import \{ topicTypeLabelSchema \} from '#shared\/signup'/)
  })
})

// --- page types ---------------------------------------------------------------

describe('TopicTypesEditor list rules', () => {
  it('drops a label equal to an existing one ignoring case and keeps the order', () => {
    const list = ['Meeting notes', 'How-to']
    expect(addTopicType(list, 'meeting NOTES')).toEqual(['Meeting notes', 'How-to'])
    expect(addTopicType(list, '  Repair   logs ')).toEqual(['Meeting notes', 'How-to', 'Repair logs'])
  })

  it('drops an always-included type and a blank label', () => {
    expect(addTopicType([], 'blog')).toEqual([])
    expect(addTopicType([], '   ')).toEqual([])
  })

  it('keeps at most 8 rows', () => {
    const eight = Array.from({ length: MAX_PAGE_TYPES }, (_, i) => `Type ${i + 1}`)
    expect(addTopicType(eight, 'Ninth')).toEqual(eight)
  })

  it('removing a row removes it and keeps the rest in order', () => {
    expect(removeTopicType(['A1', 'B2', 'C3'], 1)).toEqual(['A1', 'C3'])
    expect(removeTopicType(['A1'], 0)).toEqual([])
  })

  it('suggestions are added after the organizer\'s own rows, without duplicates, and the count is the number added', () => {
    expect(mergeSuggestions(['How-to'], ['how-to', 'Meeting notes', 'News', 'Repair logs'])).toEqual({
      list: ['How-to', 'Meeting notes', 'Repair logs'],
      added: 2
    })
  })

  it('the remove button is named "Remove ‹type›"', () => {
    expect(removeLabel('Meeting notes')).toBe('Remove Meeting notes')
  })
})

describe('suggest page types (POST /api/suggest-topic-types)', () => {
  it('posts the description and returns the suggested types', async () => {
    const { fetcher, calls } = fakeFetch({ '/api/suggest-topic-types': { status: 200, body: { ok: true, types: ['Meeting notes', 'How-to', 'Repair logs'] } } })
    expect(await suggestTopicTypes(fetcher, 'We fix bikes together.')).toEqual({ kind: 'suggested', types: ['Meeting notes', 'How-to', 'Repair logs'] })
    expect(calls[0]).toEqual({ url: '/api/suggest-topic-types', opts: { method: 'POST', body: { description: 'We fix bikes together.' } } })
  })

  it('an empty list shows the fallback line', async () => {
    const { fetcher } = fakeFetch({ '/api/suggest-topic-types': { status: 200, body: { ok: true, types: [], message: 'x' } } })
    expect(await suggestTopicTypes(fetcher, 'We fix bikes together.')).toEqual({ kind: 'fallback' })
    expect(SIGNUP_COPY.pageTypes.fallback).toBe('We couldn\'t suggest types just now. You can add your own, or skip this.')
  })

  it('a 429 from the suggest route shows "You\'ve asked for suggestions a lot. Wait a bit, or add your own types."', async () => {
    const { fetcher } = fakeFetch({ '/api/suggest-topic-types': { status: 429, body: { ok: false, message: 'anything' } } })
    expect(await suggestTopicTypes(fetcher, 'We fix bikes together.')).toEqual({ kind: 'too-many' })
    expect(SIGNUP_COPY.pageTypes.tooMany).toBe('You\'ve asked for suggestions a lot. Wait a bit, or add your own types.')
    const editor = read('app/components/TopicTypesEditor.vue')
    expect(editor).toMatch(/v-if="notice === 'too-many'"[\s\S]*?:description="copy\.tooMany"/)
  })

  it('a 400 carries the length message to the description field; a 503 or a 404 shows the fallback line', async () => {
    const tooShort = fakeFetch({ '/api/suggest-topic-types': { status: 400, body: { ok: false, message: SIGNUP_COPY.pageTypes.tooShort } } })
    expect(await suggestTopicTypes(tooShort.fetcher, 'short')).toEqual({ kind: 'invalid', message: SIGNUP_COPY.pageTypes.tooShort })
    const down = fakeFetch({ '/api/suggest-topic-types': { status: 503, body: { ok: false, message: 'x' } } })
    expect(await suggestTopicTypes(down.fetcher, 'We fix bikes together.')).toEqual({ kind: 'fallback' })
    const gone = fakeFetch({})
    expect(await suggestTopicTypes(gone.fetcher, 'We fix bikes together.')).toEqual({ kind: 'fallback' })
  })
})

// --- the AI choice -------------------------------------------------------------

describe('Check key (POST /api/ai-key)', () => {
  it('sends {kind, key, billingConfirmed} and reads 200 {ok:true} as checked', async () => {
    const { fetcher, calls } = fakeFetch({ '/api/ai-key': { status: 200, body: { ok: true } } })
    expect(await checkAiKey(fetcher, 'openrouter', 'sk-or-v1-test', false)).toEqual({ kind: 'checked' })
    expect(calls[0]?.opts).toEqual({ method: 'POST', body: { kind: 'openrouter', key: 'sk-or-v1-test', billingConfirmed: false } })
  })

  it('a failed key, a rate limit and a server problem show the server message and leave no key kept', async () => {
    for (const [status, message] of [[400, KEY_FAILED_MESSAGE], [429, TOO_MANY_KEY_CHECKS_MESSAGE], [503, SERVER_ERROR_MESSAGE]] as const) {
      const { fetcher } = fakeFetch({ '/api/ai-key': { status, body: { ok: false, message } } })
      expect(await checkAiKey(fetcher, 'gemini', 'AIza-test-key-123456', true)).toEqual({ kind: 'refused', message, field: 'key', kept: false })
    }
  })

  it('the Gemini billing refusal goes to the checkbox and keeps an earlier key; so does a 404', async () => {
    const billing = fakeFetch({ '/api/ai-key': { status: 400, body: { ok: false, message: GEMINI_BILLING_MESSAGE } } })
    expect(await checkAiKey(billing.fetcher, 'gemini', 'AIza-test-key-123456', false)).toEqual({ kind: 'refused', message: GEMINI_BILLING_MESSAGE, field: 'billing', kept: true })
    const gone = fakeFetch({})
    expect(await checkAiKey(gone.fetcher, 'gemini', 'AIza-test-key-123456', true)).toMatchObject({ kind: 'refused', kept: true })
  })

  it('no refusal ever carries the key back', async () => {
    const canary = 'sk-or-v1-CANARY-0123456789'
    for (const status of [400, 429, 503, 500]) {
      const { fetcher } = fakeFetch({ '/api/ai-key': { status, body: { ok: false, message: KEY_FAILED_MESSAGE } } })
      expect(JSON.stringify(await checkAiKey(fetcher, 'openrouter', canary, false))).not.toContain('CANARY')
    }
  })
})

// --- the code -------------------------------------------------------------------

describe('the code (POST /api/check-code)', () => {
  it('an accepted code shows "Code applied. It\'s used when we start your subscription, once your site is live."', async () => {
    const { fetcher, calls } = fakeFetch({ '/api/check-code': { status: 200, body: { ok: true } } })
    expect(await applyCode(fetcher, 'PILOT-ONE')).toEqual({ kind: 'accepted' })
    expect(calls[0]?.opts).toEqual({ method: 'POST', body: { code: 'PILOT-ONE' } })
    expect(SIGNUP_COPY.code.accepted).toBe('Code applied. It\'s used when we start your subscription, once your site is live.')
    expect(read('app/components/PromoCodeField.vue')).toMatch(/v-if="accepted"[\s\S]*?\{\{ copy\.accepted \}\}/)
  })

  it('a refused code shows the server\'s message as it comes (23-15 gives one message for every refusal)', async () => {
    const { fetcher } = fakeFetch({ '/api/check-code': { status: 409, body: { ok: false, message: PROMO_REFUSED_MESSAGE } } })
    expect(await applyCode(fetcher, 'USED-CODE')).toEqual({ kind: 'refused', message: PROMO_REFUSED_MESSAGE })
  })
})

// --- price, button, checkout ---------------------------------------------------

describe('price line, button and checkout', () => {
  it('reads the price line from GET /api/price', async () => {
    const { fetcher, calls } = fakeFetch({ '/api/price': { status: 200, body: { line: '$20 a month' } } })
    expect(await readPrice(fetcher)).toEqual({ kind: 'price', line: '$20 a month' })
    expect(calls[0]).toEqual({ url: '/api/price', opts: { method: 'GET' } })
  })

  it('a 503 from /api/price reads as "We couldn\'t start checkout. Try again in a moment."', async () => {
    const { fetcher } = fakeFetch({ '/api/price': { status: 503, body: { message: PRICE_UNAVAILABLE_MESSAGE } } })
    expect(await readPrice(fetcher)).toEqual({ kind: 'unavailable', message: 'We couldn\'t start checkout. Try again in a moment.' })
  })

  it('the button reads "Continue to card details", and "Redirecting to card details…" while the request runs', () => {
    expect(submitLabel(false)).toBe('Continue to card details')
    expect(submitLabel(true)).toBe('Redirecting to card details…')
    expect(read('app/components/OnboardingForm.vue')).toMatch(/:label="submitLabel\(submitting\)"/)
  })

  it('the create-checkout body carries communityName, subdomain, description, topicTypes, aiChoice and code', async () => {
    const body = checkoutBody({
      communityName: ' Repair Collective ',
      subdomain: 'repair-collective',
      description: 'We fix bikes together.',
      topicTypes: ['Repair logs'],
      aiChoice: 'openrouter',
      code: 'PILOT-ONE'
    })
    expect(body).toEqual({
      communityName: 'Repair Collective',
      subdomain: 'repair-collective',
      description: 'We fix bikes together.',
      topicTypes: ['Repair logs'],
      aiChoice: 'openrouter',
      code: 'PILOT-ONE'
    })
    const { fetcher, calls } = fakeFetch({ '/api/create-checkout': { status: 200, body: { url: 'https://checkout.stripe.com/c/x' } } })
    expect(await startCheckout(fetcher, body)).toEqual({ kind: 'redirect', url: 'https://checkout.stripe.com/c/x' })
    expect(calls[0]).toEqual({ url: '/api/create-checkout', opts: { method: 'POST', body } })
  })

  it('the create-checkout body carries the browser time zone when the form passes one (23-32: the mails 23-37 sends use it)', () => {
    const body = checkoutBody({
      communityName: 'Repair Collective',
      subdomain: 'repair-collective',
      description: '',
      topicTypes: [],
      aiChoice: 'default',
      code: '',
      timeZone: 'America/Denver'
    })
    expect(body.timeZone).toBe('America/Denver')
  })

  it('browserTimeZone reads Intl.DateTimeFormat().resolvedOptions().timeZone, and gives none when Intl throws', () => {
    expect(browserTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => { throw new RangeError('no Intl') })
    expect(browserTimeZone()).toBeUndefined()
    spy.mockRestore()
  })

  it('the form sends browserTimeZone() with the checkout', () => {
    expect(read('app/components/OnboardingForm.vue')).toMatch(/timeZone: browserTimeZone\(\)/)
  })

  it('a 400 "Check your key before continuing." goes to the key field; a 409 is shown as the server words it; anything else is the inline alert', async () => {
    const key = fakeFetch({ '/api/create-checkout': { status: 400, body: { statusCode: 400, statusMessage: KEY_NOT_CHECKED_MESSAGE, message: KEY_NOT_CHECKED_MESSAGE } } })
    expect(await startCheckout(key.fetcher, {})).toEqual({ kind: 'key', message: KEY_NOT_CHECKED_MESSAGE })
    const full = fakeFetch({ '/api/create-checkout': { status: 409, body: { statusCode: 409, statusMessage: FULL_MESSAGE, message: FULL_MESSAGE } } })
    expect(await startCheckout(full.fetcher, {})).toEqual({ kind: 'refused', message: FULL_MESSAGE })
    const broken = fakeFetch({ '/api/create-checkout': { status: 500, body: { statusCode: 500 } } })
    expect(await startCheckout(broken.fetcher, {})).toEqual({ kind: 'failed', message: SIGNUP_COPY.submit.checkoutFailed })
  })

  it('the full-state words are the server\'s FULL_MESSAGE, word for word', () => {
    expect(SIGNUP_COPY.full.alert).toBe(FULL_MESSAGE)
  })
})

// --- mounted -----------------------------------------------------------------------

/** Small stand-ins for the Nuxt UI components: they render their words and pass attributes through. */
const stubs: Record<string, Component> = {
  UContainer: defineComponent((_, { slots }) => () => h('div', slots.default?.())),
  UFormField: defineComponent({
    props: ['label', 'help', 'error', 'name', 'required'],
    setup: (p, { slots }) => () => h('div', { 'data-field': p.name }, [
      p.label ? h('label', p.label) : null,
      slots.default?.(),
      p.help ? h('p', { 'data-help': '' }, p.help) : null,
      p.error ? h('p', { 'data-error': '' }, p.error) : null
    ])
  }),
  UInput: defineComponent({ props: ['modelValue'], setup: (p, { attrs }) => () => h('input', { ...attrs, value: p.modelValue }) }),
  UTextarea: defineComponent({ props: ['modelValue'], setup: (p, { attrs }) => () => h('textarea', attrs, p.modelValue) }),
  UButton: defineComponent({ props: ['label', 'loading'], setup: (p, { attrs, slots }) => () => h('button', attrs, p.label ?? slots.default?.()) }),
  URadioGroup: defineComponent({
    props: ['modelValue', 'items', 'legend'],
    setup: (p, { slots }) => () => h('fieldset', [
      h('legend', slots.legend ? slots.legend() : p.legend),
      ...(p.items as Array<{ value: string, label: string, description: string }>).map(item =>
        h('div', { 'data-option': item.value, 'data-checked': String(item.value === p.modelValue) }, [h('span', item.label), h('p', item.description)]))
    ])
  }),
  UCheckbox: defineComponent({ props: ['modelValue', 'label'], setup: p => () => h('label', [h('input', { type: 'checkbox' }), p.label]) }),
  UAlert: defineComponent({ props: ['description', 'title'], setup: (p, { attrs }) => () => h('div', { ...attrs, 'data-alert': '' }, p.description) }),
  UBadge: defineComponent({ props: ['label'], setup: p => () => h('span', { 'data-badge': '' }, p.label) }),
  UIcon: defineComponent(() => () => h('span', { 'aria-hidden': 'true' }))
}

let fetchAnswers: Record<string, { data?: unknown, error?: unknown }>
let states: Map<string, { value: unknown }>

function installNuxt() {
  fetchAnswers = {}
  states = new Map()
  // The OpenRouter choice is hidden by default (23-18 follow-up); the existing
  // mounted tests run with it on. The flag's own tests below set it per case.
  states.set(OPENROUTER_STATE, ref(true))
  g.useFetch = (url: string) => {
    const a = fetchAnswers[url] ?? {}
    return { data: ref(a.data ?? null), error: ref(a.error ?? null), status: ref(a.error ? 'error' : 'success'), refresh: vi.fn() }
  }
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
  app.component('OnboardingForm', OnboardingForm)
  return renderToString(app)
}

/** The visible text of rendered HTML, with entities decoded. */
const textOf = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

describe('mounted', () => {
  beforeEach(installNuxt)
  afterEach(() => { for (const k of ['useFetch', 'useState', 'definePageMeta', 'useSeoMeta', '$fetch', 'navigateTo']) delete g[k] })

  // Orchestrator, 23-16 gate ruling (i): the OpenRouter recall line renders under
  // Option 3 and not under Options 1 or 2. Remove this test together with the
  // line when todo 2026-11-08-openrouter-member-recall closes.
  it('the OpenRouter recall line shows under Option 3, and not under Options 1 or 2', async () => {
    const recall = AI_CHOICE_COPY.openRouterRecallLine
    const option3 = textOf(await mount(AiChoiceField, { modelValue: 'openrouter' }))
    expect(option3).toContain(recall)
    expect(option3).toContain(AI_CHOICE_COPY.openRouterZdrLine)
    expect(option3.indexOf(AI_CHOICE_COPY.options[2]!.description)).toBeLessThan(option3.indexOf(recall))
    for (const choice of ['default', 'gemini']) {
      const html = textOf(await mount(AiChoiceField, { modelValue: choice }))
      expect(html).not.toContain(recall)
      expect(html).not.toContain(AI_CHOICE_COPY.openRouterZdrLine)
    }
  })

  // 23-18 follow-up: no OpenRouter model passed the re-score, so Option 3 is
  // hidden unless NUXT_OPENROUTER_CHOICE_ENABLED is exactly true. The server
  // plugin copies the server-only setting into page state; the field reads it.
  describe('the OpenRouter choice flag', () => {
    const GLOBALS = ['defineNuxtPlugin', 'useRuntimeConfig']
    afterEach(() => { for (const k of GLOBALS) delete g[k] })

    /** Runs the server plugin with the setting at `value`, as server rendering does. */
    const runPlugin = async (value: unknown) => {
      states.delete(OPENROUTER_STATE)
      g.defineNuxtPlugin = (fn: unknown) => fn
      g.useRuntimeConfig = () => (value === undefined ? {} : { openRouterChoiceEnabled: value })
      vi.resetModules()
      ;((await import('../../app/plugins/ai-choice.server')).default as () => void)()
    }

    it.each([
      ['off (false)', false, false],
      ['unset', undefined, false],
      ['"1"', '1', false],
      ['on (true)', true, true]
    ] as Array<[string, unknown, boolean]>)('with the setting %s (%s), Option 3 shows: %s', async (_name, value, on) => {
      await runPlugin(value)
      expect(states.get(OPENROUTER_STATE)?.value).toBe(on)
      const field = await mount(AiChoiceField, {})
      const form = await mount(OnboardingForm)
      for (const html of [field, form]) {
        const text = textOf(html)
        expect(text).toContain(`${AI_CHOICE_COPY.options[0]!.label} ${AI_CHOICE_COPY.options[0]!.description}`)
        expect(text).toContain(`${AI_CHOICE_COPY.options[1]!.label} ${AI_CHOICE_COPY.options[1]!.description}`)
        if (on) {
          expect(text).toContain(`${AI_CHOICE_COPY.options[2]!.label} ${AI_CHOICE_COPY.options[2]!.description}`)
          expect(html).toContain('data-option="openrouter"')
        } else {
          expect(text).not.toContain('Your own OpenRouter key')
          expect(text).not.toContain(AI_CHOICE_COPY.options[2]!.description)
          expect(html).not.toContain('data-option="openrouter"')
          expect(html.match(/data-option="/g)).toHaveLength(2)
        }
      }
    })

    it('with no plugin run (no page state at all), Option 3 is hidden', async () => {
      states.delete(OPENROUTER_STATE)
      const text = textOf(await mount(AiChoiceField, {}))
      expect(text).not.toContain('Your own OpenRouter key')
    })

    it('the setting stays server-only: the plugin copies a boolean, and nuxt.config has no public copy', () => {
      expect(read('app/plugins/ai-choice.server.ts')).toMatch(/isOpenRouterChoiceEnabled\(useRuntimeConfig\(\)\.openRouterChoiceEnabled\)/)
      const config = read('nuxt.config.ts')
      expect(config.slice(config.indexOf('public: {'))).not.toMatch(/openRouter/i)
    })
  })

  it('renders the three choices from shared/ai-choice.ts, with the legend and the default selected', async () => {
    const html = await mount(AiChoiceField, {})
    const text = textOf(html)
    expect(text).toContain('Which AI should your site use?')
    for (const o of AI_CHOICE_COPY.options) expect(text).toContain(`${o.label} ${o.description}`)
    expect(html).toContain('data-option="default" data-checked="true"')
    expect(html).not.toMatch(/type="password"/)
  })

  it('an own key gets a password field with autocomplete off, paste allowed, "Check key", and for Gemini the billing checkbox', async () => {
    const gemini = await mount(AiChoiceField, { modelValue: 'gemini' })
    // Found inside the aiKey field: the input keeps UFormField's id (23-39, F2b).
    expect(gemini).toMatch(/<div data-field="aiKey">(?:(?!<\/div>).)*<input[^>]*type="password"[^>]*autocomplete="off"/s)
    expect(gemini).not.toMatch(/onpaste|@paste/i)
    expect(textOf(gemini)).toContain('Gemini key')
    expect(textOf(gemini)).toContain(AI_CHOICE_COPY.keyHelp)
    expect(textOf(gemini)).toContain('Check key')
    expect(textOf(gemini)).toContain(AI_CHOICE_COPY.geminiCheckbox)
    const openrouter = textOf(await mount(AiChoiceField, { modelValue: 'openrouter' }))
    expect(openrouter).toContain('OpenRouter key')
    expect(openrouter).not.toContain(AI_CHOICE_COPY.geminiCheckbox)
  })

  it('after a good check only the "Key checked" badge and "Replace key" show; the key field is gone', async () => {
    const html = await mount(AiChoiceField, { modelValue: 'openrouter', checkedKind: 'openrouter' })
    expect(textOf(html)).toContain('Key checked')
    expect(textOf(html)).toContain('Replace key')
    expect(html).not.toMatch(/type="password"/)
  })

  it('the key is cleared from component state at once after a good check, and is never rendered back', () => {
    const src = read('app/components/AiChoiceField.vue')
    expect(src).toMatch(/if \(result\.kind === 'checked'\) \{\s*key\.value = ''/)
    expect(src).not.toMatch(/\{\{\s*key\s*\}\}/)
    expect(src).not.toMatch(/:model-value="key"|:value="key"/)
  })

  it('with /api/capacity returning room false, the page renders the full state and no submit button', async () => {
    fetchAnswers['/api/capacity'] = { data: { room: false } }
    const html = await mount(OnboardingPage)
    const text = textOf(html)
    expect(text).toContain('Waiting for Room')
    expect(text).toContain('We\'re full right now. We\'ll email you when there\'s room.')
    expect(text).toContain('You haven\'t been charged.')
    expect(html).toMatch(/role="status"[^>]*data-alert/)
    expect(html).not.toMatch(/type="submit"/)
    expect(text).not.toContain('Continue to card details')
    expect(text).not.toContain('Name Your Community')
  })

  it('with room true the page renders the form under "Name Your Community"', async () => {
    fetchAnswers['/api/capacity'] = { data: { room: true } }
    fetchAnswers['/api/price'] = { data: { line: '$20 a month' } }
    const text = textOf(await mount(OnboardingPage))
    expect(text).toContain('Name Your Community')
    expect(text).toContain(SIGNUP_COPY.intro)
    expect(text).toContain('Continue to card details')
  })

  it('a failed capacity read counts as full', async () => {
    fetchAnswers['/api/capacity'] = { error: { statusCode: 500 } }
    expect(textOf(await mount(OnboardingPage))).toContain('Waiting for Room')
  })

  it('with /api/price returning {line: "$20 a month"}, the line shows above the button and the under-button line below it', async () => {
    fetchAnswers['/api/price'] = { data: { line: '$20 a month' } }
    const text = textOf(await mount(OnboardingForm))
    const line = text.indexOf('$20 a month')
    const button = text.indexOf('Continue to card details')
    const under = text.indexOf('We\'ll save your card now and charge it only once your site is live.')
    expect(line).toBeGreaterThan(-1)
    expect(button).toBeGreaterThan(line)
    expect(under).toBeGreaterThan(button)
    expect(text.match(/Continue to card details/g)?.length).toBe(1)
  })

  it('with /api/price answering 503, the form shows "We couldn\'t start checkout. Try again in a moment." and keeps the button', async () => {
    fetchAnswers['/api/price'] = { error: { statusCode: 503, data: { message: PRICE_UNAVAILABLE_MESSAGE } } }
    const html = await mount(OnboardingForm)
    expect(textOf(html)).toContain('We couldn\'t start checkout. Try again in a moment.')
    expect(html).toMatch(/<button[^>]*type="submit"/)
    // Pressing it reads the price again before anything else.
    expect(read('app/components/OnboardingForm.vue')).toMatch(/if \(!priceLine\.value\) \{\s*const read = await readPrice\(fetcher\)/)
  })

  it('a pilot session\'s code pre-fills the code field, open, with "Your invite includes this code."', async () => {
    states.set('ln-invite-details', ref({ email: 'organizer@example.org', promoCode: 'PILOT-ONE' }))
    fetchAnswers['/api/price'] = { data: { line: '$20 a month' } }
    const html = await mount(OnboardingForm)
    expect(html).toMatch(/<div data-field="code">(?:(?!<\/div>).)*<input[^>]*value="PILOT-ONE"/s)
    expect(textOf(html)).toContain('Your invite includes this code.')
    expect(textOf(html)).not.toContain('I have a code')
  })

  it('without a code the field is collapsed behind "I have a code", with aria-expanded', async () => {
    const html = await mount(OnboardingForm)
    expect(textOf(html)).toContain('I have a code')
    expect(html).toMatch(/aria-expanded="false"/)
    expect(html).not.toMatch(/data-field="code"/)
  })

  it('the invited email shows read-only (not disabled) with the UI-SPEC help', async () => {
    states.set('ln-invite-details', ref({ email: 'organizer@example.org' }))
    const html = await mount(OnboardingForm)
    const field = html.match(/<div data-field="email">(?:(?!<\/div>).)*<\/div>/s)?.[0] ?? ''
    expect(field).toMatch(/<input[^>]*readonly[^>]*value="organizer@example.org"/)
    expect(field).not.toMatch(/<input[^>]*disabled/)
    expect(textOf(html)).toContain(SIGNUP_COPY.emailHelp)
  })

  it('the start state renders the UI-SPEC section 3 words', async () => {
    const text = textOf(await mount(OnboardingForm))
    for (const words of [
      'Community name', 'Email', 'Page types for your library', SIGNUP_COPY.pageTypes.intro,
      'Describe your community (optional)', SIGNUP_COPY.pageTypes.descriptionHelp, 'Suggest page types',
      'New page type', 'Add a type', 'Always included: Blog, Content, Dialog, News and Reference.',
      'Which AI should your site use?', 'This sets up your site\'s AI assistant and search.'
    ]) expect(text).toContain(words)
  })

  it('page-type rows have a visible label, an input and a remove button named "Remove ‹type›"', async () => {
    const html = await mount(TopicTypesEditor, { modelValue: ['Meeting notes', 'How-to'] })
    expect(textOf(html)).toContain('Page type 1')
    expect(textOf(html)).toContain('Page type 2')
    expect(html).toContain('aria-label="Remove Meeting notes"')
    expect(html).toContain('aria-label="Remove How-to"')
  })

  it('at 8 rows the add row is replaced by "You can have up to 8 page types."', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => `Type ${i + 1}`)
    const html = await mount(TopicTypesEditor, { modelValue: eight })
    expect(textOf(html)).toContain('You can have up to 8 page types.')
    expect(html).not.toMatch(/data-field="newType"/)
  })

  // F2b (fresh3 23-39; orchestrator 2026-11-08; 23-A11Y-EVIDENCE "Proposed
  // edits" 4): the sign-up form's 8 labelled inputs carry no fixed field id,
  // so they keep the id UFormField gives them and its label's for matches in
  // the server HTML, as /invite does since 14b24da.
  const FIXED_FIELD_ID = /\bid="(community-name|signup-email|community-description|page-type-\d+|page-type-new|ai-key|promo-code)"/

  it('the form, two page-type rows, the Gemini key and the code render none of the 8 fixed field ids', async () => {
    states.set('ln-invite-details', ref({ email: 'organizer@example.org', promoCode: 'PILOT-ONE' }))
    const invited = await mount(OnboardingForm)
    expect(invited).toMatch(/data-field="email"/)
    expect(invited).toMatch(/data-field="code"/)
    expect(invited).not.toMatch(FIXED_FIELD_ID)
    states.set('ln-invite-details', ref(null))
    const uninvited = await mount(OnboardingForm)
    expect(uninvited).toMatch(/<div data-field="email">(?:(?!<\/div>).)*<input[^>]*autocomplete="email"/s)
    expect(uninvited).not.toMatch(FIXED_FIELD_ID)
    const rows = await mount(TopicTypesEditor, { modelValue: ['Meeting notes', 'How-to'] })
    expect(rows).toMatch(/data-field="topicTypes\.1"/)
    expect(rows).toMatch(/data-field="newType"/)
    expect(rows).not.toMatch(FIXED_FIELD_ID)
    const gemini = await mount(AiChoiceField, { modelValue: 'gemini' })
    expect(gemini).toMatch(/data-field="aiKey"/)
    expect(gemini).not.toMatch(FIXED_FIELD_ID)
  })

  it('the ids that are not field ids stay: ai-billing, ai-replace-key, promo-code-apply and promo-code-panel', async () => {
    expect(await mount(AiChoiceField, { modelValue: 'gemini' })).toMatch(/id="ai-billing"/)
    expect(await mount(AiChoiceField, { modelValue: 'gemini', checkedKind: 'gemini' })).toMatch(/id="ai-replace-key"/)
    const code = await mount(PromoCodeField, { modelValue: 'PILOT-ONE', prefilled: true })
    expect(code).toMatch(/id="promo-code-apply"/)
    expect(code).toMatch(/id="promo-code-panel"/)
  })
})

// --- the invited session reaches the page -----------------------------------------

describe('invited details for the page', () => {
  const GLOBALS = ['defineNuxtPlugin', 'useState', 'useRequestEvent', 'useRuntimeConfig', 'useRedis']
  let pageStates: Map<string, { value: unknown }>
  let currentEvent: unknown
  let redis: FakeRedis

  beforeEach(() => {
    pageStates = new Map()
    redis = new FakeRedis()
    currentEvent = undefined
    g.defineNuxtPlugin = (fn: unknown) => fn
    g.useState = (key: string, init?: () => unknown) => {
      if (!pageStates.has(key)) pageStates.set(key, { value: init?.() })
      return pageStates.get(key)
    }
    g.useRequestEvent = () => currentEvent
    g.useRuntimeConfig = () => ({ launchOpen: false })
    g.useRedis = () => redis
  })
  afterEach(() => { for (const k of GLOBALS) delete g[k] })

  const plugin = async () => {
    vi.resetModules()
    return (await import('../../app/plugins/invited-state.server')).default as () => void
  }

  it('invitedDetails keeps only the address and the code, never the invite id or the address hash', () => {
    expect(invitedDetails({ inviteId: 'i1', emailHmac: 'h1', email: 'a@example.org', promoCode: 'PILOT-ONE' })).toEqual({ email: 'a@example.org', promoCode: 'PILOT-ONE' })
    expect(invitedDetails({ inviteId: 'i1', emailHmac: 'h1', email: 'a@example.org' })).toEqual({ email: 'a@example.org' })
  })

  it('a live invited session behind the closed gate reaches the page as ln-invite-details', async () => {
    const sid = await createInvitedSession(redis as never, { inviteId: 'i1', emailHmac: 'h1', email: 'a@example.org', promoCode: 'PILOT-ONE' })
    const { default: gate } = await import('../../server/middleware/launch-gate')
    const a = createApp()
    a.use(gate)
    const r = createRouter()
    r.get('/onboarding', defineEventHandler(async (event) => {
      currentEvent = event
      ;(await plugin())()
      return 'rendered'
    }))
    a.use(r)
    const res = await toWebHandler(a)(new Request('http://localhost/onboarding', { headers: { cookie: `${INVITE_COOKIE}=${sid}` } }))
    expect(await res.text()).toBe('rendered')
    expect(pageStates.get('ln-invite-details')?.value).toEqual({ email: 'a@example.org', promoCode: 'PILOT-ONE' })
  })

  it('without a live invited session the details stay null, whatever the context holds', async () => {
    currentEvent = { context: { invited: false, invitedDetails: { email: 'a@example.org' } } }
    ;(await plugin())()
    expect(pageStates.get('ln-invite-details')?.value).toBeNull()
    currentEvent = undefined
    pageStates.clear()
    ;(await plugin())()
    expect(pageStates.get('ln-invite-details')?.value).toBeNull()
  })

  it('/onboarding is never cached, since its payload holds the invited address', () => {
    expect(read('nuxt.config.ts')).toMatch(/'\/onboarding': \{ ssr: true, headers: \{ 'Cache-Control': 'no-store' \} \}/)
  })
})

// --- rules over the sign-up sources ---------------------------------------------------

describe('sign-up rules', () => {
  const FORM_FILES = [
    'app/pages/onboarding.vue',
    'app/components/OnboardingForm.vue',
    'app/components/TopicTypesEditor.vue',
    'app/components/AiChoiceField.vue',
    'app/components/PromoCodeField.vue',
    'app/components/SubdomainPreview.vue',
    'app/utils/onboarding-flow.ts'
  ]

  it('no page, component or flow file says a pilot needs no card or has no card on file (ruling P(a))', () => {
    for (const file of FORM_FILES) {
      expect(read(file), file).not.toMatch(/no card|card on file|without a card|card needed|card isn't needed/i)
    }
  })

  it('no puzzle CAPTCHA, and nothing blocks paste in any field', () => {
    for (const file of FORM_FILES) {
      const src = read(file)
      expect(src, file).not.toMatch(/captcha|turnstile|recaptcha/i)
      expect(src, file).not.toMatch(/@paste|onpaste|v-on:paste/i)
    }
  })

  it('the page is forced light and its h1 is the Title Case page title', () => {
    const page = read('app/pages/onboarding.vue')
    expect(page).toContain('definePageMeta({ colorMode: \'light\' })')
    expect(page).toMatch(/max-w-2xl py-16/)
    expect(SIGNUP_COPY.title).toBe('Name Your Community')
    expect(SIGNUP_COPY.full.title).toBe('Waiting for Room')
  })

  it('one primary button on the form', () => {
    const src = read('app/components/OnboardingForm.vue') + read('app/components/TopicTypesEditor.vue') + read('app/components/AiChoiceField.vue') + read('app/components/PromoCodeField.vue')
    expect(src.match(/color="primary"/g)?.length).toBe(1)
  })

  it('the address preview uses the UI-SPEC status words, with an icon and a word', () => {
    expect(SIGNUP_COPY.address).toEqual({
      checking: 'Checking…',
      available: 'Available',
      taken: 'Taken. Try a different name.',
      invalid: 'Couldn\'t check this right now. Try again in a moment.'
    })
    expect(read('app/components/SubdomainPreview.vue')).toMatch(/SIGNUP_COPY\.address\.taken/)
  })

  // Found by axe (wcag2a label, nested-interactive) on the built form: a named
  // radio group or checkbox inside a <form> makes Reka add a hidden native
  // input with no label. The choice and the tick are read from component state.
  it('the AI radio group and the Gemini checkbox carry no form name, so no unlabelled hidden input is added', () => {
    const src = read('app/components/AiChoiceField.vue')
    const group = src.slice(src.lastIndexOf('<UFormField', src.indexOf('<URadioGroup')), src.indexOf('<URadioGroup'))
    const box = src.slice(src.lastIndexOf('<UFormField', src.indexOf('<UCheckbox')), src.indexOf('<UCheckbox'))
    expect(group).not.toMatch(/\bname=/)
    expect(box).not.toMatch(/\bname=/)
    expect(src).not.toMatch(/<URadioGroup[^>]*\bname=/)
    expect(src).not.toMatch(/<UCheckbox[^>]*\bname=/)
  })

  // Found by axe (wcag22aa target-size): each error-summary link is at least 24px tall.
  it('error-summary links are tall enough to hit (WCAG 2.5.8)', () => {
    expect(read('app/components/OnboardingForm.vue')).toMatch(/<a :href="item\.href" class="inline-block py-1 /)
  })

  // F2b (23-39): the summary is keyed by the UFormField name, and each link's
  // href is '#' plus the input's live id, read when the errors are collected.
  it('the error summary is keyed by field name, and its link href comes from the entry, not a fixed id', () => {
    const src = read('app/components/OnboardingForm.vue')
    expect(src).toMatch(/ref<Array<\{ name: string, message: string, href: string \}>>/)
    for (const name of ['communityName', 'email', 'description', 'aiKey']) expect(src).toContain(`'${name}'`)
    expect(src).toMatch(/:key="item\.name"/)
    expect(src).not.toMatch(/item\.id\b/)
    expect(src).not.toMatch(/:href="`#/)
    // A field is found by its name attribute inside the form, not in the whole document.
    expect(src).toMatch(/form\.value\?\.querySelector/)
    expect(src).toMatch(/\[name="\$\{CSS\.escape\(name\)\}"\]/)
  })

  it('the four form components do no document-wide id look-up for any of the 8 fields', () => {
    for (const file of ['OnboardingForm', 'TopicTypesEditor', 'AiChoiceField', 'PromoCodeField']) {
      const src = read(`app/components/${file}.vue`)
      expect(src, file).not.toMatch(/getElementById\(\s*[`'"](community-name|signup-email|community-description|page-type-|ai-key|promo-code)[`'"]/)
      expect(src, file).not.toMatch(/\bid="(community-name|signup-email|community-description|page-type-new|ai-key|promo-code)"/)
      expect(src, file).not.toMatch(/page-type-/)
    }
  })

  it('the old toast, the old button words and the place placeholder are gone', () => {
    const form = read('app/components/OnboardingForm.vue')
    expect(form).not.toMatch(/useToast|Continue to Payment|Redirecting to payment|Cascadia|You'll see the price at checkout/)
  })
})

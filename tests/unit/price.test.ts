// The price line the sign-up form shows above the button (Phase 23, plan 23-31,
// T-3, UI-SPEC section 3 "Price line"). Checkout runs in setup mode, so Stripe's
// page shows no price; the form reads it from GET /api/price instead. Stripe is a
// mock: nothing here touches a network.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gateDecision } from '../../shared/launch'
import { handlePrice, priceLine, resetPriceCache, PRICE_CACHE_SECONDS, PRICE_UNAVAILABLE_MESSAGE, type PriceLike } from '../../server/utils/price'
import type { InviteRecord } from '../../server/utils/invites'

const T0 = 1_700_000_000_000
const SESSION: InviteRecord = { inviteId: 'inv_1', emailHmac: 'hmac_1', email: 'invited.person@example.com' }

const monthly = (over: Partial<PriceLike> = {}): PriceLike => ({
  unit_amount: 2000,
  currency: 'usd',
  recurring: { interval: 'month', interval_count: 1 },
  ...over
})

function mockStripe(price: PriceLike | (() => PriceLike) = monthly()) {
  const retrieve = vi.fn(async (_id: string) => (typeof price === 'function' ? price() : price))
  return { retrieve, stripe: { prices: { retrieve } } }
}

beforeEach(() => resetPriceCache())

describe('priceLine formats', () => {
  it('2000 usd monthly is "$20 a month"', async () => {
    const { stripe } = mockStripe()
    expect(await priceLine(stripe, 'price_a', 'usd', T0)).toEqual({ ok: true, line: '$20 a month' })
  })

  it('1950 usd monthly keeps both decimals: "$19.50 a month"', async () => {
    const { stripe } = mockStripe(monthly({ unit_amount: 1950 }))
    expect(await priceLine(stripe, 'price_a', 'usd', T0)).toEqual({ ok: true, line: '$19.50 a month' })
  })

  it('20000 usd yearly is "$200 a year"', async () => {
    const { stripe } = mockStripe(monthly({ unit_amount: 20000, recurring: { interval: 'year', interval_count: 1 } }))
    expect(await priceLine(stripe, 'price_a', 'usd', T0)).toEqual({ ok: true, line: '$200 a year' })
  })

  it('interval_count 3 monthly is "$20 every 3 months"', async () => {
    const { stripe } = mockStripe(monthly({ recurring: { interval: 'month', interval_count: 3 } }))
    expect(await priceLine(stripe, 'price_a', 'usd', T0)).toEqual({ ok: true, line: '$20 every 3 months' })
  })

  it('weekly and daily prices read the same way', async () => {
    const week = mockStripe(monthly({ unit_amount: 500, recurring: { interval: 'week', interval_count: 1 } }))
    expect(await priceLine(week.stripe, 'price_w', 'usd', T0)).toEqual({ ok: true, line: '$5 a week' })
    const days = mockStripe(monthly({ unit_amount: 500, recurring: { interval: 'day', interval_count: 14 } }))
    expect(await priceLine(days.stripe, 'price_d', 'usd', T0)).toEqual({ ok: true, line: '$5 every 14 days' })
  })

  it('reads the amount in the currency\'s own minor units: euro cents and whole yen', async () => {
    const eur = mockStripe(monthly({ unit_amount: 1500, currency: 'eur' }))
    expect(await priceLine(eur.stripe, 'price_e', 'eur', T0)).toEqual({ ok: true, line: '€15 a month' })
    const jpy = mockStripe(monthly({ unit_amount: 2000, currency: 'jpy' }))
    expect(await priceLine(jpy.stripe, 'price_y', 'jpy', T0)).toEqual({ ok: true, line: '¥2,000 a month' })
  })

  it('asks Stripe for the configured price id', async () => {
    const { stripe, retrieve } = mockStripe()
    await priceLine(stripe, 'price_xyz', 'usd', T0)
    expect(retrieve).toHaveBeenCalledWith('price_xyz')
  })
})

describe('priceLine refusals', () => {
  it('a price in another currency than the configured one is refused', async () => {
    const { stripe } = mockStripe(monthly({ currency: 'eur' }))
    expect(await priceLine(stripe, 'price_a', 'usd', T0)).toEqual({ ok: false, reason: 'currency mismatch' })
  })

  it('the currency match ignores case', async () => {
    const { stripe } = mockStripe(monthly({ currency: 'USD' }))
    expect((await priceLine(stripe, 'price_a', 'usd', T0)).ok).toBe(true)
  })

  it('a price with no unit_amount, or with no recurring part, is refused', async () => {
    const noAmount = mockStripe(monthly({ unit_amount: null }))
    expect(await priceLine(noAmount.stripe, 'price_n', 'usd', T0)).toEqual({ ok: false, reason: 'unavailable' })
    const oneOff = mockStripe(monthly({ recurring: null }))
    expect(await priceLine(oneOff.stripe, 'price_o', 'usd', T0)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('a currency code Intl cannot format is refused, not thrown', async () => {
    const { stripe } = mockStripe(monthly({ currency: 'zz' }))
    expect(await priceLine(stripe, 'price_z', 'zz', T0)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('an empty price id or empty currency is refused without asking Stripe', async () => {
    const { stripe, retrieve } = mockStripe()
    expect(await priceLine(stripe, '', 'usd', T0)).toEqual({ ok: false, reason: 'unavailable' })
    expect(await priceLine(stripe, 'price_a', '', T0)).toEqual({ ok: false, reason: 'unavailable' })
    expect(retrieve).not.toHaveBeenCalled()
  })
})

describe('priceLine cache', () => {
  it('a second call within 10 minutes reuses the price and makes no second Stripe call', async () => {
    expect(PRICE_CACHE_SECONDS).toBe(600)
    const { stripe, retrieve } = mockStripe()
    await priceLine(stripe, 'price_a', 'usd', T0)
    await priceLine(stripe, 'price_a', 'usd', T0 + 599 * 1000)
    expect(retrieve).toHaveBeenCalledTimes(1)
  })

  it('after 10 minutes it asks Stripe again', async () => {
    const { stripe, retrieve } = mockStripe()
    await priceLine(stripe, 'price_a', 'usd', T0)
    await priceLine(stripe, 'price_a', 'usd', T0 + 601 * 1000)
    expect(retrieve).toHaveBeenCalledTimes(2)
  })

  it('a different price id is its own cache entry', async () => {
    const { stripe, retrieve } = mockStripe()
    await priceLine(stripe, 'price_a', 'usd', T0)
    await priceLine(stripe, 'price_b', 'usd', T0)
    expect(retrieve).toHaveBeenCalledTimes(2)
  })

  it('a Stripe error is thrown and never cached: the next call asks again', async () => {
    let calls = 0
    const retrieve = vi.fn(async (_id: string) => {
      calls++
      if (calls === 1) throw new Error('stripe down')
      return monthly()
    })
    const stripe = { prices: { retrieve } }
    await expect(priceLine(stripe, 'price_a', 'usd', T0)).rejects.toThrow('stripe down')
    expect(await priceLine(stripe, 'price_a', 'usd', T0 + 1000)).toEqual({ ok: true, line: '$20 a month' })
    expect(retrieve).toHaveBeenCalledTimes(2)
  })

  it('a currency mismatch is read from the cached price too, so it makes no second Stripe call', async () => {
    const { stripe, retrieve } = mockStripe(monthly({ currency: 'eur' }))
    expect((await priceLine(stripe, 'price_a', 'usd', T0)).ok).toBe(false)
    expect((await priceLine(stripe, 'price_a', 'usd', T0 + 1000)).ok).toBe(false)
    expect(retrieve).toHaveBeenCalledTimes(1)
  })
})

describe('handlePrice (GET /api/price)', () => {
  const base = (over: Partial<Parameters<typeof handlePrice>[0]> = {}) => {
    const logs: string[] = []
    const { stripe, retrieve } = mockStripe()
    return { logs, retrieve, deps: { open: false, session: SESSION as InviteRecord | null, stripe, priceId: 'price_a', currency: 'usd', now: () => T0, log: (m: string) => { logs.push(m) }, ...over } }
  }

  it('answers {line} for an invited session while closed', async () => {
    const { deps } = base()
    expect(await handlePrice(deps)).toEqual({ status: 200, body: { line: '$20 a month' } })
  })

  it('answers 404 and never asks Stripe while closed without an invited session', async () => {
    const { deps, retrieve, logs } = base({ session: null })
    expect(await handlePrice(deps)).toEqual({ status: 404, body: { message: 'Not Found' } })
    expect(retrieve).not.toHaveBeenCalled()
    expect(logs.join('\n')).not.toContain('invited.person')
  })

  it('answers {line} to anyone once the launch is open', async () => {
    const { deps } = base({ open: true, session: null })
    expect(await handlePrice(deps)).toEqual({ status: 200, body: { line: '$20 a month' } })
  })

  it('a currency mismatch answers 503 with the checkout-could-not-start sentence and logs "price: currency mismatch" only', async () => {
    const { stripe } = mockStripe(monthly({ currency: 'eur' }))
    const { deps, logs } = base({ stripe })
    expect(await handlePrice(deps)).toEqual({ status: 503, body: { message: "We couldn't start checkout. Try again in a moment." } })
    expect(PRICE_UNAVAILABLE_MESSAGE).toBe("We couldn't start checkout. Try again in a moment.")
    expect(logs).toEqual(['price: currency mismatch'])
  })

  it('a price with no amount or no recurring part answers 503 and logs "price: unavailable"', async () => {
    const { stripe } = mockStripe(monthly({ recurring: null }))
    const { deps, logs } = base({ stripe })
    expect((await handlePrice(deps)).status).toBe(503)
    expect(logs).toEqual(['price: unavailable'])
  })

  it('a Stripe error answers 503, logs "price: unavailable" with no error text, and is not cached', async () => {
    let fail = true
    const retrieve = vi.fn(async (_id: string) => {
      if (fail) throw new Error('sk_test_secret exploded')
      return monthly()
    })
    const { deps, logs } = base({ stripe: { prices: { retrieve } } })
    expect(await handlePrice(deps)).toEqual({ status: 503, body: { message: PRICE_UNAVAILABLE_MESSAGE } })
    expect(logs).toEqual(['price: unavailable'])
    expect(logs.join('\n')).not.toContain('sk_test')
    fail = false
    expect(await handlePrice(deps)).toEqual({ status: 200, body: { line: '$20 a month' } })
    expect(retrieve).toHaveBeenCalledTimes(2)
  })

  it('an empty price id or currency in the config answers 503', async () => {
    expect((await handlePrice(base({ priceId: '' }).deps)).status).toBe(503)
    expect((await handlePrice(base({ currency: '' }).deps)).status).toBe(503)
  })
})

describe('GET /api/price is a gated sign-up route', () => {
  it('is not found while closed without an invited session, and passes for an invited one', () => {
    expect(gateDecision('/api/price', false)).toBe('not-found')
    expect(gateDecision('/api/price', false, true)).toBe('pass')
    expect(gateDecision('/api/price', true)).toBe('pass')
  })

  it('the route file is thin: it hands everything to handlePrice and reads the price and currency from the runtime config', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../server/api/price.get.ts', import.meta.url), 'utf8')
    expect(src).toContain('handlePrice')
    expect(src).toContain('stripePriceId')
    expect(src).toContain('stripeCurrency')
    expect(src).not.toMatch(/console\.(log|warn|error)\([^)]*(email|session)/i)
  })
})

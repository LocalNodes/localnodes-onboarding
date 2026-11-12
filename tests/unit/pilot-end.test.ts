import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  PILOT_END_MARGIN_SECONDS,
  PILOT_NOTICE_DAYS,
  addMonthsClampedUtc,
  continueUrl,
  handlePilotContinue,
  openContinueToken,
  pilotEndOf,
  pilotEndsAt,
  pilotMonthsOf,
  sealContinueToken,
  sweepPilotNotices,
  type PilotContinueDeps,
  type PilotNoticeDeps
} from '../../server/utils/pilot-end'
import { sealUnsubscribeToken } from '../../server/utils/unsubscribe'
import { FakeRedis } from './helpers/fake-redis'

/**
 * The free pilot ends unless its organizer says yes (project rule). No yes means no charge:
 * Stripe ends the subscription at cancel_at, set in the create call.
 */

const SECRET = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const DAY = 86400

/** Stripe's monthly period end: the anchor's day clamped to the target month's last day, same time of day (UTC). */
function stripePeriodEnd(anchorSec: number, months: number): number {
  const d = new Date(anchorSec * 1000)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + months
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return Math.floor(Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000)
}

describe('the end date', () => {
  it('adds calendar months with the day clamped to the month\'s last day, keeping the time of day', () => {
    expect(addMonthsClampedUtc(sec('2026-11-30T10:00:00Z'), 3)).toBe(sec('2027-02-28T10:00:00Z'))
    expect(addMonthsClampedUtc(sec('2027-01-31T23:00:00Z'), 1)).toBe(sec('2027-02-28T23:00:00Z'))
    expect(addMonthsClampedUtc(sec('2027-08-31T00:00:00Z'), 1)).toBe(sec('2027-09-30T00:00:00Z'))
    expect(addMonthsClampedUtc(sec('2028-02-29T12:00:00Z'), 12)).toBe(sec('2029-02-28T12:00:00Z'))
    expect(addMonthsClampedUtc(sec('2026-11-29T12:00:00Z'), 3)).toBe(sec('2027-02-28T12:00:00Z'))
    expect(addMonthsClampedUtc(sec('2026-10-15T08:30:00Z'), 3)).toBe(sec('2027-01-15T08:30:00Z'))
  })

  it('is the clamped date minus the 2-day margin', () => {
    expect(PILOT_END_MARGIN_SECONDS).toBe(2 * DAY)
    expect(pilotEndsAt(sec('2026-11-30T10:00:00Z'), 3)).toBe(sec('2027-02-26T10:00:00Z'))
  })

  it('the plan review\'s counterexample: checkout Jan 30 23:00, ready Jan 31 00:00, once: the end falls before Stripe\'s period end', () => {
    const end = pilotEndsAt(sec('2027-01-30T23:00:00Z'), 1)
    expect(end).toBeLessThan(stripePeriodEnd(sec('2027-01-31T00:00:00Z'), 1))
  })

  it('for every checkout hour in two years and every ready delay up to 2 days, the end falls inside the last discounted period', () => {
    const start = sec('2026-11-01T00:00:00Z')
    for (let c = start; c < start + 730 * DAY; c += 3600 * 7) {
      for (const delay of [0, 1, 3599, 3600 * 5, DAY - 1, DAY, 2 * DAY]) {
        const ready = c + delay
        for (const months of [1, 3]) {
          const end = pilotEndsAt(c, months)
          // Before the last discounted period ends (no full-price period starts) ...
          expect(end).toBeLessThan(stripePeriodEnd(ready, months))
          // ... and after the one before it ends (the pilot is not cut short by a period).
          expect(end).toBeGreaterThan(stripePeriodEnd(ready, months - 1))
        }
      }
    }
  })
})

describe('which coupons make a pilot', () => {
  it('100% off, repeating N months: N', () => {
    expect(pilotMonthsOf({ percent_off: 100, duration: 'repeating', duration_in_months: 3 })).toEqual({ pilot: true, months: 3 })
  })

  it('100% off once is never a pilot: it is used up by the first invoice, whatever the price\'s period', () => {
    expect(pilotMonthsOf({ percent_off: 100, duration: 'once' })).toEqual({ pilot: false })
    expect(pilotMonthsOf({ id: 'coupon_full', percent_off: 100, duration: 'once' })).toEqual({ pilot: false })
  })

  it('a coupon that is not 100% off is not a pilot (the paid path)', () => {
    expect(pilotMonthsOf({ percent_off: 50, duration: 'repeating', duration_in_months: 3 })).toEqual({ pilot: false })
    expect(pilotMonthsOf({ amount_off: 500, duration: 'once' })).toEqual({ pilot: false })
  })

  it('refuses what cannot be classified: an id, nothing, forever, a missing or bad month count', () => {
    expect(pilotMonthsOf('coupon_id')).toEqual({ refuse: true })
    expect(pilotMonthsOf(null)).toEqual({ refuse: true })
    expect(pilotMonthsOf(undefined)).toEqual({ refuse: true })
    expect(pilotMonthsOf({ percent_off: 100, duration: 'forever' })).toEqual({ refuse: true })
    expect(pilotMonthsOf({ percent_off: 100, duration: 'repeating' })).toEqual({ refuse: true })
    expect(pilotMonthsOf({ percent_off: 100, duration: 'repeating', duration_in_months: 0 })).toEqual({ refuse: true })
    expect(pilotMonthsOf({ percent_off: 100, duration: 'repeating', duration_in_months: 2.5 })).toEqual({ refuse: true })
    expect(pilotMonthsOf({ percent_off: 100, duration: 'something_new', duration_in_months: 3 })).toEqual({ refuse: true })
  })
})

describe('pilotEndOf (what billing reads off the sign-up)', () => {
  const now = sec('2026-11-11T00:00:00Z')
  it('a sign-up without pilotMonths is not a pilot', () => {
    expect(pilotEndOf({ promoId: 'promo_1' }, now)).toEqual({ pilot: false })
    expect(pilotEndOf({}, now)).toEqual({ pilot: false })
  })
  it('a pilot with a frozen end more than a day away gets it as cancelAt', () => {
    expect(pilotEndOf({ pilotMonths: 3, pilotEndsAt: now + 90 * DAY }, now)).toEqual({ pilot: true, cancelAt: now + 90 * DAY })
    expect(pilotEndOf({ pilotMonths: '3', pilotEndsAt: String(now + 90 * DAY) }, now)).toEqual({ pilot: true, cancelAt: now + 90 * DAY })
  })
  it('a pilot whose end is missing, unreadable or within a day is invalid (cancelAt null)', () => {
    expect(pilotEndOf({ pilotMonths: 3 }, now)).toEqual({ pilot: true, cancelAt: null })
    expect(pilotEndOf({ pilotMonths: 3, pilotEndsAt: 'soon' }, now)).toEqual({ pilot: true, cancelAt: null })
    expect(pilotEndOf({ pilotMonths: 3, pilotEndsAt: now + DAY }, now)).toEqual({ pilot: true, cancelAt: null })
    expect(pilotEndOf({ pilotMonths: 3, pilotEndsAt: now + 1.5 }, now)).toEqual({ pilot: true, cancelAt: null })
  })
})

describe('the continue token', () => {
  it('round-trips the subscription and the end it was minted for', () => {
    const t = sealContinueToken('sub_1', 1800000000, SECRET)
    expect(openContinueToken(t, SECRET)).toEqual({ subscriptionId: 'sub_1', cancelAt: 1800000000 })
  })
  it('refuses a tampered token, another key, junk and an unsubscribe token', () => {
    const t = sealContinueToken('sub_1', 1800000000, SECRET)
    const flipped = t.slice(0, -2) + (t.at(-2) === 'A' ? 'B' : 'A') + t.slice(-1)
    expect(openContinueToken(flipped, SECRET)).toBeNull()
    expect(openContinueToken(t, SECRET.replace('c0', 'd0'))).toBeNull()
    expect(openContinueToken('', SECRET)).toBeNull()
    expect(openContinueToken('not a token', SECRET)).toBeNull()
    expect(openContinueToken(sealUnsubscribeToken('a@example.org', SECRET), SECRET)).toBeNull()
  })
  it('the link is on the sign-up site', () => {
    expect(continueUrl('sub_1', 1800000000, SECRET)).toMatch(/^https:\/\/localnodes\.xyz\/pilot\/continue\?t=[A-Za-z0-9_-]+$/)
  })
})

// ---------------------------------------------------------------------------
// the continue route

const NOW = sec('2027-02-14T12:00:00Z')
const END = sec('2027-02-26T10:00:00Z')

function pilotSub(over: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    status: 'active',
    cancel_at: END,
    metadata: { provision_id: 'pid', pilot: 'ends', pilot_ends_at: String(END) },
    items: { data: [{ price: { unit_amount: 2000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }] },
    ...over
  }
}

function continueDeps(sub: Record<string, unknown> | Error) {
  const retrieve = vi.fn(async () => {
    if (sub instanceof Error) throw sub
    return sub
  })
  const update = vi.fn(async (_id: string, params: Record<string, unknown>) => ({ ...(sub as object), ...params }))
  const deps: PilotContinueDeps = {
    stripe: { subscriptions: { retrieve, update } },
    secret: SECRET,
    now: () => NOW * 1000,
    log: vi.fn()
  }
  return { deps, retrieve, update }
}

describe('handlePilotContinue', () => {
  const token = () => sealContinueToken('sub_1', END, SECRET)

  it('GET shows the date and the price and changes nothing', async () => {
    const { deps, update } = continueDeps(pilotSub())
    const out = await handlePilotContinue('GET', token(), deps)
    expect(out).toEqual({ status: 200, body: { state: 'ends', date: 'February 26, 2027', price: '$20 a month' } })
    expect(update).not.toHaveBeenCalled()
  })

  it('POST clears the end, records the yes, with a stable idempotency key', async () => {
    const { deps, update } = continueDeps(pilotSub())
    const out = await handlePilotContinue('POST', token(), deps)
    expect(out).toEqual({ status: 200, body: { state: 'continued', date: 'February 26, 2027', price: '$20 a month' } })
    expect(update).toHaveBeenCalledTimes(1)
    const [id, params, opts] = update.mock.calls[0]!
    expect(id).toBe('sub_1')
    expect(params).toEqual({ cancel_at: '', metadata: { pilot: 'continued', pilot_continued_at: String(NOW) } })
    expect(opts).toMatchObject({ idempotencyKey: `pilot-continue-sub_1-${END}`, maxNetworkRetries: 0 })
  })

  it('a repeat POST after the yes answers continued and calls nothing', async () => {
    const { deps, update } = continueDeps(pilotSub({ cancel_at: null, metadata: { pilot: 'continued', pilot_ends_at: String(END), pilot_continued_at: String(NOW) } }))
    const out = await handlePilotContinue('POST', token(), deps)
    expect(out).toMatchObject({ status: 200, body: { state: 'continued' } })
    expect(update).not.toHaveBeenCalled()
  })

  it('an ended pilot (canceled, or past its end) answers ended and changes nothing', async () => {
    for (const sub of [pilotSub({ status: 'canceled' }), pilotSub({ cancel_at: NOW - 10 })]) {
      const { deps, update } = continueDeps(sub)
      // The token is for the subscription's own end.
      const t = sealContinueToken('sub_1', Number((sub as { cancel_at: number }).cancel_at), SECRET)
      expect(await handlePilotContinue('POST', t, deps)).toMatchObject({ status: 200, body: { state: 'ended' } })
      expect(update).not.toHaveBeenCalled()
    }
  })

  it('refuses a bad token, a token for another end, and a subscription that is not an ending pilot', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['junk', pilotSub()],
      [sealContinueToken('sub_1', END + 60, SECRET), pilotSub()],
      [sealContinueToken('sub_1', END, SECRET), pilotSub({ metadata: { provision_id: 'pid' } })],
      [sealContinueToken('sub_1', END, SECRET), pilotSub({ status: 'past_due' })]
    ]
    for (const [t, sub] of cases) {
      const { deps, update } = continueDeps(sub)
      expect(await handlePilotContinue('POST', t, deps)).toEqual({ status: 400, body: { state: 'invalid' } })
      expect(update).not.toHaveBeenCalled()
    }
  })

  it('a Stripe 404 is invalid; any other Stripe error is 503 with nothing claimed', async () => {
    const notFound = Object.assign(new Error('No such subscription'), { statusCode: 404 })
    expect(await handlePilotContinue('POST', token(), continueDeps(notFound).deps)).toEqual({ status: 400, body: { state: 'invalid' } })
    const down = Object.assign(new Error('down'), { statusCode: 500 })
    expect(await handlePilotContinue('POST', token(), continueDeps(down).deps)).toEqual({ status: 503, body: { state: 'unavailable' } })
  })

  it('a failed update is 503, not continued', async () => {
    const { deps, update } = continueDeps(pilotSub())
    update.mockRejectedValueOnce(Object.assign(new Error('down'), { statusCode: 500 }))
    expect(await handlePilotContinue('POST', token(), deps)).toEqual({ status: 503, body: { state: 'unavailable' } })
  })

  it('no secret refuses everything', async () => {
    const { deps } = continueDeps(pilotSub())
    expect(await handlePilotContinue('GET', token(), { ...deps, secret: '' })).toEqual({ status: 503, body: { state: 'unavailable' } })
  })
})

// ---------------------------------------------------------------------------
// the notice step

function noticeSetup(subs: Array<Record<string, unknown>>, opts: { pages?: number } = {}) {
  const redis = new FakeRedis()
  const pages = opts.pages ?? 1
  const per = Math.ceil(subs.length / pages) || 1
  const list = vi.fn(async (params: { starting_after?: string }) => {
    const from = params.starting_after ? subs.findIndex(s => s.id === params.starting_after) + 1 : 0
    const data = subs.slice(from, from + per)
    return { data, has_more: from + per < subs.length }
  })
  const update = vi.fn(async () => ({}))
  const fetchMock = vi.fn(async () => ({ id: 'email_1' }))
  const logs: string[] = []
  const deps: PilotNoticeDeps = {
    redis,
    stripe: { subscriptions: { list, update } },
    fetch: fetchMock,
    apiKey: 're_test',
    from: 'LocalNodes <hello@localnodes.xyz>',
    secret: SECRET,
    now: () => NOW * 1000,
    log: msg => logs.push(msg)
  }
  return { redis, deps, list, update, fetchMock, logs }
}

const withCustomer = (s: Record<string, unknown>, email = 'organizer@example.org') => ({ ...s, customer: { id: 'cus_1', email } })

describe('sweepPilotNotices', () => {
  it('mails each ending pilot within 14 days once, then records it on the subscription', async () => {
    expect(PILOT_NOTICE_DAYS).toBe(14)
    const due = withCustomer(pilotSub())
    const later = withCustomer(pilotSub({ id: 'sub_2', cancel_at: NOW + 20 * DAY }))
    const sent = withCustomer(pilotSub({ id: 'sub_3', metadata: { pilot: 'ends', pilot_notice_sent: '1' } }))
    const paid = withCustomer(pilotSub({ id: 'sub_4', metadata: { provision_id: 'p4' } }))
    const continued = withCustomer(pilotSub({ id: 'sub_5', cancel_at: null, metadata: { pilot: 'continued' } }))
    const { deps, list, update, fetchMock } = noticeSetup([due, later, sent, paid, continued], { pages: 2 })
    const out = await sweepPilotNotices(deps)
    expect(out).toEqual({ ran: true, due: 1, sent: 1, errors: 0 })
    expect(list).toHaveBeenCalledTimes(2)
    expect(list.mock.calls[0]![0]).toMatchObject({ status: 'active', expand: ['data.customer'], limit: 100 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, req] = fetchMock.mock.calls[0]! as unknown as [string, { headers: Record<string, string>, body: Record<string, unknown> }]
    expect(url).toBe('https://api.resend.com/emails')
    expect(req.headers['Idempotency-Key']).toBe('pilot-notice-sub_1')
    expect(req.body.to).toEqual(['organizer@example.org'])
    expect(String(req.body.text)).toContain('February 26, 2027')
    expect(String(req.body.text)).toContain('$20 a month')
    // The late yes works for 30 days after the end: the mail names that last day.
    expect(String(req.body.text)).toContain('the same button still works for 30 days, until March 28, 2027, unless we have already removed the site')
    const link = /https:\/\/localnodes\.xyz\/pilot\/continue\?t=([A-Za-z0-9_-]+)/.exec(String(req.body.text))
    expect(link).not.toBeNull()
    expect(openContinueToken(link![1]!, SECRET)).toEqual({ subscriptionId: 'sub_1', cancelAt: END })
    expect(update).toHaveBeenCalledWith('sub_1', { metadata: { pilot_notice_sent: String(NOW) } }, expect.objectContaining({ maxNetworkRetries: 0 }))
  })

  it('runs at most once every 6 hours', async () => {
    const { deps, list, redis } = noticeSetup([withCustomer(pilotSub())])
    await sweepPilotNotices(deps)
    expect(await sweepPilotNotices(deps)).toEqual({ ran: false })
    expect(list).toHaveBeenCalledTimes(1)
    redis.advance(6 * 3600 + 1)
    expect(await sweepPilotNotices(deps)).toMatchObject({ ran: true })
  })

  it('a failed send writes nothing to the subscription and counts an error; the next run tries again', async () => {
    const { deps, update, fetchMock, redis } = noticeSetup([withCustomer(pilotSub())])
    fetchMock.mockRejectedValueOnce(new Error('resend down'))
    expect(await sweepPilotNotices(deps)).toEqual({ ran: true, due: 1, sent: 0, errors: 1 })
    expect(update).not.toHaveBeenCalled()
    redis.advance(6 * 3600 + 1)
    expect(await sweepPilotNotices(deps)).toEqual({ ran: true, due: 1, sent: 1, errors: 0 })
  })

  // Fakes that behave like the services: Resend replays a key with the same body
  // and refuses it with another body (409); Stripe refuses a key reused with other params.
  function strictServices(deps: PilotNoticeDeps) {
    const delivered: Array<Record<string, unknown>> = []
    const mailByKey = new Map<string, string>()
    let mailDown = false
    const fetchMock = vi.fn(async (_url: string, req: { headers: Record<string, string>, body: Record<string, unknown> }) => {
      if (mailDown) throw new Error('resend down')
      const key = req.headers['Idempotency-Key']!
      const body = JSON.stringify(req.body)
      const seen = mailByKey.get(key)
      if (seen !== undefined && seen !== body) throw Object.assign(new Error('invalid_idempotent_request'), { statusCode: 409 })
      if (seen === undefined) {
        mailByKey.set(key, body)
        delivered.push(req.body)
      }
      return { id: 'email_1' }
    })
    // Stripe also replays a stored 500 for the same key.
    const markByKey = new Map<string, { body: string, failed: boolean }>()
    let markDown = false
    const update = vi.fn(async (_id: string, params: Record<string, unknown>, opts: { idempotencyKey: string }) => {
      const body = JSON.stringify(params)
      const seen = markByKey.get(opts.idempotencyKey)
      if (seen !== undefined && seen.body !== body) throw Object.assign(new Error('idempotency_error'), { statusCode: 400 })
      if (seen?.failed) throw Object.assign(new Error('down (replayed)'), { statusCode: 500 })
      if (seen === undefined) markByKey.set(opts.idempotencyKey, { body, failed: markDown })
      if (markDown) throw Object.assign(new Error('down'), { statusCode: 500 })
      return {}
    })
    deps.fetch = fetchMock as unknown as PilotNoticeDeps['fetch']
    deps.stripe.subscriptions.update = update as unknown as PilotNoticeDeps['stripe']['subscriptions']['update']
    return {
      delivered,
      update,
      setMailDown: (v: boolean) => { mailDown = v },
      /** Resend keeps a key for 24 hours only. */
      forgetMailKeys: () => mailByKey.clear(),
      setMarkDown: (v: boolean) => { markDown = v }
    }
  }

  it('a send that lands while the mark fails is never mailed again; a later run only writes the mark, with the first send time', async () => {
    const { deps, redis } = noticeSetup([withCustomer(pilotSub())])
    const svc = strictServices(deps)
    svc.setMarkDown(true)
    expect(await sweepPilotNotices(deps)).toEqual({ ran: true, due: 1, sent: 0, errors: 1 })
    expect(svc.delivered).toHaveLength(1)
    // later runs: within Resend's 24 hours and after it
    for (const hours of [6, 30]) {
      if (hours > 24) svc.forgetMailKeys()
      redis.advance(6 * 3600 + 1)
      expect(await sweepPilotNotices({ ...deps, now: () => (NOW + hours * 3600) * 1000 })).toMatchObject({ ran: true, due: 1, errors: 1 })
    }
    svc.setMarkDown(false)
    svc.forgetMailKeys()
    redis.advance(6 * 3600 + 1)
    expect(await sweepPilotNotices({ ...deps, now: () => (NOW + 42 * 3600) * 1000 })).toEqual({ ran: true, due: 1, sent: 1, errors: 0 })
    expect(svc.delivered).toHaveLength(1)
    expect(svc.update.mock.calls.at(-1)![1]).toEqual({ metadata: { pilot_notice_sent: String(NOW) } })
  })

  it('a send whose reply is lost is retried with the very same mail, so Resend does not deliver it twice', async () => {
    const { deps, redis } = noticeSetup([withCustomer(pilotSub())])
    const svc = strictServices(deps)
    const real = deps.fetch
    let lose = true
    deps.fetch = async (url, opts) => {
      const out = await real(url, opts)
      if (lose) {
        lose = false
        throw new Error('reply lost')
      }
      return out
    }
    expect(await sweepPilotNotices(deps)).toEqual({ ran: true, due: 1, sent: 0, errors: 1 })
    redis.advance(6 * 3600 + 1)
    expect(await sweepPilotNotices({ ...deps, now: () => (NOW + 6 * 3600) * 1000 })).toEqual({ ran: true, due: 1, sent: 1, errors: 0 })
    expect(svc.delivered).toHaveLength(1)
  })

  it('when the mail cannot be recorded first, nothing is sent', async () => {
    const { deps, redis, fetchMock, logs } = noticeSetup([withCustomer(pilotSub())])
    const realSet = redis.set.bind(redis)
    redis.set = (async (key: string, value: unknown, opts?: { nx?: boolean, ex?: number }) => {
      if (key.startsWith('pilot-notice:mail:')) throw new Error('redis down')
      return realSet(key, value, opts)
    }) as typeof redis.set
    expect(await sweepPilotNotices(deps)).toEqual({ ran: true, due: 1, sent: 0, errors: 1 })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(logs.join('\n')).not.toMatch(/sub_|@|cus_/)
  })

  // Redis writes to the notice record fail from the nth write on (1-based), until healed.
  function breakRecordWrites(redis: FakeRedis, fromWrite: number) {
    const realSet = redis.set.bind(redis)
    let writes = 0
    let healed = false
    redis.set = (async (key: string, value: unknown, opts?: { nx?: boolean, ex?: number }) => {
      if (key.startsWith('pilot-notice:mail:') && !healed && ++writes >= fromWrite) throw new Error('redis down')
      return realSet(key, value, opts)
    }) as typeof redis.set
    return { heal: () => { healed = true } }
  }

  it('accepted by Resend, then the record and the mark both fail: after Resend forgets the key, nothing is sent again and a person is flagged', async () => {
    const { deps, redis, logs } = noticeSetup([withCustomer(pilotSub())])
    const svc = strictServices(deps)
    svc.setMarkDown(true)
    // writes: 1 the record with the first-try time, 2 the sent time (fails)
    breakRecordWrites(redis, 2)
    expect(await sweepPilotNotices(deps)).toEqual({ ran: true, due: 1, sent: 0, errors: 1 })
    expect(svc.delivered).toHaveLength(1)
    for (const hours of [6, 12, 18, 24, 30, 36]) {
      if (hours >= 24) svc.forgetMailKeys()
      redis.advance(6 * 3600 + 1)
      await sweepPilotNotices({ ...deps, now: () => (NOW + hours * 3600) * 1000 })
    }
    expect(svc.delivered).toHaveLength(1)
    expect(logs.join('\n')).toContain('pilot-notice: not confirmed within a day, needs a person')
    expect(logs.join('\n')).not.toMatch(/sub_|@|cus_/)
  })

  it('an address corrected in Stripe after a try sends nothing to either address and flags a person', async () => {
    const subs = [withCustomer(pilotSub())]
    const { deps, redis, logs } = noticeSetup(subs)
    const svc = strictServices(deps)
    svc.setMailDown(true)
    await sweepPilotNotices(deps)
    svc.setMailDown(false)
    subs[0] = withCustomer(pilotSub(), 'fixed@example.org')
    redis.advance(6 * 3600 + 1)
    expect(await sweepPilotNotices({ ...deps, now: () => (NOW + 6 * 3600) * 1000 })).toEqual({ ran: true, due: 1, sent: 0, errors: 1 })
    expect(svc.delivered).toHaveLength(0)
    expect(logs.join('\n')).toContain('pilot-notice: address or sender changed after a try, needs a person')
  })

  it('a sender changed after a try sends nothing and flags a person; the retry body is the whole first body', async () => {
    const { deps, redis, logs } = noticeSetup([withCustomer(pilotSub())])
    const svc = strictServices(deps)
    const bodies: Array<Record<string, unknown>> = []
    const inner = deps.fetch
    let fail = true
    deps.fetch = async (url, opts) => {
      bodies.push(opts.body)
      if (fail) {
        fail = false
        throw new Error('reply lost')
      }
      return inner(url, opts)
    }
    await sweepPilotNotices(deps)
    redis.advance(6 * 3600 + 1)
    expect(await sweepPilotNotices({ ...deps, from: 'Other <x@localnodes.xyz>', now: () => (NOW + 6 * 3600) * 1000 })).toEqual({ ran: true, due: 1, sent: 0, errors: 1 })
    expect(logs.join('\n')).toContain('pilot-notice: address or sender changed after a try, needs a person')
    redis.advance(6 * 3600 + 1)
    expect(await sweepPilotNotices({ ...deps, now: () => (NOW + 12 * 3600) * 1000 })).toEqual({ ran: true, due: 1, sent: 1, errors: 0 })
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual(bodies[0])
    expect(svc.delivered).toHaveLength(1)
  })

  it('a pilot with no address is an error with a fixed log line, and nothing is sent', async () => {
    const { deps, fetchMock, logs } = noticeSetup([withCustomer(pilotSub(), '')])
    expect(await sweepPilotNotices(deps)).toEqual({ ran: true, due: 1, sent: 0, errors: 1 })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(logs.join('\n')).not.toMatch(/sub_|@|cus_/)
  })

  it('without mail settings it sends nothing and says so', async () => {
    const { deps, fetchMock } = noticeSetup([withCustomer(pilotSub())])
    expect(await sweepPilotNotices({ ...deps, apiKey: '' })).toEqual({ ran: false, unconfigured: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

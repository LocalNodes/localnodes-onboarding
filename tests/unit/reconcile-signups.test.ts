// Phase 23, plan 23-21: the read-only reconciliation command
// (scripts/reconcile-signups.mjs). Everything runs offline: a fake Stripe, the
// shared FakeRedis behind a guard that allows only read commands, and a fixed
// clock. No test touches a network or reads a secret; all ids and addresses
// below are made up.
//
// The guard is the point of the tests that mention it: the fake Redis and the
// fake Stripe throw (and record the attempt) on any command outside the read
// lists, and every run ends with "nothing was attempted, nothing changed", so a
// write the script catches and swallows still fails the test.
import { describe, it, expect } from 'vitest'
import { FakeRedis } from './helpers/fake-redis'
import { FLAG_KINDS, LIFECYCLE_STATES, billingWaits } from '../../server/utils/lifecycle'
import * as script from '../../scripts/reconcile-signups.mjs'

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0)
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()
const lifecycle = { FLAG_KINDS, LIFECYCLE_STATES, billingWaits }

const REDIS_READS = ['get', 'hgetall', 'zrange', 'scan', 'type', 'ttl']

/** FakeRedis behind a guard: the read commands the script may use, nothing else. */
function guardedRedis(opts: { scanPage?: number } = {}) {
  const inner = new FakeRedis()
  const attempted: string[] = []
  const pageSize = opts.scanPage ?? 2
  const allowed: Record<string, (...a: any[]) => Promise<unknown>> = {
    get: (key: string) => inner.get(key),
    hgetall: (key: string) => inner.hgetall(key),
    ttl: (key: string) => inner.ttl(key),
    type: (key: string) => inner.type(key),
    // As Upstash: a flat [member, score, member, score ...] list with withScores.
    zrange: async (key: string, start: number, stop: number, o: { withScores?: boolean } = {}) => {
      const members = await inner.zrange(key, start, stop)
      if (!o.withScores) return members
      const out: unknown[] = []
      for (const m of members) out.push(m, await inner.zscore(key, m))
      return out
    },
    // As Upstash: [nextCursor as a string, keys], '0' when the scan is done.
    scan: async (cursor: string | number, o: { match?: string, count?: number } = {}) => {
      const re = new RegExp(`^${(o.match ?? '*').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
      const keys = inner.keys().filter(k => re.test(k)).sort()
      const from = Number(cursor)
      const next = from + pageSize
      return [next >= keys.length ? '0' : String(next), keys.slice(from, next)]
    }
  }
  const redis = new Proxy({}, {
    get(_t, name: string) {
      if (REDIS_READS.includes(name)) return allowed[name]
      return () => {
        attempted.push(name)
        throw new Error(`guarded-redis: ${name} is not a read command`)
      }
    }
  })
  const before = { dump: '' }
  return { inner, redis, attempted, snapshot: () => { before.dump = inner.dump() }, unchanged: () => inner.dump() === before.dump }
}

interface Session { id: string, created: number, status?: string, mode?: string, metadata?: Record<string, string>, customer_email?: string }
interface Sub { id: string, status: string, metadata?: Record<string, string>, discounts?: Array<string | { end: number | null, coupon?: { percent_off?: number | null } }>, cancel_at?: number | null, ended_at?: number | null }

/** A fake Stripe: list and retrieve only, pages of 2, and a log of what was asked. */
function guardedStripe(data: { sessions?: Session[], subs?: Sub[] } = {}, pageSize = 2) {
  const attempted: string[] = []
  const listed: Array<{ what: string, params: Record<string, any> }> = []
  const page = <T extends { id: string }>(what: string, all: T[], params: Record<string, any>) => {
    listed.push({ what, params })
    const start = params.starting_after ? all.findIndex(x => x.id === params.starting_after) + 1 : 0
    const slice = all.slice(start, start + pageSize)
    return { data: slice, has_more: start + pageSize < all.length }
  }
  const tree: any = {
    checkout: {
      sessions: {
        list: async (params: Record<string, any>) => {
          const gte = params.created?.gte
          const all = (data.sessions ?? []).filter(s => (gte === undefined || s.created >= gte) && (!params.status || (s.status ?? 'complete') === params.status))
          return page('sessions', all, params)
        }
      }
    },
    subscriptions: {
      list: async (params: Record<string, any>) => {
        const all = (data.subs ?? []).filter(s => !params.status || params.status === 'all' || s.status === params.status)
        return page('subscriptions', all, params)
      }
    }
  }
  const strict = (obj: any, path: string): any => new Proxy(obj, {
    get(t, name: string) {
      if (name in t) {
        const v = t[name]
        return v !== null && typeof v === 'object' ? strict(v, `${path}${name}.`) : v
      }
      // Any name the fake does not list is a write (or an unknown read): it throws when called
      // and when drilled into (stripe.refunds.create), and either way the attempt is recorded.
      const refuse = () => {
        attempted.push(`${path}${name}`)
        throw new Error(`guarded-stripe: ${path}${name} is not a read call`)
      }
      return new Proxy(refuse, { get: refuse })
    }
  })
  return { stripe: strict(tree, 'stripe.'), attempted, listed }
}

const record = (over: Record<string, unknown> = {}, ageMs = 2 * HOUR) => ({
  status: 'complete',
  subdomain: 'quiet-garden',
  provisionId: 'prov_aaaaaaaaaaaa',
  attempt: 1,
  startedAt: iso(NOW - ageMs - HOUR),
  updatedAt: iso(NOW - ageMs),
  billing: 'paid',
  activatedAt: iso(NOW - ageMs),
  ...over
})

async function world() {
  const g = guardedRedis()
  const s = guardedStripe()
  const put = (sid: string, fields: Record<string, unknown>) => g.inner.hset(`provision:${sid}`, fields)
  const sweep = (name: string, sid: string, score = NOW) => g.inner.zadd(name, { score, member: sid })
  const flag = (member: string, score = NOW - HOUR) => g.inner.zadd('reconcile:flags', { score, member })
  return { g, s, put, sweep, flag }
}

type World = Awaited<ReturnType<typeof world>>

/** Run the reconciliation and check the read-only rule every time. */
async function run(w: World, over: { hours?: number } = {}) {
  w.g.snapshot()
  const out = await script.reconcile({ hours: over.hours ?? 72, now: () => NOW }, { redis: w.g.redis, stripe: w.s.stripe, lifecycle })
  expect(w.g.attempted).toEqual([])
  expect(w.s.attempted).toEqual([])
  expect(w.g.unchanged()).toBe(true)
  return out.rows as Array<Record<string, any>>
}
const named = (rows: Array<Record<string, any>>, row: string) => rows.filter(r => r.row === row)

describe('reconcile-signups: nothing to report', () => {
  it('a complete and activated, a torn down with a result, and a build under 15 minutes print nothing', async () => {
    const w = await world()
    await w.put('cs_test_done', record())
    await w.put('cs_test_gone', record({ status: 'torn_down', billing: 'declined', activatedAt: '', teardownApp: 'deleted', tornDown: true }))
    await w.put('cs_test_build', record({ status: 'provisioning', billing: '', activatedAt: '', githubRunId: 77 }, 10 * MIN))
    await w.put('cs_test_fresh', record({ status: 'triggered', billing: '', activatedAt: '' }, 5 * MIN))
    expect(await run(w)).toEqual([])
  })

  it('no status in the lifecycle list is read as unknown, and one outside it prints', async () => {
    for (const status of LIFECYCLE_STATES) {
      const w = await world()
      await w.put('cs_test_x', record({ status, billing: 'paid', activatedAt: iso(NOW - HOUR) }))
      expect(named(await run(w), 'unknown status')).toEqual([])
    }
    const w = await world()
    await w.put('cs_test_odd', record({ status: 'sideways' }))
    const rows = named(await run(w), 'unknown status')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sid: 'cs_test_odd', status: 'sideways' })
  })
})

describe('reconcile-signups: Stripe sessions without a record', () => {
  const session = (over: Partial<Session> = {}): Session => ({
    id: 'cs_test_lost', created: Math.floor((NOW - 2 * HOUR) / 1000), status: 'complete', mode: 'setup',
    metadata: { provision_id: 'prov_bbbbbbbbbbbb', subdomain: 'lost-site', invited: 'true' }, ...over
  })

  it('prints no provision record for a completed session with no record', async () => {
    const w = await world()
    w.s = guardedStripe({ sessions: [session()] })
    const rows = named(await run(w), 'no provision record')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sid: 'cs_test_lost', provisionId: 'prov_bbbbbbbbbbbb', subdomain: 'lost-site' })
  })

  it('prints record expired, with the dedupe marker subscription, when the marker is still there', async () => {
    const w = await world()
    w.s = guardedStripe({ sessions: [session()] })
    await w.g.inner.hset('dedupe:prov_bbbbbbbbbbbb', { checkoutSession: 'cs_test_lost', subscriptionId: 'sub_123' })
    const rows = await run(w)
    expect(named(rows, 'no provision record')).toEqual([])
    const expired = named(rows, 'record expired')
    expect(expired).toHaveLength(1)
    expect(expired[0]).toMatchObject({ sid: 'cs_test_lost', detail: { subscriptionId: 'sub_123' } })
  })

  it('prints nothing for a session that has its record, an open session and an expired one', async () => {
    const w = await world()
    w.s = guardedStripe({ sessions: [session({ id: 'cs_test_has' }), session({ id: 'cs_test_open', status: 'open' }), session({ id: 'cs_test_exp', status: 'expired' })] })
    await w.put('cs_test_has', record())
    expect(await run(w)).toEqual([])
  })

  it('asks for completed sessions of the last --hours only, and follows the pages', async () => {
    const w = await world()
    const at = (h: number) => Math.floor((NOW - h * HOUR) / 1000)
    w.s = guardedStripe({
      sessions: [
        session({ id: 'cs_test_a', created: at(1) }),
        session({ id: 'cs_test_b', created: at(2) }),
        session({ id: 'cs_test_c', created: at(30) }),
        session({ id: 'cs_test_old', created: at(100) })
      ]
    })
    const wide = new Set(named(await run(w), 'no provision record').map(r => r.sid))
    expect([...wide].sort()).toEqual(['cs_test_a', 'cs_test_b', 'cs_test_c'])
    const first = w.s.listed.find(l => l.what === 'sessions')!.params
    expect(first.status).toBe('complete')
    expect(first.created.gte).toBe(Math.floor((NOW - 72 * HOUR) / 1000))
    expect(w.s.listed.filter(l => l.what === 'sessions').length).toBeGreaterThan(1)

    const narrow = await run(w, { hours: 24 })
    expect(named(narrow, 'no provision record').map(r => r.sid).sort()).toEqual(['cs_test_a', 'cs_test_b'])
  })
})

describe('reconcile-signups: reconcile:flags', () => {
  it('has a case for every kind in FLAG_KINDS: kind and sign-up id from the first two segments', async () => {
    expect(FLAG_KINDS).toHaveLength(11)
    for (const kind of FLAG_KINDS) {
      const w = await world()
      await w.flag(`${kind}:cs_test_k_1_x`, NOW - 3 * HOUR)
      const rows = named(await run(w), 'flag')
      expect(rows, kind).toHaveLength(1)
      expect(rows[0]).toMatchObject({ sid: 'cs_test_k_1_x', detail: { kind }, raisedAt: iso(NOW - 3 * HOUR) })
    }
  })

  it('parses the three longer shapes to the right kind and sign-up id', async () => {
    const w = await world()
    await w.flag('paid_in_review:cs_test_p_1:evt_1AbC:in_9XyZ:1900')
    await w.flag('late_activation:cs_test_l_1:kept:mail_maybe:cancel,card')
    await w.flag('refund_problem:cs_test_r_1:pending')
    await w.flag('refund_problem:cs_test_r_2:cancel')
    await w.flag('refund_problem:cs_test_r_3')
    const byMember = Object.fromEntries(named(await run(w), 'flag').map(r => [`${r.detail.kind}:${r.sid}`, r.detail]))
    expect(byMember['paid_in_review:cs_test_p_1']).toMatchObject({ rest: 'evt_1AbC:in_9XyZ:1900', eventId: 'evt_1AbC', invoiceId: 'in_9XyZ', amount: '1900' })
    expect(byMember['late_activation:cs_test_l_1']).toMatchObject({ rest: 'kept:mail_maybe:cancel,card', kept: true, mail: 'maybe', steps: 'cancel,card' })
    expect(byMember['refund_problem:cs_test_r_1']).toMatchObject({ rest: 'pending' })
    expect(byMember['refund_problem:cs_test_r_2']).toMatchObject({ rest: 'cancel' })
    expect(byMember['refund_problem:cs_test_r_3']).toMatchObject({ rest: '' })
  })

  it('prints a kind it does not know as unknown flag and never drops it', async () => {
    const w = await world()
    await w.flag('brand_new_kind:cs_test_z_1:extra')
    const rows = await run(w)
    expect(named(rows, 'flag')).toEqual([])
    const unknown = named(rows, 'unknown flag')
    expect(unknown).toHaveLength(1)
    expect(unknown[0]).toMatchObject({ sid: 'cs_test_z_1', detail: { kind: 'brand_new_kind', rest: 'extra' } })
  })

  it('shows the record state beside a flag when the record is there, and still prints it when the record has expired', async () => {
    const w = await world()
    await w.put('cs_test_with', record({ status: 'ready', billing: 'review', subdomain: 'with-record' }))
    await w.sweep('sweep:billing', 'cs_test_with') // a legitimate wait would have none; keep the mismatch row out of this case
    await w.flag('stripe_unclear:cs_test_with')
    await w.flag('stripe_unclear:cs_test_expired')
    const rows = named(await run(w), 'flag')
    const bySid = Object.fromEntries(rows.map(r => [r.sid, r]))
    expect(bySid.cs_test_with).toMatchObject({ subdomain: 'with-record', status: 'ready', billing: 'review', provisionId: 'prov_aaaaaaaaaaaa' })
    expect(bySid.cs_test_expired).toMatchObject({ subdomain: '-', status: '-' })
  })
})

describe('reconcile-signups: stuck states read from the record', () => {
  it('triggered, no run: 15 minutes after updatedAt, with or without an old run id (a retry keeps it)', async () => {
    const w = await world()
    await w.put('cs_test_t1', record({ status: 'triggered', billing: '', activatedAt: '' }, 20 * MIN))
    await w.put('cs_test_t2', record({ status: 'triggered', billing: '', activatedAt: '', githubRunId: 5 }, 20 * MIN))
    await w.put('cs_test_t3', record({ status: 'triggered', billing: '', activatedAt: '' }, 5 * MIN))
    expect(named(await run(w), 'triggered, no run').map(r => r.sid).sort()).toEqual(['cs_test_t1', 'cs_test_t2'])
  })

  it('waiting for a person: ready with billing review, rejected, or siteNeverAnswered; they sit in no sweep and that is no mismatch', async () => {
    const w = await world()
    await w.put('cs_test_w1', record({ status: 'ready', billing: 'review', billingError: 'multiple_subscriptions', activatedAt: '' }))
    await w.put('cs_test_w2', record({ status: 'ready', billing: 'rejected', billingError: 'tries', activatedAt: '' }))
    await w.put('cs_test_w3', record({ status: 'ready', billing: '', siteNeverAnswered: true, activatedAt: '' }))
    const rows = await run(w)
    expect(named(rows, 'waiting for a person').map(r => r.sid).sort()).toEqual(['cs_test_w1', 'cs_test_w2', 'cs_test_w3'])
    expect(named(rows, 'index mismatch')).toEqual([])
  })

  it('built, not paid: ready with billing charging, pending or empty, or held, over 24 hours; held with heldUntilBad at any age', async () => {
    const w = await world()
    for (const [sid, billing] of [['cs_test_b1', 'charging'], ['cs_test_b2', 'pending'], ['cs_test_b3', '']] as const) {
      await w.put(sid, record({ status: 'ready', billing, activatedAt: '' }, 25 * HOUR))
      await w.sweep('sweep:billing', sid)
    }
    await w.put('cs_test_b4', record({ status: 'held', billing: 'held', activatedAt: '' }, 25 * HOUR))
    await w.sweep('sweep:held', 'cs_test_b4')
    await w.put('cs_test_b5', record({ status: 'held', billing: 'held', activatedAt: '', heldUntilBad: true }, 5 * MIN))
    await w.sweep('sweep:held', 'cs_test_b5')
    await w.put('cs_test_b6', record({ status: 'ready', billing: 'pending', activatedAt: '' }, 2 * HOUR))
    await w.sweep('sweep:billing', 'cs_test_b6')
    const rows = await run(w)
    expect(named(rows, 'built, not paid').map(r => r.sid).sort()).toEqual(['cs_test_b1', 'cs_test_b2', 'cs_test_b3', 'cs_test_b4', 'cs_test_b5'])
    expect(named(rows, 'index mismatch')).toEqual([])
  })

  it('paid, not activated: paid, no activatedAt, past activationDeadline, still ready', async () => {
    const w = await world()
    await w.put('cs_test_p1', record({ status: 'ready', billing: 'paid', activatedAt: '', activationDeadline: NOW - HOUR }, 26 * HOUR))
    await w.put('cs_test_p2', record({ status: 'ready', billing: 'paid', activatedAt: '', activationDeadline: NOW + HOUR }, 2 * HOUR))
    await w.sweep('sweep:billing', 'cs_test_p1')
    await w.sweep('sweep:billing', 'cs_test_p2')
    const rows = await run(w)
    expect(named(rows, 'paid, not activated').map(r => r.sid)).toEqual(['cs_test_p1'])
  })

  it('refund waiting: refunding or refunded, with the refund fields, and needs a person only with a refundProblem', async () => {
    const w = await world()
    await w.put('cs_test_f1', record({ status: 'refunding', billing: 'paid', activatedAt: '', refundCancelled: true, refundDone: false }))
    await w.put('cs_test_f2', record({ status: 'refunding', billing: 'paid', activatedAt: '', refundProblem: 'mismatch', refundCancelled: true, refundSettledAt: iso(NOW - HOUR) }))
    await w.put('cs_test_f3', record({ status: 'refunded', billing: 'paid', activatedAt: '', refundDone: true, refundCancelled: true }))
    await w.sweep('sweep:refund', 'cs_test_f1')
    await w.sweep('sweep:refund', 'cs_test_f3')
    const rows = named(await run(w), 'refund waiting')
    const by = Object.fromEntries(rows.map(r => [r.sid, r]))
    expect(Object.keys(by).sort()).toEqual(['cs_test_f1', 'cs_test_f2', 'cs_test_f3'])
    expect(by.cs_test_f1.needsPerson).toBe(false)
    expect(by.cs_test_f2.needsPerson).toBe(true)
    expect(by.cs_test_f2.detail).toMatchObject({ refundProblem: 'mismatch', refundCancelled: 'true' })
    expect(by.cs_test_f2.detail.refundSettledAt).toBeTruthy()
    expect(by.cs_test_f3.detail).toMatchObject({ refundDone: 'true' })
  })

  it('teardown unfinished: dispatched over an hour ago with no deleted or gone result, or a refused or failed result', async () => {
    const w = await world()
    await w.put('cs_test_d1', record({ status: 'tearing_down', billing: 'declined', activatedAt: '', teardownDispatchedAt: iso(NOW - 2 * HOUR) }))
    await w.put('cs_test_d2', record({ status: 'tearing_down', billing: 'declined', activatedAt: '', teardownDispatchedAt: iso(NOW - 2 * HOUR), teardownApp: 'refused' }))
    await w.put('cs_test_d3', record({ status: 'torn_down', billing: 'declined', activatedAt: '', teardownDispatchedAt: iso(NOW - 2 * HOUR), teardownApp: 'failed', tornDown: true }))
    await w.put('cs_test_d4', record({ status: 'torn_down', billing: 'declined', activatedAt: '', teardownDispatchedAt: iso(NOW - 2 * HOUR), teardownApp: 'gone', tornDown: true }))
    await w.put('cs_test_d5', record({ status: 'tearing_down', billing: 'declined', activatedAt: '', teardownDispatchedAt: iso(NOW - 10 * MIN) }))
    for (const sid of ['cs_test_d1', 'cs_test_d2', 'cs_test_d5']) await w.sweep('sweep:teardown', sid)
    expect(named(await run(w), 'teardown unfinished').map(r => r.sid).sort()).toEqual(['cs_test_d1', 'cs_test_d2', 'cs_test_d3'])
  })
})

describe('reconcile-signups: index mismatch', () => {
  it('a ready record with billing pending and no sweep:billing member prints one', async () => {
    const w = await world()
    await w.put('cs_test_m1', record({ status: 'ready', billing: 'pending', activatedAt: '' }, 10 * MIN))
    const rows = named(await run(w), 'index mismatch')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sid: 'cs_test_m1', detail: { sweep: 'sweep:billing', problem: 'record not in the sweep' } })
  })

  it('a held record outside sweep:held, and a refunding or refunded one without refundSettledAt outside sweep:refund, print one each', async () => {
    const w = await world()
    await w.put('cs_test_m2', record({ status: 'held', billing: 'held', activatedAt: '' }, 10 * MIN))
    await w.put('cs_test_m3', record({ status: 'refunding', billing: 'paid', activatedAt: '' }, 10 * MIN))
    await w.put('cs_test_m4', record({ status: 'refunded', billing: 'paid', activatedAt: '', refundDone: true }, 10 * MIN))
    const by = Object.fromEntries(named(await run(w), 'index mismatch').map(r => [r.sid, r.detail.sweep]))
    expect(by).toEqual({ cs_test_m2: 'sweep:held', cs_test_m3: 'sweep:refund', cs_test_m4: 'sweep:refund' })
  })

  it('a refund problem that is settled (refundSettledAt) is out of sweep:refund by design: no mismatch', async () => {
    const w = await world()
    await w.put('cs_test_m5', record({ status: 'refunding', billing: 'paid', activatedAt: '', refundProblem: 'partial', refundCancelled: true, refundSettledAt: iso(NOW - HOUR) }, 10 * MIN))
    expect(named(await run(w), 'index mismatch')).toEqual([])
  })

  it('a sweep member with no record prints one, for every sweep', async () => {
    const w = await world()
    for (const s of ['sweep:billing', 'sweep:held', 'sweep:refund', 'sweep:stops', 'sweep:teardown']) await w.sweep(s, `cs_test_orphan_${s.slice(6)}`)
    const rows = named(await run(w), 'index mismatch')
    expect(rows.map(r => r.detail.sweep).sort()).toEqual(['sweep:billing', 'sweep:held', 'sweep:refund', 'sweep:stops', 'sweep:teardown'])
    expect(rows.every(r => r.detail.problem === 'member with no record')).toBe(true)
  })

  it('a record that is in its sweep prints no mismatch', async () => {
    const w = await world()
    await w.put('cs_test_ok1', record({ status: 'ready', billing: 'pending', activatedAt: '' }, 10 * MIN))
    await w.sweep('sweep:billing', 'cs_test_ok1')
    await w.put('cs_test_ok2', record({ status: 'held', billing: 'held', activatedAt: '' }, 10 * MIN))
    await w.sweep('sweep:held', 'cs_test_ok2')
    await w.put('cs_test_ok3', record({ status: 'refunding', billing: 'paid', activatedAt: '' }, 10 * MIN))
    await w.sweep('sweep:refund', 'cs_test_ok3')
    expect(named(await run(w), 'index mismatch')).toEqual([])
  })
})

describe('reconcile-signups: B-2 date and subscriptions without a record', () => {
  const at = (days: number) => Math.floor((NOW + days * DAY) / 1000)
  const sub = (id: string, endDays: number | null, over: Partial<Sub> = {}): Sub => ({
    id, status: 'active', metadata: { provision_id: `prov_${id}` }, discounts: endDays === null ? [] : [{ end: at(endDays) }], ...over
  })

  it('gives the earliest end of a discount with no record and no session in the window, and warns when it is 14 days away or less', async () => {
    const w = await world()
    w.s = guardedStripe({ subs: [sub('sub_far', 60), sub('sub_near', 9)] })
    const rows = named(await run(w), 'B-2 date')
    expect(rows).toHaveLength(1)
    expect(rows[0].detail).toMatchObject({ date: iso(at(9) * 1000).slice(0, 10), subscriptionId: 'sub_near', daysAway: 9, warning: true })
  })

  it('gives the date without a warning when it is more than 14 days away', async () => {
    const w = await world()
    w.s = guardedStripe({ subs: [sub('sub_far', 40)] })
    const rows = named(await run(w), 'B-2 date')
    expect(rows).toHaveLength(1)
    expect(rows[0].detail).toMatchObject({ daysAway: 40, warning: false })
  })

  it('follows the pages and reads the trialing list too', async () => {
    const w = await world()
    w.s = guardedStripe({ subs: [sub('sub_1', 50), sub('sub_2', 45), sub('sub_3', 30), sub('sub_4', 6, { status: 'trialing' })] })
    const rows = named(await run(w), 'B-2 date')
    expect(rows[0].detail).toMatchObject({ subscriptionId: 'sub_4', daysAway: 6, warning: true })
    const lists = w.s.listed.filter(l => l.what === 'subscriptions')
    expect(lists.some(l => l.params.starting_after)).toBe(true)
    expect(lists.map(l => l.params.status)).toEqual(expect.arrayContaining(['active', 'trialing']))
  })

  it('ignores a subscription with no provision id and a discount with no end', async () => {
    const w = await world()
    w.s = guardedStripe({ subs: [sub('sub_a', 5, { metadata: {} }), sub('sub_b', null), sub('sub_c', 0, { discounts: [{ end: null }, 'di_unexpanded'] })] })
    expect(named(await run(w), 'B-2 date')).toEqual([])
  })

  it('prints a subscription whose record is torn_down, refunded or declined, and nothing for a complete one or one with no record', async () => {
    const w = await world()
    w.s = guardedStripe({ subs: [sub('sub_s1', null), sub('sub_s2', null), sub('sub_s3', null), sub('sub_s4', null), sub('sub_s5', null)] })
    const statuses: Record<string, string> = { sub_s1: 'torn_down', sub_s2: 'refunded', sub_s3: 'declined', sub_s4: 'complete' }
    for (const [id, status] of Object.entries(statuses)) {
      await w.put(`cs_test_${id}`, record({ status, provisionId: `prov_${id}`, billing: status === 'complete' ? 'paid' : 'declined', teardownApp: 'deleted', tornDown: true }))
    }
    const rows = named(await run(w), 'subscription without a record')
    expect(rows.map(r => r.detail.subscriptionId).sort()).toEqual(['sub_s1', 'sub_s2', 'sub_s3'])
    expect(rows.map(r => r.status).sort()).toEqual(['declined', 'refunded', 'torn_down'])
  })
})

describe('reconcile-signups: what it reads', () => {
  it('reads only record keys: by-id, lifecycle, lock, stop and failed keys are skipped, and a string key is not a record', async () => {
    const w = await world()
    await w.put('cs_test_real', record({ status: 'triggered', billing: '', activatedAt: '' }, 20 * MIN))
    await w.g.inner.set('provision:by-id:prov_cccccccccccc', 'cs_test_real')
    await w.g.inner.set('provision:cs_test_real:lifecycle', 'token')
    await w.g.inner.set('provision:cs_test_real:lock', 'locked')
    await w.g.inner.set('provision:cs_test_real:stop', 'x')
    await w.g.inner.set('provision:cs_test_real:failed:1', 'x')
    await w.g.inner.set('provision:cs_test_plain', 'not a hash')
    const rows = await run(w)
    expect(rows.map(r => r.sid)).toEqual(['cs_test_real'])
  })

  it('prints no address and no sign-up field in text or JSON, even when the record, the session and the metadata hold one', async () => {
    const w = await world()
    await w.put('cs_test_mail', record({
      status: 'triggered', billing: '', activatedAt: '',
      email: 'person@example.invalid', 'signup:email': 'person@example.invalid', communityName: 'Someone at person@example.invalid',
      billingError: 'person@example.invalid', teardownApp: 'person@example.invalid'
    }, 20 * MIN))
    await w.put('cs_test_mail2', record({ status: 'refunding', billing: 'paid', activatedAt: '', refundProblem: 'person@example.invalid', subdomain: 'ok-site' }, 20 * MIN))
    await w.flag('stripe_unclear:cs_test_mail')
    w.s = guardedStripe({
      sessions: [{ id: 'cs_test_nomail', created: Math.floor((NOW - HOUR) / 1000), status: 'complete', customer_email: 'person@example.invalid', metadata: { email: 'person@example.invalid', provision_id: 'prov_dddddddddddd' } }]
    })
    const rows = await run(w)
    expect(rows.length).toBeGreaterThan(2)
    expect(JSON.stringify(rows)).not.toMatch(/@|example\.invalid|person/)
    for (const asJson of [false, true]) {
      const lines: string[] = []
      w.g.snapshot()
      const code = await script.main(asJson ? ['--json'] : [], { NUXT_STRIPE_SECRET_KEY: 'sk_test_x', NUXT_UPSTASH_REDIS_URL: 'https://x', NUXT_UPSTASH_REDIS_TOKEN: 't' }, { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) }, async () => ({ redis: w.g.redis, stripe: w.s.stripe, lifecycle, now: () => NOW }))
      expect(code).toBe(0)
      expect(lines.join('\n')).not.toMatch(/@|example\.invalid|person|sk_test_x/)
      expect(w.g.attempted).toEqual([])
    }
  })

  it('the guard itself works: a write on the guarded fakes throws and is recorded', async () => {
    const g = guardedRedis()
    const s = guardedStripe()
    for (const name of ['hset', 'zadd', 'zrem', 'hdel', 'del', 'set', 'eval']) expect(() => (g.redis as any)[name]('k')).toThrow(/not a read command/)
    expect(g.attempted).toEqual(['hset', 'zadd', 'zrem', 'hdel', 'del', 'set', 'eval'])
    for (const call of [() => s.stripe.checkout.sessions.create({}), () => s.stripe.subscriptions.cancel('sub_1'), () => s.stripe.refunds.create({}), () => s.stripe.subscriptions.update('sub_1', {})]) {
      expect(call).toThrow(/not a read call/)
    }
    expect(s.attempted).toHaveLength(4)
  })
})

describe('reconcile-signups: the command line', () => {
  const ENV = { NUXT_STRIPE_SECRET_KEY: 'sk_test_x', NUXT_UPSTASH_REDIS_URL: 'https://x.invalid', NUXT_UPSTASH_REDIS_TOKEN: 'tok' }
  const sink = () => {
    const out: string[] = []
    const err: string[] = []
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }
  }

  it('exits 2 for unknown arguments or a bad --hours, naming no value', async () => {
    for (const argv of [['--bogus'], ['--hours', 'abc'], ['--hours', '0'], ['positional']]) {
      const s = sink()
      expect(await script.main(argv, ENV, s.io, async () => { throw new Error('must not build deps') })).toBe(2)
      expect(s.err.join('\n')).toMatch(/Usage/)
    }
  })

  it('exits 2 and names the missing variables, never a value, when the environment is incomplete', async () => {
    const s = sink()
    const code = await script.main([], { NUXT_STRIPE_SECRET_KEY: 'sk_test_secretvalue' }, s.io, async () => { throw new Error('must not build deps') })
    expect(code).toBe(2)
    const text = s.err.join('\n')
    expect(text).toMatch(/UPSTASH/)
    expect(text).not.toMatch(/sk_test_secretvalue/)
  })

  it('reads each variable from its NUXT_ name first, then the unprefixed name', () => {
    expect(script.readEnv({ NUXT_STRIPE_SECRET_KEY: 'a', STRIPE_SECRET_KEY: 'b', UPSTASH_REDIS_REST_URL: 'u', UPSTASH_REDIS_REST_TOKEN: 't' })).toEqual({ stripeKey: 'a', redisUrl: 'u', redisToken: 't' })
    expect(script.readEnv({ STRIPE_SECRET_KEY: 'b', NUXT_UPSTASH_REDIS_URL: 'n', UPSTASH_REDIS_REST_URL: 'u', NUXT_UPSTASH_REDIS_TOKEN: 'nt' })).toEqual({ stripeKey: 'b', redisUrl: 'n', redisToken: 'nt' })
    expect(script.readEnv({})).toEqual({ stripeKey: undefined, redisUrl: undefined, redisToken: undefined })
  })

  it('exits 1 when Stripe fails, with a fixed line and no response body', async () => {
    const s = sink()
    const g = guardedRedis()
    const stripe = { checkout: { sessions: { list: async () => { throw new Error('boom person@example.invalid sk_test_leak') } } }, subscriptions: { list: async () => ({ data: [], has_more: false }) } }
    const code = await script.main([], ENV, s.io, async () => ({ redis: g.redis, stripe, lifecycle, now: () => NOW }))
    expect(code).toBe(1)
    expect(s.err.join('\n')).not.toMatch(/person|sk_test_leak/)
  })

  it('prints a plain nothing-to-report line when all is healthy, and JSON that parses', async () => {
    const w = await world()
    await w.put('cs_test_fine', record())
    const text = sink()
    expect(await script.main([], ENV, text.io, async () => ({ redis: w.g.redis, stripe: w.s.stripe, lifecycle, now: () => NOW }))).toBe(0)
    expect(text.out.join('\n')).toMatch(/Nothing to report/)
    const json = sink()
    expect(await script.main(['--json', '--hours', '48'], ENV, json.io, async () => ({ redis: w.g.redis, stripe: w.s.stripe, lifecycle, now: () => NOW }))).toBe(0)
    const parsed = JSON.parse(json.out.join('\n'))
    expect(parsed).toMatchObject({ hours: 48, rows: [] })
  })

  it('prints one line per row with the row name, ids, states and ages', async () => {
    const w = await world()
    await w.put('cs_test_line', record({ status: 'triggered', billing: '', activatedAt: '', subdomain: 'line-site' }, 20 * MIN))
    const s = sink()
    expect(await script.main([], ENV, s.io, async () => ({ redis: w.g.redis, stripe: w.s.stripe, lifecycle, now: () => NOW }))).toBe(0)
    const line = s.out.find(l => l.startsWith('triggered, no run'))!
    expect(line).toContain('cs_test_line')
    expect(line).toContain('line-site')
    expect(line).toContain('triggered')
    expect(line).toMatch(/20m/)
  })

  it('loads FLAG_KINDS, the status list and billingWaits from lifecycle.ts through jiti (offline, no deps built)', async () => {
    const loaded = await script.loadLifecycle()
    expect([...loaded.FLAG_KINDS]).toEqual([...FLAG_KINDS])
    expect(loaded.FLAG_KINDS).toHaveLength(11)
    expect([...loaded.LIFECYCLE_STATES]).toEqual([...LIFECYCLE_STATES])
    expect(loaded.billingWaits({ billing: 'review' })).toBe(true)
    expect(loaded.billingWaits({ billing: 'pending' })).toBe(false)
  })
})

describe('reconcile-signups: the free pilot\'s end (pilot-end.ts)', () => {
  const at = (days: number) => Math.floor((NOW + days * DAY) / 1000)
  const pilot = (id: string, over: Partial<Sub> = {}): Sub => ({
    id,
    status: 'active',
    metadata: { provision_id: `prov_${id}`, pilot: 'ends', pilot_ends_at: String(at(30)) },
    cancel_at: at(30),
    discounts: [{ end: null, coupon: { percent_off: 100 } }],
    ...over
  })

  it('a pilot whose cancel_at matches its frozen end gives no row', async () => {
    const w = await world()
    w.s = guardedStripe({ subs: [pilot('sub_ok')] })
    expect(named(await run(w), 'pilot without end')).toEqual([])
  })

  it('flags a pilot with no cancel_at, a cancel_at that moved, or a 100% discount with no pilot mark, for a person', async () => {
    const w = await world()
    w.s = guardedStripe({ subs: [
      pilot('sub_noend', { cancel_at: null }),
      pilot('sub_moved', { cancel_at: at(31) }),
      pilot('sub_nomark', { metadata: { provision_id: 'prov_nomark' }, cancel_at: null }),
      pilot('sub_kept', { metadata: { provision_id: 'prov_kept', pilot: 'continued' }, cancel_at: null })
    ] })
    const rows = named(await run(w), 'pilot without end')
    expect(rows.map(r => r.detail.subscriptionId).sort()).toEqual(['sub_moved', 'sub_noend', 'sub_nomark'])
    expect(rows.every(r => r.needsPerson === true)).toBe(true)
  })

  it('a paying subscription with a part discount and no pilot mark gives no pilot row', async () => {
    const w = await world()
    w.s = guardedStripe({ subs: [pilot('sub_paid', { metadata: { provision_id: 'prov_paid' }, cancel_at: null, discounts: [{ end: at(40), coupon: { percent_off: 50 } }] })] })
    expect(named(await run(w), 'pilot without end')).toEqual([])
  })

  it('flags a pilot whose end notice is overdue (under 12 days left, no notice mark), for a person', async () => {
    const w = await world()
    w.s = guardedStripe({ subs: [
      pilot('sub_overdue', { cancel_at: at(10), metadata: { provision_id: 'prov_overdue', pilot: 'ends', pilot_ends_at: String(at(10)) } }),
      pilot('sub_noticed', { cancel_at: at(10), metadata: { provision_id: 'prov_noticed', pilot: 'ends', pilot_ends_at: String(at(10)), pilot_notice_sent: String(at(-3)) } }),
      pilot('sub_early', { cancel_at: at(13), metadata: { provision_id: 'prov_early', pilot: 'ends', pilot_ends_at: String(at(13)) } }),
      pilot('sub_kept', { cancel_at: null, metadata: { provision_id: 'prov_kept', pilot: 'continued' } })
    ] })
    const rows = named(await run(w), 'pilot notice not sent')
    expect(rows.map(r => r.detail.subscriptionId)).toEqual(['sub_overdue'])
    expect(rows[0]!.needsPerson).toBe(true)
    expect(rows[0]!.detail.endsAt).toBe(iso(at(10) * 1000).slice(0, 10))
  })

  it('lists a pilot that ended, so a person decides on the site; one ended long ago is listed without the attention mark', async () => {
    const w = await world()
    w.s = guardedStripe({ subs: [
      pilot('sub_ended', { status: 'canceled', ended_at: at(-3) }),
      pilot('sub_old', { status: 'canceled', ended_at: at(-200) }),
      pilot('sub_kept_then_cancelled', { status: 'canceled', ended_at: at(-3), metadata: { provision_id: 'prov_x', pilot: 'continued' } })
    ] })
    const rows = named(await run(w), 'pilot ended')
    expect(rows.map(r => r.detail.subscriptionId).sort()).toEqual(['sub_ended', 'sub_old'])
    expect(rows.find(r => r.detail.subscriptionId === 'sub_ended')!.needsPerson).toBe(true)
    expect(rows.find(r => r.detail.subscriptionId === 'sub_old')!.needsPerson).toBe(false)
    expect(rows.find(r => r.detail.subscriptionId === 'sub_ended')!.detail.endedAt).toBe(iso(at(-3) * 1000).slice(0, 10))
    expect(w.s.listed.filter(l => l.what === 'subscriptions').map(l => l.params.status)).toContain('canceled')
  })

  it('prints the notice and removal dates of a lapsed pilot (30 days, notice 7 days before) and marks removal due only from day 30', async () => {
    const w = await world()
    w.s = guardedStripe({ subs: [
      pilot('sub_recent', { status: 'canceled', ended_at: at(-29) }),
      pilot('sub_due', { status: 'canceled', ended_at: at(-31) }),
      pilot('sub_unknown', { status: 'canceled', ended_at: null })
    ] })
    const rows = named(await run(w), 'pilot ended')
    const by = (id: string) => rows.find(r => r.detail.subscriptionId === id)!.detail
    expect(by('sub_recent').noticeFrom).toBe(iso((at(-29) + 23 * 86400) * 1000).slice(0, 10))
    expect(by('sub_recent').removeFrom).toBe(iso((at(-29) + 30 * 86400) * 1000).slice(0, 10))
    expect(by('sub_recent').removalDue).toBe(false)
    expect(by('sub_due').removalDue).toBe(true)
    expect(by('sub_due').removeFrom).toBe(iso((at(-31) + 30 * 86400) * 1000).slice(0, 10))
    expect(by('sub_unknown')).toMatchObject({ endedAt: 'unknown', noticeFrom: 'unknown', removeFrom: 'unknown', removalDue: false })
  })

  it('a pilot paid after its end is kept, never due for removal; an open payment page is named', async () => {
    const w = await world()
    w.s = guardedStripe({ subs: [
      pilot('sub_paid_late', { status: 'canceled', ended_at: at(-31) }),
      pilot('sub_page_open', { status: 'canceled', ended_at: at(-31) }),
      pilot('sub_marked', { status: 'canceled', ended_at: at(-31) })
    ] })
    await w.g.inner.set('pilot:late:sub_paid_late', JSON.stringify({ state: 'continued', at: NOW }))
    await w.g.inner.set('pilot:late:sub_page_open', JSON.stringify({ state: 'open', at: NOW }))
    await w.g.inner.set('pilot:late:sub_marked', JSON.stringify({ state: 'removing', at: NOW }))
    const rows = named(await run(w), 'pilot ended')
    const by = (id: string) => rows.find(r => r.detail.subscriptionId === id)!.detail
    expect(by('sub_paid_late')).toMatchObject({ removalDue: false, removeFrom: 'kept (paid after the end)', lateYes: 'kept' })
    expect(by('sub_page_open')).toMatchObject({ removalDue: true, lateYes: 'payment page open' })
    expect(by('sub_marked')).toMatchObject({ removalDue: true, lateYes: 'removal marked' })
  })
})

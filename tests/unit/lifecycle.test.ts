import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  DISPATCH_TIMEOUT_MS,
  KEEP_SECONDS,
  REFUND_PENDING_LIMIT_MS,
  TRANSITIONS,
  DeadlineError,
  LEASE_MARGIN_MS,
  LIFECYCLE_LOCK_MS,
  LIFECYCLE_RENEW_MS,
  MAIL_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  STRIPE_TIMEOUT_MS,
  CLEAR_INDEX_SCRIPT,
  COUNT_FAILURE_SCRIPT,
  LeaseLostError,
  RELEASE_SCRIPT,
  TRANSITION_SCRIPT,
  applyResult,
  clearIndex,
  countFailureAtomic,
  foreignIntent,
  lifecycleLockKey,
  stripeCall,
  transition,
  withDeadline,
  withLifecycleLock,
  writeIntent,
  type Lease,
  type LockDeps
} from '../../server/utils/lifecycle'
import Stripe from 'stripe'
import {
  ACTIVATE_TIMEOUT_MS,
  activateSite,
  chargeAtReady,
  onFirstInvoicePaid,
  resumeBilling,
  routeInvoiceEvent,
  sweepBilling,
  type BillingDeps
} from '../../server/utils/billing'
import { recordDispatchFailure, recordFailure, settleProvisional, stopProvision, type RetryStopDeps } from '../../server/utils/retry-stop'
import { callbackToken, handleProvisionCallback } from '../../server/utils/provision-handlers'
import { CALLBACK_STATUSES } from '../../shared/provisioning'
import { FakeRedis } from './helpers/fake-redis'

/**
 * The sign-up lifecycle (Phase 23, plan 23-43, Task 1): one lock per sign-up
 * with a local deadline, one total deadline per remote call, operation ids,
 * and validate-then-write transitions. Fakes only: FakeRedis, mocked fetch, a
 * Stripe stand-in. No network.
 */

const SECRET = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
const PID = 'L1fEcYcLe0000000000000'

function billingDeps(fetch: BillingDeps['fetch']): BillingDeps {
  return {
    redis: new FakeRedis() as unknown as BillingDeps['redis'],
    stripe: () => { throw new Error('no stripe in this test') },
    fetch,
    callbackSecret: SECRET,
    log: () => {}
  }
}

/** A fetch that answers only when its signal aborts, as a real fetch does on a connect that never completes. */
function hangingFetch(seen: { signal?: AbortSignal }) {
  return vi.fn((_url: string, init: { signal: AbortSignal }) => {
    seen.signal = init.signal
    return new Promise<never>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')))
    })
  })
}

describe('H1: one total deadline per remote call (connect plus body read)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the D1 relation: LEASE_MARGIN_MS is larger than every remote call timeout, and the lease minus one renew period is larger than the margin', () => {
    for (const timeout of [STRIPE_TIMEOUT_MS, ACTIVATE_TIMEOUT_MS, PROBE_TIMEOUT_MS, DISPATCH_TIMEOUT_MS, MAIL_TIMEOUT_MS]) {
      expect(LEASE_MARGIN_MS).toBeGreaterThan(timeout)
    }
    expect(LIFECYCLE_LOCK_MS - LIFECYCLE_RENEW_MS).toBeGreaterThan(LEASE_MARGIN_MS)
    expect([LIFECYCLE_LOCK_MS, LIFECYCLE_RENEW_MS, LEASE_MARGIN_MS]).toEqual([60000, 15000, 20000])
    expect([STRIPE_TIMEOUT_MS, PROBE_TIMEOUT_MS, DISPATCH_TIMEOUT_MS, MAIL_TIMEOUT_MS, ACTIVATE_TIMEOUT_MS]).toEqual([15000, 10000, 15000, 15000, 15000])
  })

  it('withDeadline aborts the signal and rejects with DeadlineError at exactly its deadline, for a call that never connects', async () => {
    const seen: { signal?: AbortSignal } = {}
    let settled: unknown = 'pending'
    const call = withDeadline(15000, signal => hangingFetch(seen)('https://x.test', { signal }))
    call.then(v => { settled = v }, e => { settled = e })
    await vi.advanceTimersByTimeAsync(14999)
    expect(settled).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBeInstanceOf(DeadlineError)
    expect(seen.signal?.aborted).toBe(true)
  })

  it('withDeadline also bounds work that ignores the signal (a body that trickles in): it rejects at the deadline', async () => {
    let settled: unknown = 'pending'
    const call = withDeadline(10000, async () => {
      await new Promise(() => {})
    })
    call.then(v => { settled = v }, e => { settled = e })
    await vi.advanceTimersByTimeAsync(10000)
    expect(settled).toBeInstanceOf(DeadlineError)
  })

  it('withDeadline clears its timer when the work finishes first', async () => {
    const out = await withDeadline(15000, async () => 'done')
    expect(out).toBe('done')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stripeCall passes timeout STRIPE_TIMEOUT_MS and maxNetworkRetries 0 and races the SDK call: a Stripe call that never answers rejects at 15 s', async () => {
    const seenOpts: unknown[] = []
    let settled: unknown = 'pending'
    const call = stripeCall(opts => {
      seenOpts.push(opts)
      return new Promise<never>(() => {})
    })
    call.then(v => { settled = v }, e => { settled = e })
    expect(seenOpts).toEqual([{ timeout: STRIPE_TIMEOUT_MS, maxNetworkRetries: 0 }])
    await vi.advanceTimersByTimeAsync(STRIPE_TIMEOUT_MS - 1)
    expect(settled).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBeInstanceOf(DeadlineError)
  })

  it('activateSite on a slow connect: the abort fires at ACTIVATE_TIMEOUT_MS and the try is a retry', async () => {
    const seen: { signal?: AbortSignal } = {}
    const deps = billingDeps(hangingFetch(seen) as unknown as BillingDeps['fetch'])
    let settled: unknown = 'pending'
    activateSite({ subdomain: 'cascadia', provisionId: PID }, deps).then(v => { settled = v })
    await vi.advanceTimersByTimeAsync(ACTIVATE_TIMEOUT_MS - 1)
    expect(settled).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe('retry')
    expect(seen.signal?.aborted).toBe(true)
  })

  it('activateSite with a body that trickles in: headers at 1 s, the body never ends; the whole call ends at ACTIVATE_TIMEOUT_MS as a retry, not later', async () => {
    let signal: AbortSignal | undefined
    const fetch = vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
      signal = init.signal
      await new Promise(resolve => setTimeout(resolve, 1000))
      return { status: 200, json: () => new Promise<unknown>(() => {}) }
    })
    const deps = billingDeps(fetch as unknown as BillingDeps['fetch'])
    let settled: unknown = 'pending'
    activateSite({ subdomain: 'cascadia', provisionId: PID }, deps).then(v => { settled = v })
    await vi.advanceTimersByTimeAsync(ACTIVATE_TIMEOUT_MS - 1)
    expect(settled).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe('retry')
    expect(signal?.aborted).toBe(true)
  })
})

describe('replay guard: an operation id stored on the record makes a replayed transition a no-op (review round 2 MEDIUM)', () => {
  const SID = 'cs_test_lifecycle'
  const record = `provision:${SID}`

  async function seedReady(redis: FakeRedis) {
    await redis.set(`provision:by-id:${PID}`, SID, { ex: 86400 })
    await redis.hset(record, { status: 'ready', provisionId: PID, attempt: 1, billing: 'charging' })
    await redis.expire(record, 86400)
  }

  it('the same op id run twice counts billingTries once; the second run answers replayed and writes nothing', async () => {
    const redis = new FakeRedis()
    await seedReady(redis)
    const first = await transition(redis, SID, 'pending', { provisionId: PID, opId: 'op-1', now: 1000 })
    expect(first.result).toBe('applied')
    const before = redis.dump()
    const second = await transition(redis, SID, 'pending', { provisionId: PID, opId: 'op-1', now: 2000 })
    expect(second.result).toBe('replayed')
    expect(redis.dump()).toBe(before)
    expect((await redis.hgetall(record))!.billingTries).toBe(1)
  })

  it('a lost EVAL reply on pending (applied, then the reply is lost): the caller re-runs with the same op id and billingTries is 1', async () => {
    const redis = new FakeRedis()
    await seedReady(redis)
    redis.loseReplies(TRANSITION_SCRIPT, 1)
    const out = await transition(redis, SID, 'pending', { provisionId: PID, now: 1000 })
    expect(out.result).toBe('replayed')
    expect((await redis.hgetall(record))!.billingTries).toBe(1)
  })

  it('a different op id is a new step: billingTries counts twice', async () => {
    const redis = new FakeRedis()
    await seedReady(redis)
    await transition(redis, SID, 'pending', { provisionId: PID, opId: 'op-1', now: 1000 })
    await transition(redis, SID, 'pending', { provisionId: PID, opId: 'op-2', now: 2000 })
    expect((await redis.hgetall(record))!.billingTries).toBe(2)
  })
})

// --- the lease ------------------------------------------------------------------------

/**
 * A manual clock for the lease: `tick` (monotonic ms), the renew interval
 * fired only by advance(), and FakeRedis's own clock moved in step, so a key
 * not renewed expires in the fake as in Redis.
 */
function leaseEnv(redis: FakeRedis) {
  let t = 1000
  let seq = 0
  const intervals = new Map<number, { fn: () => void, ms: number, next: number }>()
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  const deps: LockDeps = {
    redis,
    tick: () => t,
    timers: {
      setInterval: (fn: () => void, ms: number) => {
        seq++
        intervals.set(seq, { fn, ms, next: t + ms })
        return seq
      },
      clearInterval: (h: unknown) => {
        intervals.delete(h as number)
      }
    },
    log: () => {}
  }
  return {
    deps,
    intervals,
    flush,
    /** Move time forward; renew timers fire at their due times unless `blocked` (an event loop that never yields). */
    async advance(ms: number, opts: { blocked?: boolean } = {}) {
      const end = t + ms
      while (!opts.blocked) {
        const due = [...intervals.values()].filter(iv => iv.next <= end).sort((a, b) => a.next - b.next)[0]
        if (!due) break
        redis.advance((due.next - t) / 1000)
        t = due.next
        due.next += due.ms
        due.fn()
        await flush()
      }
      redis.advance((end - t) / 1000)
      t = end
      await flush()
    }
  }
}

describe('withLifecycleLock: one lease per sign-up, renewed while held, released by compare-and-delete', () => {
  const SID = 'cs_test_lease'
  const key = lifecycleLockKey(SID)
  let redis: FakeRedis

  beforeEach(() => {
    redis = new FakeRedis()
  })

  it('the key is provision:{sid}:lifecycle, SET NX PX 60000 with a random token; a second taker gets busy and its work is never called', async () => {
    expect(key).toBe(`provision:${SID}:lifecycle`)
    const env = leaseEnv(redis)
    const second = vi.fn()
    let pttl = 0
    const out = await withLifecycleLock(SID, env.deps, async (lease) => {
      pttl = await redis.pttl(key)
      expect(await redis.get(key)).toBe(lease.token)
      expect(lease.token).toMatch(/^[0-9a-f-]{36}$/)
      return withLifecycleLock(SID, env.deps, second)
    })
    expect(out).toBe('busy')
    expect(second).not.toHaveBeenCalled()
    expect(pttl).toBe(60000)
    expect(await redis.exists(key)).toBe(0)
  })

  it('a 150 s charge keeps its lease: renewed every 15 s, the same token the whole time', async () => {
    const env = leaseEnv(redis)
    const seen: unknown[] = []
    const out = await withLifecycleLock(SID, env.deps, async (lease) => {
      for (let i = 0; i < 10; i++) {
        await env.advance(15000)
        seen.push(await redis.get(key))
        lease.assertHeld()
      }
      return 'done'
    })
    expect(out).toBe('done')
    expect(new Set(seen).size).toBe(1)
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('a renewal moves the deadline only when it answers 1: the deadline is the send time of the last good renewal plus 60 s', async () => {
    const env = leaseEnv(redis)
    await withLifecycleLock(SID, env.deps, async (lease) => {
      expect(lease.deadline).toBe(1000 + 60000)
      await env.advance(15000)
      expect(lease.deadline).toBe(16000 + 60000)
      await redis.set(key, 'someone-else', {})
      await env.advance(15000)
      expect(lease.lost).toBe(true)
      expect(lease.deadline).toBe(16000 + 60000)
      return 'x'
    })
  })

  it('renewals are serialized: a renewal still in flight makes the next tick skip, not send a second', async () => {
    const env = leaseEnv(redis)
    let renews = 0
    let release: () => void = () => {}
    const orig = redis.eval.bind(redis)
    redis.eval = (async (script: string, keys: string[], args: unknown[]) => {
      if (keys[0] === key && script !== RELEASE_SCRIPT) {
        renews++
        await new Promise<void>((resolve) => { release = resolve })
      }
      return orig(script, keys, args)
    }) as typeof redis.eval
    const done = withLifecycleLock(SID, env.deps, async () => {
      await env.advance(15000)
      await env.advance(15000)
      await env.advance(15000)
      return 'x'
    })
    await env.flush()
    await new Promise(r => setTimeout(r, 0))
    expect(renews).toBe(1)
    release()
    await done
  })

  it('release never deletes another runner\'s lock: the key expired and was taken between the read and the delete', async () => {
    const env = leaseEnv(redis)
    let releasing = false
    const takeOver = async () => {
      await redis.del(key)
      await redis.set(key, 'next-runner', { px: 60000 })
    }
    // A release made of a read then a delete would see the key change between the two;
    // the compare-and-delete script sees it changed before it runs. Either way the next runner's lock must stay.
    const get = redis.get.bind(redis)
    redis.get = (async (k: string) => {
      const v = await get(k)
      if (releasing && k === key) await takeOver()
      return v
    }) as typeof redis.get
    const evalOrig = redis.eval.bind(redis)
    redis.eval = (async (script: string, keys: string[], args: unknown[]) => {
      if (releasing && script === RELEASE_SCRIPT) await takeOver()
      return evalOrig(script, keys, args)
    }) as typeof redis.eval
    await withLifecycleLock(SID, env.deps, async () => {
      releasing = true
      return 'x'
    })
    expect(await redis.get(key)).toBe('next-runner')
  })

  it('a blocked event loop makes no remote call: fake time jumps 70 s with no renewal, and beforeRemote throws LeaseLostError before Stripe is called', async () => {
    const env = leaseEnv(redis)
    const stripeCreate = vi.fn()
    const out = await withLifecycleLock(SID, env.deps, async (lease) => {
      await env.advance(70000, { blocked: true })
      await lease.stripe('subscribe', async () => stripeCreate())
      return 'charged'
    })
    expect(out).toBe('lost')
    expect(stripeCreate).not.toHaveBeenCalled()
  })

  it('beforeRemote throws when fewer than LEASE_MARGIN_MS remain, even with no renewal missed yet (41 s into a 60 s lease)', async () => {
    const env = leaseEnv(redis)
    await withLifecycleLock(SID, env.deps, async (lease) => {
      await env.advance(40000, { blocked: true })
      expect(() => lease.beforeRemote('pay')).not.toThrow()
      await env.advance(1, { blocked: true })
      expect(() => lease.beforeRemote('pay')).toThrow(LeaseLostError)
      return 'x'
    })
  })

  it('the lease clock is monotonic (performance.now), not the wall clock: Date.now jumping back an hour gives the lease no more time', async () => {
    let perf = 5000
    const perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => perf)
    const dateSpy = vi.spyOn(Date, 'now')
    try {
      await withLifecycleLock(SID, { redis, log: () => {}, timers: { setInterval: () => 0, clearInterval: () => {} } }, async (lease) => {
        dateSpy.mockReturnValue(Date.UTC(2026, 0, 1))
        perf += 41000
        expect(() => lease.beforeRemote('pay')).toThrow(LeaseLostError)
        return 'x'
      })
    } finally {
      perfSpy.mockRestore()
      dateSpy.mockRestore()
    }
  })

  it('lease.remote runs one call under its own total deadline after the margin check', async () => {
    const env = leaseEnv(redis)
    await withLifecycleLock(SID, env.deps, async (lease: Lease) => {
      const out = await lease.remote('activate', 15000, async signal => (signal instanceof AbortSignal ? 'ok' : 'no'))
      expect(out).toBe('ok')
      return 'x'
    })
  })
})

// --- intents (D1) -------------------------------------------------------------------------

describe('intent records: written before each remote mutation, results applied only under the intent\'s token', () => {
  const SID = 'cs_test_intent'
  const record = `provision:${SID}`
  const key = lifecycleLockKey(SID)
  let redis: FakeRedis
  let logs: string[]

  beforeEach(async () => {
    redis = new FakeRedis()
    logs = []
    await redis.hset(record, { status: 'ready', provisionId: PID, attempt: 1, billing: 'charging' })
    await redis.expire(record, 86400)
  })

  it('writeIntent writes intentOp, intentKey, intentToken and intentAt under the fence; applyResult applies and clears them', async () => {
    const env = leaseEnv(redis)
    await withLifecycleLock(SID, env.deps, async (lease) => {
      await writeIntent(redis, SID, lease, 'subscribe', `subscribe:${PID}:1`, { provisionId: PID, now: 1000 })
      const mid = (await redis.hgetall(record))!
      expect(mid).toMatchObject({ intentOp: 'subscribe', intentKey: `subscribe:${PID}:1`, intentToken: lease.token })
      expect(mid.intentAt).toBe(new Date(1000).toISOString())
      const out = await applyResult(redis, SID, lease, 'subscribe', 'pendingSubscription', { provisionId: PID, subscriptionId: 'sub_1', invoiceId: 'in_1', subscriptionCreatedAt: 1, now: 2000 }, msg => logs.push(msg))
      expect(out).toBe('applied')
      const after = (await redis.hgetall(record))!
      expect(after.pendingSubscriptionId).toBe('sub_1')
      expect([after.intentOp, after.intentKey, after.intentToken, after.intentAt]).toEqual(['', '', '', ''])
      return 'x'
    })
  })

  it('a result after the lease was lost is dropped: the call is held open past expiry, another runner takes the lock, then the call succeeds; nothing is written and a fixed line names the op', async () => {
    const env = leaseEnv(redis)
    await withLifecycleLock(SID, env.deps, async (lease) => {
      await writeIntent(redis, SID, lease, 'subscribe', `subscribe:${PID}:1`, { provisionId: PID, now: 1000 })
      // The remote call hangs past the lease; the event loop never renews it.
      await env.advance(61000, { blocked: true })
      await redis.set(key, 'next-runner', { px: 60000 })
      const before = redis.dump()
      const out = await applyResult(redis, SID, lease, 'subscribe', 'pendingSubscription', { provisionId: PID, subscriptionId: 'sub_1', invoiceId: 'in_1', subscriptionCreatedAt: 1, now: 2000 }, msg => logs.push(msg))
      expect(out).toBe('dropped')
      expect(redis.dump()).toBe(before)
      return 'x'
    })
    expect(logs).toContain('lifecycle: stale result dropped (subscribe)')
  })

  it('a result whose intent was replaced by another holder is dropped, even while this token still holds the lock', async () => {
    const env = leaseEnv(redis)
    await withLifecycleLock(SID, env.deps, async (lease) => {
      await writeIntent(redis, SID, lease, 'pay', `pay:${PID}:1`, { provisionId: PID, now: 1000 })
      await redis.hset(record, { intentToken: 'another-holder' })
      const out = await applyResult(redis, SID, lease, 'pay', 'pending', { provisionId: PID, due: 5000, now: 2000 }, msg => logs.push(msg))
      expect(out).toBe('dropped')
      expect((await redis.hgetall(record))!.billingTries).toBeUndefined()
      return 'x'
    })
  })

  it('foreignIntent: an intent written under another token is the next holder\'s to reconcile; its own or none is not', () => {
    expect(foreignIntent({ intentOp: 'pay', intentKey: 'pay:x:1', intentToken: 'other' }, { token: 'mine' })).toEqual({ op: 'pay', key: 'pay:x:1', token: 'other' })
    expect(foreignIntent({ intentOp: 'pay', intentKey: 'pay:x:1', intentToken: 'mine' }, { token: 'mine' })).toBeNull()
    expect(foreignIntent({ intentOp: '', intentToken: '' }, { token: 'mine' })).toBeNull()
    expect(foreignIntent({}, { token: 'mine' })).toBeNull()
  })
})

// --- transitions -----------------------------------------------------------------------

describe('transition: validate, then check status and guards, then write everything together', () => {
  const SID = 'cs_test_transition'
  const record = `provision:${SID}`
  let redis: FakeRedis

  async function seed(fields: Record<string, unknown>, ttl = 86400) {
    await redis.set(`provision:by-id:${PID}`, SID, { ex: ttl })
    await redis.hset(`signup:${PID}`, { email: 'x@example.org' })
    await redis.expire(`signup:${PID}`, ttl)
    await redis.hset(record, { provisionId: PID, attempt: 1, ...fields })
    await redis.expire(record, ttl)
  }

  beforeEach(() => {
    redis = new FakeRedis()
  })

  it('refuses a status outside the from-set: nothing written, no index change, no lifetime change', async () => {
    await seed({ status: 'complete' })
    const before = redis.dump()
    const ttl = await redis.pttl(record)
    const out = await transition(redis, SID, 'held', { provisionId: PID, heldUntil: 5000 })
    expect(out).toEqual({ result: 'refused', status: 'complete' })
    expect(redis.dump()).toBe(before)
    expect(await redis.pttl(record)).toBe(ttl)
  })

  it('refuses when the record is gone and never creates the key', async () => {
    const out = await transition(redis, SID, 'pending', { provisionId: PID })
    expect(out).toEqual({ result: 'refused', status: 'none' })
    expect(redis.keys()).toEqual([])
  })

  it('a wrong-type index leaves the record unchanged: sweep:held is a string, the held transition answers invalid', async () => {
    await seed({ status: 'ready', billing: 'charging' })
    await redis.zadd('sweep:billing', { score: 1, member: SID })
    await redis.set('sweep:held', 'not-a-zset', {})
    const before = redis.dump()
    const out = await transition(redis, SID, 'held', { provisionId: PID, heldUntil: 5000 })
    expect(out.result).toBe('invalid')
    expect(redis.dump()).toBe(before)
  })

  it('a counter that is not an integer, or a score that is not a number, is invalid with nothing written', async () => {
    await seed({ status: 'ready', billing: 'charging', billingTries: '1.5' })
    const before = redis.dump()
    expect((await transition(redis, SID, 'pending', { provisionId: PID, due: 1 })).result).toBe('invalid')
    expect((await transition(redis, SID, 'held', { provisionId: PID, heldUntil: Number.NaN })).result).toBe('invalid')
    expect(redis.dump()).toBe(before)
  })

  it('applies record fields, fields-if-empty (readyAt once), index adds and the lifetime floor together; a lifetime is raised, never lowered', async () => {
    await seed({ status: 'installing' })
    await redis.expire(`signup:${PID}`, 5 * 86400)
    expect((await transition(redis, SID, 'ready', { provisionId: PID, attempt: 1, now: 1000 })).result).toBe('applied')
    const first = (await redis.hgetall(record))!
    expect(first.status).toBe('ready')
    expect(first.readyAt).toBe(new Date(1000).toISOString())
    expect(await redis.pttl(record)).toBe(259200 * 1000)
    expect(await redis.pttl(`provision:by-id:${PID}`)).toBe(259200 * 1000)
    // A 5-day key keeps its 5 days.
    expect(await redis.pttl(`signup:${PID}`)).toBe(5 * 86400 * 1000)
    expect(await redis.zrange('sweep:billing', 0, -1)).toEqual([SID])
    // readyAt is never moved by a later step that sets it if empty.
    await redis.hset(record, { status: 'installing' })
    await transition(redis, SID, 'ready', { provisionId: PID, attempt: 1, now: 9000 })
    expect((await redis.hgetall(record))!.readyAt).toBe(new Date(1000).toISOString())
  })

  it('refuses when a guard fails (paid is never paid twice): nothing written', async () => {
    await seed({ status: 'ready', billing: 'paid', subscriptionId: 'sub_1' })
    const before = redis.dump()
    const out = await transition(redis, SID, 'paid', { provisionId: PID, subscriptionId: 'sub_2' })
    expect(out).toEqual({ result: 'refused', status: 'ready' })
    expect(redis.dump()).toBe(before)
  })

  it('a fenced transition answers lost when the lock holds another token', async () => {
    await seed({ status: 'ready', billing: 'charging' })
    await redis.set(lifecycleLockKey(SID), 'theirs', { px: 60000 })
    const before = redis.dump()
    expect(await transition(redis, SID, 'pending', { provisionId: PID }, { token: 'mine' })).toEqual({ result: 'lost' })
    expect(redis.dump()).toBe(before)
  })
})

describe('COUNT_FAILURE_SCRIPT: one failure per attempt, in one step, with sweep:stops at the second', () => {
  const SID = 'cs_test_count'
  const record = `provision:${SID}`
  let redis: FakeRedis

  beforeEach(async () => {
    redis = new FakeRedis()
    await redis.set(`provision:by-id:${PID}`, SID, { ex: 86400 })
    await redis.set(`provision:${SID}:lock`, 'locked', { ex: 3600 })
  })

  it('counts once per attempt: status failed, reason, countedAttempt, canRetry below 2, the build lock freed, the claim taken; a replay of the same attempt is taken', async () => {
    await redis.hset(record, { status: 'installing', provisionId: PID, attempt: 1, failedAttempts: 0 })
    const out = await countFailureAtomic(redis, SID, { provisionId: PID, attempt: 1, reason: 'deploy_failed', now: 1000 })
    expect(out).toEqual({ result: 'counted', count: 1 })
    expect(await redis.hgetall(record)).toMatchObject({ status: 'failed', reason: 'deploy_failed', countedAttempt: 1, canRetry: true, failedAttempts: 1, provisionalUntil: 0 })
    expect(await redis.exists(`provision:${SID}:lock`)).toBe(0)
    expect(await redis.exists(`provision:${SID}:failed:1`)).toBe(1)
    expect(await redis.zrange('sweep:stops', 0, -1)).toEqual([])
    expect((await countFailureAtomic(redis, SID, { provisionId: PID, attempt: 1, reason: 'deploy_failed', now: 2000 })).result).not.toBe('counted')
    expect((await redis.hgetall(record))!.failedAttempts).toBe(1)
  })

  it('the second failure joins sweep:stops (score now) in the same step, with canRetry false', async () => {
    await redis.hset(record, { status: 'installing', provisionId: PID, attempt: 2, failedAttempts: 1, countedAttempt: 1 })
    const out = await countFailureAtomic(redis, SID, { provisionId: PID, attempt: 2, reason: 'deploy_failed', now: 7000 })
    expect(out).toEqual({ result: 'counted', count: 2 })
    expect((await redis.hgetall(record))!.canRetry).toBe(false)
    expect(await redis.zrange('sweep:stops', 0, -1)).toEqual([SID])
    expect(await redis.zcount('sweep:stops', 7000, 7000)).toBe(1)
  })

  it('refused on a sign-up past the build (ready, paid, complete): no count, no claim key, not in sweep:stops', async () => {
    await redis.hset(record, { status: 'complete', provisionId: PID, attempt: 1, billing: 'paid', subscriptionId: 'sub_1' })
    const before = redis.dump()
    const out = await countFailureAtomic(redis, SID, { provisionId: PID, attempt: 1, reason: 'unknown', now: 1000 })
    expect(out).toEqual({ result: 'refused', status: 'complete' })
    expect(redis.dump()).toBe(before)
    expect(await redis.exists(`provision:${SID}:failed:1`)).toBe(0)
  })

  it('refused on a ready sign-up whose charge has not started: the status alone decides, nothing written', async () => {
    await redis.hset(record, { status: 'ready', provisionId: PID, attempt: 1, failedAttempts: 0 })
    const before = redis.dump()
    expect(await countFailureAtomic(redis, SID, { provisionId: PID, attempt: 1, reason: 'unknown', now: 1000 })).toEqual({ result: 'refused', status: 'ready' })
    expect(redis.dump()).toBe(before)
  })

  it('validates first: a failedAttempts that is not an integer answers invalid with nothing written', async () => {
    await redis.hset(record, { status: 'installing', provisionId: PID, attempt: 1, failedAttempts: 'x' })
    const before = redis.dump()
    expect((await countFailureAtomic(redis, SID, { provisionId: PID, attempt: 1, now: 1000 })).result).toBe('invalid')
    expect(redis.dump()).toBe(before)
  })

  it('a provisional failure settles from failed (the window passed) and counts once', async () => {
    await redis.hset(record, { status: 'failed', provisionId: PID, attempt: 1, failedAttempts: 0, provisionalUntil: 500 })
    await redis.zadd('sweep:stops', { score: 500, member: SID })
    expect(await countFailureAtomic(redis, SID, { provisionId: PID, attempt: 1, now: 1000 })).toEqual({ result: 'counted', count: 1 })
    // Below two failures it owes the sweep nothing: it leaves sweep:stops in the same step.
    expect(await redis.zrange('sweep:stops', 0, -1)).toEqual([])
  })

  it('COUNT_FAILURE_SCRIPT is registered with its twin', () => {
    expect(typeof COUNT_FAILURE_SCRIPT).toBe('string')
  })
})

describe('CLEAR_INDEX_SCRIPT: compare-and-remove on the record\'s current status (Codex 6)', () => {
  const SID = 'cs_test_clear'
  let redis: FakeRedis

  beforeEach(() => {
    redis = new FakeRedis()
  })

  it('removes a member whose record is gone or no longer served by the index; keeps one that is', async () => {
    await redis.zadd('sweep:billing', { score: 1, member: SID }, { score: 1, member: 'cs_gone' })
    await redis.hset(`provision:${SID}`, { status: 'ready' })
    expect(await clearIndex(redis, SID, 'billing')).toBe(false)
    expect(await clearIndex(redis, 'cs_gone', 'billing')).toBe(true)
    await redis.hset(`provision:${SID}`, { status: 'complete' })
    expect(await clearIndex(redis, SID, 'billing')).toBe(true)
    expect(await redis.zrange('sweep:billing', 0, -1)).toEqual([])
  })

  it('sweep:stops keeps only a failed record still owed a settle or a stop', async () => {
    await redis.zadd('sweep:stops', { score: 1, member: SID })
    await redis.hset(`provision:${SID}`, { status: 'failed', failedAttempts: 1, provisionalUntil: 900 })
    expect(await clearIndex(redis, SID, 'stops')).toBe(false)
    await redis.hset(`provision:${SID}`, { provisionalUntil: 0 })
    expect(await clearIndex(redis, SID, 'stops')).toBe(true)
    await redis.zadd('sweep:stops', { score: 1, member: SID })
    await redis.hset(`provision:${SID}`, { failedAttempts: 2 })
    expect(await clearIndex(redis, SID, 'stops')).toBe(false)
    await redis.hset(`provision:${SID}`, { stopped: true })
    expect(await clearIndex(redis, SID, 'stops')).toBe(true)
  })

  it('a wrong-type record answers invalid and removes nothing', async () => {
    await redis.zadd('sweep:held', { score: 1, member: SID })
    await redis.set(`provision:${SID}`, 'oops', {})
    await expect(clearIndex(redis, SID, 'held')).resolves.toBe(false)
    expect(await redis.zrange('sweep:held', 0, -1)).toEqual([SID])
    expect(typeof CLEAR_INDEX_SCRIPT).toBe('string')
  })
})

// --- the wiring: billing, the callbacks and the stop on one lease ---------------------------

const W_SID = 'cs_test_wiring'
const W_REC = `provision:${W_SID}`
const W_SIGNUP = `signup:${PID}`
const W_LOCK = lifecycleLockKey(W_SID)
const SUB = 'sub_1'
const INVOICE = 'in_1'
const CREATED = 1794225600
const HOSTED = 'https://invoice.stripe.com/i/acct_x/test_secret_canary'
const STRIPE_OPTS = { timeout: STRIPE_TIMEOUT_MS, maxNetworkRetries: 0 }

function makeWorldStripe() {
  return {
    setupIntents: { retrieve: vi.fn(async (..._a: unknown[]) => ({ id: 'seti_1', status: 'succeeded', payment_method: 'pm_1' })) },
    subscriptions: {
      create: vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown>> => ({ id: SUB, created: CREATED, status: 'incomplete', metadata: { provision_id: PID }, latest_invoice: { id: INVOICE, status: 'open' } })),
      list: vi.fn(async (..._a: unknown[]): Promise<{ data: unknown[] }> => ({ data: [] })),
      cancel: vi.fn(async (..._a: unknown[]) => ({ id: SUB, status: 'canceled' })),
      retrieve: vi.fn(async (..._a: unknown[]) => ({ id: SUB, status: 'canceled' }))
    },
    invoices: {
      pay: vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown>> => ({ id: INVOICE, status: 'paid' })),
      retrieve: vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown>> => ({ id: INVOICE, status: 'open', hosted_invoice_url: HOSTED })),
      voidInvoice: vi.fn(async (..._a: unknown[]) => ({ id: INVOICE, status: 'void' }))
    },
    paymentMethods: { detach: vi.fn(async (..._a: unknown[]) => ({})) }
  }
}

function world() {
  const redis = new FakeRedis()
  const env = leaseEnv(redis)
  const stripe = makeWorldStripe()
  const logs: string[] = []
  const fetch = vi.fn(async (..._a: unknown[]) => ({ status: 200, json: async () => ({ activated: true }) }))
  const clock = { now: CREATED * 1000 }
  const billing: BillingDeps = {
    redis: redis as unknown as BillingDeps['redis'],
    stripe: () => stripe as never,
    fetch: fetch as unknown as BillingDeps['fetch'],
    callbackSecret: SECRET,
    now: () => clock.now,
    sleep: async () => {},
    log: msg => logs.push(msg),
    tick: env.deps.tick,
    timers: env.deps.timers
  }
  const mailFetch = vi.fn(async () => ({ id: 'email_1' }))
  const teardown = vi.fn(async () => {})
  const stop: RetryStopDeps = {
    redis: redis as unknown as RetryStopDeps['redis'],
    stripe: () => stripe as never,
    mail: { apiKey: 're_test', from: 'LocalNodes <hello@localnodes.xyz>', fetch: mailFetch },
    inviteHashSecret: 'invite-secret',
    teardown,
    now: () => clock.now,
    log: msg => logs.push(msg),
    tick: env.deps.tick,
    timers: env.deps.timers
  }
  return { redis, env, stripe, logs, fetch, clock, billing, stop, mailFetch, teardown }
}

async function seedWorld(redis: FakeRedis, fields: Record<string, unknown> = {}) {
  await redis.set(`provision:by-id:${PID}`, W_SID, { ex: 86400 })
  // 23-43 Task 6: the site already answered the probe (siteAnsweredAt), so the charge may start.
  await redis.hset(W_REC, { status: 'ready', subdomain: 'cascadia', provisionId: PID, attempt: 1, failedAttempts: 0, startedAt: '2026-11-08T11:50:00Z', siteAnsweredAt: '2026-11-08T11:55:00Z', ...fields })
  await redis.expire(W_REC, 86400)
  await redis.hset(W_SIGNUP, { subdomain: 'cascadia', email: 'organizer@example.org', inviteId: 'inv_1', stripeCustomerId: 'cus_1', setupIntentId: 'seti_1', priceId: 'price_1' })
  await redis.expire(W_SIGNUP, 86400)
  if (fields.status === undefined || fields.status === 'ready') await redis.zadd('sweep:billing', { score: 0, member: W_SID })
}

const lastArg = (call: unknown[]) => call[call.length - 1]

describe('the wiring: billing, the callbacks and the stop on one lease (23-43 Task 1)', () => {
  it('HIGH 6, Codex\'s reproduction: a workflow failed read while installing, applied after ready, payment and activation: {updated: false}, still complete and paid, failedAttempts unchanged, no claim key, not in sweep:stops', async () => {
    const w = world()
    await seedWorld(w.redis, { status: 'installing' })
    const stale = (await w.redis.hgetall(W_REC))!
    const bearer = `Bearer ${callbackToken(SECRET, PID)}`
    await handleProvisionCallback(bearer, { provision_id: PID, attempt: 1, status: 'ready' }, { provisionCallbackSecret: SECRET }, w.redis as never, {
      ...w.stop,
      billing: { start: async sid => { await chargeAtReady(sid, w.billing) }, nudge: async () => {} }
    })
    expect(await w.redis.hgetall(W_REC)).toMatchObject({ status: 'complete', subscriptionId: SUB, billing: 'paid' })
    const before = w.redis.dump()

    expect(await recordFailure(W_SID, stale, { attempt: 1, reason: 'deploy_failed', source: 'workflow' }, w.stop)).toEqual({ updated: false })
    expect(await recordFailure(W_SID, stale, { attempt: 1, reason: 'install_failed', source: 'site' }, w.stop)).toEqual({ updated: false })
    expect(await settleProvisional(W_SID, { ...stale, provisionalUntil: 1 }, w.stop)).toBe(false)
    await recordDispatchFailure(W_SID, 1, w.stop)

    // A late progress callback read while installing (the handler's cheap read saw a building status), applied now.
    const hgetall = w.redis.hgetall.bind(w.redis)
    let staleOnce = true
    w.redis.hgetall = (async (key: string) => {
      if (staleOnce && key === W_REC) {
        staleOnce = false
        return { ...stale }
      }
      return hgetall(key)
    }) as typeof w.redis.hgetall
    expect(await handleProvisionCallback(bearer, { provision_id: PID, attempt: 1, status: 'installing' }, { provisionCallbackSecret: SECRET }, w.redis as never, w.stop)).toEqual({ updated: false })
    w.redis.hgetall = hgetall as typeof w.redis.hgetall

    expect(w.redis.dump()).toBe(before)
    expect(await w.redis.hgetall(W_REC)).toMatchObject({ status: 'complete', subscriptionId: SUB, billing: 'paid', failedAttempts: 0 })
    expect(await w.redis.exists(`provision:${W_SID}:failed:1`)).toBe(0)
    expect(await w.redis.zrange('sweep:stops', 0, -1)).toEqual([])
    expect(w.stripe.paymentMethods.detach).not.toHaveBeenCalled()
  })

  it('HIGH 7, Codex\'s reproduction: when the held step cannot apply (wrong-type sweep:held) the sign-up is still ready, billing charging, in sweep:billing, and no link is stored', async () => {
    const w = world()
    await seedWorld(w.redis)
    // The pay call is the moment sweep:held goes bad: the charge and the subscription steps before it applied.
    w.stripe.invoices.pay.mockImplementation(async () => {
      await w.redis.set('sweep:held', 'not-a-zset', {})
      throw new Stripe.errors.StripeCardError({ message: 'auth', code: 'authentication_required', decline_code: 'authentication_required', type: 'card_error' } as never)
    })
    await expect(chargeAtReady(W_SID, w.billing)).rejects.toThrow()
    const st = (await w.redis.hgetall(W_REC))!
    expect(st.status).toBe('ready')
    expect(['charging', 'pending']).toContain(st.billing)
    expect(await w.redis.zrange('sweep:billing', 0, -1)).toEqual([W_SID])
    expect((await w.redis.hgetall(W_SIGNUP))!.hostedInvoiceUrl).toBeUndefined()
    // The step that could not apply is logged with its reason, in fixed words.
    expect(w.logs).toContain('lifecycle: held could not apply (type)')
  })

  it('HIGH 7: when the held step\'s eval fails before it applies (twice), nothing of held is written', async () => {
    const w = world()
    await seedWorld(w.redis)
    w.redis.failEvals(TRANSITION_SCRIPT, 2, args => args.includes('heldUntil'))
    w.stripe.invoices.pay.mockRejectedValue(new Stripe.errors.StripeCardError({ message: 'auth', code: 'authentication_required', type: 'card_error' } as never))
    await expect(chargeAtReady(W_SID, w.billing)).rejects.toThrow()
    expect((await w.redis.hgetall(W_REC))!.status).toBe('ready')
    expect(await w.redis.zrange('sweep:billing', 0, -1)).toEqual([W_SID])
    expect(await w.redis.zrange('sweep:held', 0, -1)).toEqual([])
  })

  it('HIGH 7: when the held step applies, status held, the link on signup, the sweep:held member at heldUntil and the removal from sweep:billing appear together, with the three keys at 72 h', async () => {
    const w = world()
    await seedWorld(w.redis)
    w.stripe.invoices.pay.mockRejectedValue(new Stripe.errors.StripeCardError({ message: 'auth', code: 'authentication_required', type: 'card_error' } as never))
    expect(await chargeAtReady(W_SID, w.billing)).toBe('held')
    const heldUntil = (CREATED + 82800) * 1000
    expect(await w.redis.hgetall(W_REC)).toMatchObject({ status: 'held', billing: 'held', heldUntil })
    expect((await w.redis.hgetall(W_SIGNUP))!.hostedInvoiceUrl).toBe(HOSTED)
    expect(await w.redis.zcount('sweep:held', heldUntil, heldUntil)).toBe(1)
    expect(await w.redis.zrange('sweep:billing', 0, -1)).toEqual([])
    for (const k of [W_REC, `provision:by-id:${PID}`, W_SIGNUP]) expect(await w.redis.pttl(k)).toBe(259200 * 1000)
  })

  it('billing writes the record and the indexes only through transitions: no direct HSET, HINCRBY, EXPIRE, ZADD or ZREM on provision:{sid} or a sweep index', async () => {
    const w = world()
    await seedWorld(w.redis)
    const direct: string[] = []
    for (const m of ['hset', 'hincrby', 'expire', 'zadd', 'zrem'] as const) {
      const orig = (w.redis[m] as (...a: unknown[]) => Promise<unknown>).bind(w.redis)
      ;(w.redis as unknown as Record<string, unknown>)[m] = async (key: string, ...rest: unknown[]) => {
        if (key === W_REC || key.startsWith('sweep:')) direct.push(`${m} ${key}`)
        return orig(key, ...rest)
      }
    }
    expect(await chargeAtReady(W_SID, w.billing)).toBe('activated')
    expect(direct).toEqual([])
  })

  it('every Stripe call under the lease carries timeout STRIPE_TIMEOUT_MS and maxNetworkRetries 0', async () => {
    const w = world()
    await seedWorld(w.redis, { billing: 'pending', billingTries: 1 })
    w.stripe.invoices.retrieve.mockResolvedValue({ id: INVOICE, status: 'open' })
    expect(await resumeBilling(W_SID, w.billing)).toBe('activated')
    const calls = [
      ...w.stripe.setupIntents.retrieve.mock.calls,
      ...w.stripe.subscriptions.list.mock.calls,
      ...w.stripe.subscriptions.create.mock.calls,
      ...w.stripe.invoices.retrieve.mock.calls,
      ...w.stripe.invoices.pay.mock.calls
    ]
    expect(calls.length).toBeGreaterThanOrEqual(5)
    for (const c of calls) expect(lastArg(c)).toMatchObject(STRIPE_OPTS)
    expect(lastArg(w.stripe.subscriptions.create.mock.calls[0]!)).toMatchObject({ idempotencyKey: expect.stringMatching(/^subscribe:/) })
  })

  it('an intent is written before each remote mutation (create, pay, the activation POST) and cleared by its result', async () => {
    const w = world()
    await seedWorld(w.redis)
    const seen: Array<[string, unknown, unknown]> = []
    const peek = async (what: string) => {
      const st = (await w.redis.hgetall(W_REC))!
      seen.push([what, st.intentOp, st.intentKey])
    }
    w.stripe.subscriptions.create.mockImplementation(async () => {
      await peek('create')
      return { id: SUB, created: CREATED, status: 'incomplete', metadata: { provision_id: PID }, latest_invoice: { id: INVOICE, status: 'open' } }
    })
    w.stripe.invoices.pay.mockImplementation(async () => {
      await peek('pay')
      return { id: INVOICE, status: 'paid' }
    })
    w.fetch.mockImplementation(async () => {
      await peek('activate')
      return { status: 200, json: async () => ({ activated: true }) }
    })
    expect(await chargeAtReady(W_SID, w.billing)).toBe('activated')
    expect(seen).toEqual([
      ['create', 'subscribe', `subscribe:${PID}:1`],
      ['pay', 'pay', `pay:${PID}:1`],
      ['activate', 'activate', `activate:${PID}`]
    ])
    const after = (await w.redis.hgetall(W_REC))!
    expect(after.intentToken ?? '').toBe('')
  })

  it('a create that answers after the lease was lost: the result is dropped (no pendingSubscriptionId), a fixed line names the op, the run ends lost', async () => {
    const w = world()
    await seedWorld(w.redis)
    w.stripe.subscriptions.create.mockImplementation(async () => {
      await w.env.advance(61000, { blocked: true })
      await w.redis.set(W_LOCK, 'next-runner', { px: 60000 })
      return { id: SUB, created: CREATED, status: 'incomplete', metadata: { provision_id: PID }, latest_invoice: { id: INVOICE, status: 'open' } }
    })
    expect(await chargeAtReady(W_SID, w.billing)).toBe('lost')
    const st = (await w.redis.hgetall(W_REC))!
    expect(st.pendingSubscriptionId).toBeUndefined()
    expect(st.intentOp).toBe('subscribe')
    expect(w.stripe.invoices.pay).not.toHaveBeenCalled()
    expect(w.logs).toContain('lifecycle: stale result dropped (subscribe)')
    expect(await w.redis.get(W_LOCK)).toBe('next-runner')
  })

  it('the next holder reconciles a foreign subscribe intent first: it lists and adopts by metadata.provision_id and never creates', async () => {
    const w = world()
    await seedWorld(w.redis, { billing: 'charging', intentOp: 'subscribe', intentKey: `subscribe:${PID}`, intentToken: 'old-lease', intentAt: 'x' })
    w.stripe.subscriptions.list.mockResolvedValue({ data: [{ id: SUB, created: CREATED, status: 'incomplete', metadata: { provision_id: PID }, latest_invoice: { id: INVOICE, status: 'open' } }] })
    expect(await chargeAtReady(W_SID, w.billing)).toBe('activated')
    expect(w.stripe.subscriptions.create).not.toHaveBeenCalled()
    expect(w.stripe.invoices.pay).toHaveBeenCalledTimes(1)
    expect((await w.redis.hgetall(W_REC))!.subscriptionId).toBe(SUB)
  })

  it('the next holder reconciles a foreign pay intent by reading the invoice: paid is never paid again', async () => {
    const w = world()
    await seedWorld(w.redis, { billing: 'charging', pendingSubscriptionId: SUB, invoiceId: INVOICE, subscriptionCreatedAt: CREATED, intentOp: 'pay', intentKey: `pay:${PID}`, intentToken: 'old-lease', intentAt: 'x' })
    w.stripe.invoices.retrieve.mockResolvedValue({ id: INVOICE, status: 'paid' })
    expect(await chargeAtReady(W_SID, w.billing)).toBe('activated')
    expect(w.stripe.invoices.pay).not.toHaveBeenCalled()
    expect(await w.redis.hgetall(W_REC)).toMatchObject({ status: 'complete', subscriptionId: SUB, intentToken: '' })
  })

  it('the next holder reconciles a foreign activate intent with one activation try (the site\'s route is idempotent)', async () => {
    const w = world()
    await seedWorld(w.redis, { billing: 'paid', subscriptionId: SUB, intentOp: 'activate', intentKey: `activate:${PID}`, intentToken: 'old-lease', intentAt: 'x' })
    expect(await resumeBilling(W_SID, w.billing)).toBe('activated')
    expect(w.fetch).toHaveBeenCalledTimes(1)
    expect(await w.redis.hgetall(W_REC)).toMatchObject({ status: 'complete', intentToken: '' })
  })

  it('billing and teardown never run at once: while chargeAtReady holds the lease, stopProvision answers { stopped: false } with no Stripe call and no write', async () => {
    const w = world()
    await seedWorld(w.redis)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    w.stripe.subscriptions.create.mockImplementation(async () => {
      await gate
      return { id: SUB, created: CREATED, status: 'incomplete', metadata: { provision_id: PID }, latest_invoice: { id: INVOICE, status: 'open' } }
    })
    const charge = chargeAtReady(W_SID, w.billing)
    await vi.waitFor(() => expect(w.stripe.subscriptions.create).toHaveBeenCalled())
    const before = (await w.redis.hgetall(W_REC))!
    expect(await stopProvision(W_SID, w.stop)).toEqual({ stopped: false })
    expect(await w.redis.hgetall(W_REC)).toEqual(before)
    expect(w.stripe.paymentMethods.detach).not.toHaveBeenCalled()
    expect(w.teardown).not.toHaveBeenCalled()
    release()
    expect(await charge).toBe('activated')
  })

  it('billing and teardown never run at once, the reverse: while a stop holds the lease, chargeAtReady is busy and makes no Stripe call', async () => {
    const w = world()
    await seedWorld(w.redis, { status: 'failed', failedAttempts: 2 })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    w.teardown.mockImplementation(async () => { await gate })
    const stopping = stopProvision(W_SID, w.stop)
    await vi.waitFor(() => expect(w.teardown).toHaveBeenCalled())
    expect(await chargeAtReady(W_SID, w.billing)).toBe('busy')
    expect(w.stripe.subscriptions.create).not.toHaveBeenCalled()
    release()
    expect(await stopping).toEqual({ stopped: true })
  })

  it('a declined payment\'s teardown starts at once: onDeclined runs after the lease is released, so the real stopProvision is not busy', async () => {
    const w = world()
    await seedWorld(w.redis)
    let lockAtHook: unknown = 'unset'
    w.billing.onDeclined = async (sid) => {
      lockAtHook = await w.redis.get(W_LOCK)
      await stopProvision(sid, w.stop)
    }
    w.stripe.invoices.pay.mockRejectedValue(new Stripe.errors.StripeCardError({ message: 'declined', code: 'card_declined', type: 'card_error' } as never))
    expect(await chargeAtReady(W_SID, w.billing)).toBe('declined')
    expect(lockAtHook).toBeNull()
    expect((await w.redis.hgetall(W_REC))!.tornDown).toBe(true)
    expect(w.teardown).toHaveBeenCalledTimes(1)
    // The Resend call carries the lease's abort signal (its one total deadline, H1).
    expect((w.mailFetch.mock.calls[0] as unknown[])[1]).toMatchObject({ signal: expect.any(AbortSignal) })
  })

  it('teardown\'s paid hand-back runs onPaid after the stop\'s lease is released and logs a busy or skipped outcome as a fixed id-free line; the sign-up waits in sweep:billing', async () => {
    const w = world()
    await seedWorld(w.redis, { status: 'declined', billing: 'declined', teardownReason: 'declined', pendingSubscriptionId: SUB, invoiceId: INVOICE })
    w.stripe.invoices.retrieve.mockResolvedValue({ id: INVOICE, status: 'paid' })
    let lockAtPaid: unknown = 'unset'
    w.stop.onPaid = async () => {
      lockAtPaid = await w.redis.get(W_LOCK)
      return 'busy'
    }
    expect(await stopProvision(W_SID, w.stop)).toEqual({ stopped: false })
    expect(lockAtPaid).toBeNull()
    expect(w.logs).toContain('retry-stop: paid hand-back not finished (busy), the billing step takes it over')
    expect(await w.redis.zrange('sweep:billing', 0, -1)).toEqual([W_SID])
    for (const line of w.logs) for (const id of [W_SID, PID, SUB, INVOICE]) expect(line).not.toContain(id)
  })

  it('invoice.paid stores the invoice id, the amount paid and the currency on the paid record (Codex 3)', async () => {
    const w = world()
    await seedWorld(w.redis, { status: 'held', billing: 'held', pendingSubscriptionId: SUB, heldUntil: CREATED * 1000 + 82800000 })
    await w.redis.zadd('sweep:held', { score: 1, member: W_SID })
    const out = await routeInvoiceEvent({
      type: 'invoice.paid',
      data: { object: { id: INVOICE, billing_reason: 'subscription_create', amount_paid: 2900, currency: 'usd', parent: { subscription_details: { metadata: { provision_id: PID }, subscription: SUB } } } }
    }, w.billing)
    expect(out).toBe('activated')
    expect(await w.redis.hgetall(W_REC)).toMatchObject({ status: 'complete', subscriptionId: SUB, invoiceId: INVOICE, amountPaid: 2900, currency: 'usd' })
    expect(await w.redis.zrange('sweep:held', 0, -1)).toEqual([])
    // paid keeps the held record's 72 h; complete never lowers it.
    expect(await w.redis.pttl(W_REC)).toBe(259200 * 1000)
  })

  it('Codex 6, the stale sweep: the billing step reads a held record, the paid transition moves it to ready and back into sweep:billing, and the step\'s clean-up leaves the new member in place', async () => {
    const w = world()
    await seedWorld(w.redis, { status: 'held', billing: 'held', pendingSubscriptionId: SUB })
    await w.redis.zadd('sweep:billing', { score: 0, member: W_SID })
    const orig = w.redis.hgetall.bind(w.redis)
    let once = true
    w.redis.hgetall = (async (key: string) => {
      const snap = await orig(key)
      if (once && key === W_REC) {
        once = false
        await transition(w.redis, W_SID, 'paid', { provisionId: PID, subscriptionId: SUB, now: CREATED * 1000 })
      }
      return snap
    }) as typeof w.redis.hgetall
    await sweepBilling({ redis: w.redis as never, billing: w.billing, now: () => CREATED * 1000 })
    expect(await w.redis.zrange('sweep:billing', 0, -1)).toEqual([W_SID])
  })

  it('a ready callback raises all three keys to 72 h (signup:{provisionId}, made 24 h at checkout, outlives the probe window) and writes readyAt once', async () => {
    const w = world()
    await seedWorld(w.redis, { status: 'installing' })
    const bearer = `Bearer ${callbackToken(SECRET, PID)}`
    await handleProvisionCallback(bearer, { provision_id: PID, attempt: 1, status: 'ready' }, { provisionCallbackSecret: SECRET }, w.redis as never, w.stop)
    for (const k of [W_REC, `provision:by-id:${PID}`, W_SIGNUP]) expect(await w.redis.pttl(k)).toBe(259200 * 1000)
    const readyAt = (await w.redis.hgetall(W_REC))!.readyAt
    expect(typeof readyAt).toBe('string')
    await handleProvisionCallback(bearer, { provision_id: PID, attempt: 1, status: 'ready' }, { provisionCallbackSecret: SECRET }, w.redis as never, w.stop)
    expect((await w.redis.hgetall(W_REC))!.readyAt).toBe(readyAt)
  })

  it('a ready callback over the site\'s own provisional failed of this attempt wins: ready, the window closed, out of sweep:stops', async () => {
    const w = world()
    await seedWorld(w.redis, { status: 'failed', reason: 'install_failed', provisionalUntil: CREATED * 1000 + 600000, canRetry: false })
    await w.redis.zadd('sweep:stops', { score: CREATED * 1000 + 600000, member: W_SID })
    const bearer = `Bearer ${callbackToken(SECRET, PID)}`
    expect(await handleProvisionCallback(bearer, { provision_id: PID, attempt: 1, status: 'ready' }, { provisionCallbackSecret: SECRET }, w.redis as never, w.stop)).toEqual({ updated: true })
    expect(await w.redis.hgetall(W_REC)).toMatchObject({ status: 'ready', provisionalUntil: 0, reason: '' })
    expect(await w.redis.zrange('sweep:stops', 0, -1)).toEqual([])
  })

  it('CALLBACK_STATUSES is the explicit list of the building statuses plus ready and failed, and holds no state only the sign-up app writes', () => {
    expect([...CALLBACK_STATUSES]).toEqual(['triggered', 'provisioning', 'installing', 'creating_user', 'sending_email', 'ready', 'failed'])
    for (const s of ['held', 'declined', 'complete', 'tearing_down', 'torn_down', 'refunding', 'refunded']) expect(CALLBACK_STATUSES as readonly string[]).not.toContain(s)
  })
})

// --- Task 2: terminal states that exclude each other -----------------------------------------

describe('Task 2 rows: tearing_down, torn_down and the paid hand-back (23-43 Task 2)', () => {
  const SID = 'cs_test_terminal'
  const REC = `provision:${SID}`
  const BYID = `provision:by-id:${PID}`
  const SIGNUP = `signup:${PID}`
  const KEEP_MS = 259200 * 1000
  let redis: FakeRedis

  async function seed(fields: Record<string, unknown>, ttl = 86400) {
    await redis.set(BYID, SID, { ex: ttl })
    await redis.hset(SIGNUP, { email: 'x@example.org' })
    await redis.expire(SIGNUP, ttl)
    await redis.hset(REC, { provisionId: PID, attempt: 1, ...fields })
    await redis.expire(REC, ttl)
  }
  const rec = async () => (await redis.hgetall<Record<string, unknown>>(REC))!
  const members = (key: string) => redis.zrange(key, 0, -1)

  beforeEach(() => {
    redis = new FakeRedis()
  })

  const TERMINAL = ['tearing_down', 'torn_down', 'refunding', 'refunded']
  // 23-43 Task 6: the 30-try activation cap (activationGaveUp, parkBilling) is gone; no refund row is a charge row.
  const CHARGE_ROWS = ['charging', 'pendingSubscription', 'pending', 'rejected', 'held', 'declined', 'paid', 'activationTry', 'complete', 'unclear', 'review', 'triesExhausted'] as const

  it('no charge row names a terminal state in its from-set', async () => {
    const { TRANSITIONS } = await import('../../server/utils/lifecycle')
    for (const name of CHARGE_ROWS) {
      const row = TRANSITIONS[name] as { from: readonly string[] }
      for (const t of TERMINAL) expect(row.from, `${name} from ${t}`).not.toContain(t)
    }
  })

  it('nothing leaves tearing_down except to torn_down: every row that starts from tearing_down sets no other status', async () => {
    const { TRANSITIONS } = await import('../../server/utils/lifecycle')
    const params = { provisionId: PID, kind: 'paid_after_void', flag: 'stopApp', reason: 'build_failed', result: 'deleted', noApp: true, token: 't', op: 'void', key: 'k', subscriptionId: SUB, undone: 'none', mail: 'none' }
    const starts: string[] = []
    for (const [name, row] of Object.entries(TRANSITIONS) as Array<[string, { from: readonly string[], build: (p: Record<string, unknown>, now: number, sid: string) => { set?: Record<string, unknown>, guards?: unknown[] } }]>) {
      if (!row.from.includes('tearing_down')) continue
      starts.push(name)
      const built = row.build(params, 1, SID)
      const set = built.set ?? {}
      // The one named exception, orchestrator ruling (a) (23-43 Task 7): a zero invoice's late
      // activation before the delete was asked for goes back to complete. Its guards hold it there.
      if (name === 'keepLateActivation') {
        expect(set.status).toBe('complete')
        for (const g of [['refundZero', 'eq', 'true'], ['stopApp', 'nottrue'], ['dispatchAskedAt', 'empty']]) expect(built.guards).toContainEqual(g)
        continue
      }
      expect([undefined, 'tearing_down', 'torn_down'], name).toContain(set.status)
    }
    expect(starts).toContain('tornDown')
    for (const name of CHARGE_ROWS) expect(starts).not.toContain(name)
  })

  it('tearingDownBuildFailed: from failed with two failures and no money moved; tearing_down, out of sweep:stops, into sweep:teardown, 72 h', async () => {
    await seed({ status: 'failed', failedAttempts: 2, canRetry: false })
    await redis.zadd('sweep:stops', { score: 1, member: SID })
    expect((await transition(redis, SID, 'tearingDownBuildFailed', { provisionId: PID, now: 5000 })).result).toBe('applied')
    expect(await rec()).toMatchObject({ status: 'tearing_down', teardownReason: 'build_failed', canRetry: false })
    expect(await members('sweep:stops')).toEqual([])
    expect(await members('sweep:teardown')).toEqual([SID])
    for (const k of [REC, BYID, SIGNUP]) expect(await redis.pttl(k)).toBe(KEEP_MS)
  })

  it.each([
    ['one failure', { status: 'failed', failedAttempts: 1 }],
    ['an invoice', { status: 'failed', failedAttempts: 2, invoiceId: INVOICE }],
    ['a pending subscription', { status: 'failed', failedAttempts: 2, pendingSubscriptionId: SUB }],
    ['a subscription', { status: 'failed', failedAttempts: 2, subscriptionId: SUB }],
    ['billing set', { status: 'failed', failedAttempts: 2, billing: 'charging' }],
    ['status ready (HIGH 3)', { status: 'ready', failedAttempts: 2, billing: 'charging' }],
    ['status complete (HIGH 3)', { status: 'complete', failedAttempts: 2, billing: 'paid', subscriptionId: SUB }]
  ])('tearingDownBuildFailed is refused with %s: nothing written', async (_l, fields) => {
    await seed(fields)
    const before = redis.dump()
    expect((await transition(redis, SID, 'tearingDownBuildFailed', { provisionId: PID })).result).toBe('refused')
    expect(redis.dump()).toBe(before)
  })

  it('tearingDownDeclined: only from declined after the void (stopInvoice true), with no subscription and no paidAt', async () => {
    await seed({ status: 'declined', billing: 'declined', teardownReason: 'declined' })
    await redis.zadd('sweep:teardown', { score: 1, member: SID })
    expect((await transition(redis, SID, 'tearingDownDeclined', { provisionId: PID })).result).toBe('refused')
    await redis.hset(REC, { stopInvoice: true })
    expect((await transition(redis, SID, 'tearingDownDeclined', { provisionId: PID })).result).toBe('applied')
    expect(await rec()).toMatchObject({ status: 'tearing_down', teardownReason: 'declined' })
    expect(await members('sweep:teardown')).toEqual([SID])
    expect(await redis.pttl(REC)).toBe(KEEP_MS)
  })

  it('tearingDownHeldExpired: from held after the void; status tearing_down with held_expired, out of sweep:held, into sweep:teardown', async () => {
    await seed({ status: 'held', billing: 'held', heldUntil: 9000 })
    await redis.zadd('sweep:held', { score: 9000, member: SID })
    expect((await transition(redis, SID, 'tearingDownHeldExpired', { provisionId: PID })).result).toBe('refused')
    await redis.hset(REC, { stopInvoice: true })
    expect((await transition(redis, SID, 'tearingDownHeldExpired', { provisionId: PID })).result).toBe('applied')
    expect(await rec()).toMatchObject({ status: 'tearing_down', teardownReason: 'held_expired', billing: 'declined' })
    expect(await members('sweep:held')).toEqual([])
    expect(await members('sweep:teardown')).toEqual([SID])
  })

  it('tornDown: only from tearing_down; torn_down joins sweep:teardown so the teardowns step finishes what follows', async () => {
    await seed({ status: 'declined', teardownReason: 'declined' })
    expect((await transition(redis, SID, 'tornDown', { provisionId: PID, result: 'deleted' })).result).toBe('refused')
    await redis.hset(REC, { status: 'tearing_down' })
    expect((await transition(redis, SID, 'tornDown', { provisionId: PID, result: 'deleted', now: 7000 })).result).toBe('applied')
    expect(await rec()).toMatchObject({ status: 'torn_down', teardownApp: 'deleted' })
    expect(await members('sweep:teardown')).toEqual([SID])
    expect(await redis.pttl(REC)).toBe(KEEP_MS)
  })

  it.each(['held', 'declined'])('handBack from %s: ready, billing paid, the subscription, invoice, amount and currency, paidAt, teardownReason cleared, out of sweep:teardown and sweep:held, into sweep:billing, 72 h', async (status) => {
    await seed({ status, billing: status, teardownReason: status === 'declined' ? 'declined' : '', pendingSubscriptionId: SUB, invoiceId: INVOICE })
    await redis.zadd('sweep:teardown', { score: 1, member: SID })
    await redis.zadd('sweep:held', { score: 1, member: SID })
    const out = await transition(redis, SID, 'handBack', { provisionId: PID, subscriptionId: SUB, invoiceId: INVOICE, amountPaid: 4900, currency: 'usd', now: 8000 })
    expect(out.result).toBe('applied')
    expect(await rec()).toMatchObject({ status: 'ready', billing: 'paid', subscriptionId: SUB, invoiceId: INVOICE, amountPaid: 4900, currency: 'usd', paidAt: new Date(8000).toISOString(), teardownReason: '' })
    expect(await members('sweep:teardown')).toEqual([])
    expect(await members('sweep:held')).toEqual([])
    expect(await members('sweep:billing')).toEqual([SID])
    for (const k of [REC, BYID, SIGNUP]) expect(await redis.pttl(k)).toBe(KEEP_MS)
  })

  it.each([
    ['after the void (stopInvoice true)', { status: 'declined', stopInvoice: true }],
    ['a sign-up already paid', { status: 'held', subscriptionId: SUB, billing: 'paid' }],
    ['a complete sign-up', { status: 'complete', billing: 'paid', subscriptionId: SUB }],
    ['tearing_down', { status: 'tearing_down', teardownReason: 'declined', stopInvoice: true }],
    ['torn_down', { status: 'torn_down', teardownReason: 'declined' }]
  ])('handBack is refused %s: nothing written', async (_l, fields) => {
    await seed(fields)
    const before = redis.dump()
    expect((await transition(redis, SID, 'handBack', { provisionId: PID, subscriptionId: SUB })).result).toBe('refused')
    expect(redis.dump()).toBe(before)
  })

  it('no Task 2 row lowers a lifetime: 5-day keys keep 5 days through tearingDown, tornDown and handBack (m11)', async () => {
    const FIVE = 5 * 86400
    await seed({ status: 'failed', failedAttempts: 2 }, FIVE)
    expect((await transition(redis, SID, 'tearingDownBuildFailed', { provisionId: PID })).result).toBe('applied')
    expect((await transition(redis, SID, 'tornDown', { provisionId: PID, result: 'gone' })).result).toBe('applied')
    for (const k of [REC, BYID, SIGNUP]) expect(await redis.pttl(k)).toBe(FIVE * 1000)
    await redis.del(REC)
    await seed({ status: 'held', billing: 'held', pendingSubscriptionId: SUB }, FIVE)
    expect((await transition(redis, SID, 'handBack', { provisionId: PID, subscriptionId: SUB })).result).toBe('applied')
    for (const k of [REC, BYID, SIGNUP]) expect(await redis.pttl(k)).toBe(FIVE * 1000)
  })

  it('the flag row adds one reconcile:flags entry, {kind}:{sid}, and with no op id writes nothing on the record', async () => {
    await seed({ status: 'tearing_down', teardownReason: 'declined' })
    const before = await rec()
    expect((await transition(redis, SID, 'flag', { provisionId: PID, kind: 'paid_after_void', opId: '', now: 4000 })).result).toBe('applied')
    expect(await members('reconcile:flags')).toEqual([`paid_after_void:${SID}`])
    expect(await rec()).toEqual(before)
  })

  it('INDEX_RULES.teardown serves declined, tearing_down with steps left, activation_failed with a subscription (Codex 3), and torn_down with the removed mail owed', async () => {
    const keep = async (fields: Record<string, unknown>) => {
      await redis.del(REC)
      await redis.hset(REC, fields)
      await redis.zadd('sweep:teardown', { score: 1, member: SID })
      return !(await clearIndex(redis, SID, 'teardown'))
    }
    expect(await keep({ status: 'declined', teardownReason: 'declined' })).toBe(true)
    expect(await keep({ status: 'tearing_down', teardownReason: 'build_failed' })).toBe(true)
    expect(await keep({ status: 'tearing_down', teardownReason: 'activation_failed', subscriptionId: SUB, refundSucceededAt: 'x' })).toBe(true)
    expect(await keep({ status: 'tearing_down', teardownReason: 'declined', tornDown: true })).toBe(false)
    expect(await keep({ status: 'torn_down', teardownReason: 'held_expired', tornDown: true, removedMailDue: true })).toBe(true)
    expect(await keep({ status: 'torn_down', teardownReason: 'held_expired', tornDown: true })).toBe(false)
    expect(await keep({ status: 'torn_down', teardownReason: 'declined' })).toBe(true)
    expect(await keep({ status: 'ready', billing: 'paid', subscriptionId: SUB })).toBe(false)
    expect(await keep({ status: 'complete' })).toBe(false)
  })
})

// --- Task 3: Stripe duplicate protection (D3), the billingTries cap, the one-step create -------

describe('Task 3 rows, the dedupe marker and CREATE_SCRIPT (23-43 Task 3)', () => {
  const SID = 'cs_test_dedupe'
  const REC = `provision:${SID}`
  const BYID = `provision:by-id:${PID}`
  const SIGNUP = `signup:${PID}`
  const MARK = `dedupe:${PID}`
  const BUILD_LOCK = `provision:${SID}:lock`
  let redis: FakeRedis

  async function seed(fields: Record<string, unknown>, opts: { marker?: boolean } = {}) {
    await redis.set(BYID, SID, { ex: 259200 })
    await redis.hset(SIGNUP, { email: 'x@example.org' })
    await redis.expire(SIGNUP, 259200)
    await redis.hset(REC, { provisionId: PID, attempt: 1, status: 'ready', ...fields })
    await redis.expire(REC, 259200)
    if (opts.marker !== false) {
      await redis.hset(MARK, { checkoutSession: SID })
      await redis.expire(MARK, 2592000)
    }
  }
  const rec = async () => (await redis.hgetall<Record<string, unknown>>(REC))!
  const members = (key: string) => redis.zrange(key, 0, -1)

  beforeEach(() => {
    redis = new FakeRedis()
  })

  it('the caps: BILLING_MAX_TRIES is 10, UNCLEAR_MAX_TRIES is 3, the marker lives 30 days', async () => {
    const { BILLING_MAX_TRIES, UNCLEAR_MAX_TRIES, DEDUPE_SECONDS, dedupeKey } = await import('../../server/utils/lifecycle')
    expect([BILLING_MAX_TRIES, UNCLEAR_MAX_TRIES, DEDUPE_SECONDS]).toEqual([10, 3, 2592000])
    expect(dedupeKey(PID)).toBe(MARK)
  })

  it('charging writes subscribeAttempt 1 and payAttempt 1 once; a stored attempt is never changed by it', async () => {
    await seed({ siteAnsweredAt: 'x' })
    expect((await transition(redis, SID, 'charging', { provisionId: PID, now: 1000 })).result).toBe('applied')
    expect(await rec()).toMatchObject({ billing: 'charging', subscribeAttempt: 1, payAttempt: 1 })
    redis = new FakeRedis()
    await seed({ subscribeAttempt: 2, payAttempt: 3, siteAnsweredAt: 'x' })
    await transition(redis, SID, 'charging', { provisionId: PID, now: 1000 })
    expect(await rec()).toMatchObject({ subscribeAttempt: 2, payAttempt: 3 })
  })

  it('pendingSubscription writes the subscription id on the dedupe marker in the same step; the marker keeps its own 30-day lifetime', async () => {
    await seed({ billing: 'charging' })
    expect((await transition(redis, SID, 'pendingSubscription', { provisionId: PID, now: 1000, subscriptionId: 'sub_9', invoiceId: 'in_9', subscriptionCreatedAt: 1 })).result).toBe('applied')
    expect(await rec()).toMatchObject({ pendingSubscriptionId: 'sub_9' })
    expect(await redis.hgetall(MARK)).toMatchObject({ checkoutSession: SID, subscriptionId: 'sub_9' })
    expect(redis.atomic().pttl(MARK)).toBeGreaterThan(2592000 * 1000 - 5000)
  })

  it('a transition never creates the marker: no dedupe key without one written at checkout', async () => {
    await seed({ billing: 'charging' }, { marker: false })
    expect((await transition(redis, SID, 'pendingSubscription', { provisionId: PID, now: 1000, subscriptionId: 'sub_9', invoiceId: 'in_9', subscriptionCreatedAt: 1 })).result).toBe('applied')
    expect(redis.atomic().exists(MARK)).toBe(0)
  })

  it('paid and handBack write the invoice id on the marker', async () => {
    await seed({ billing: 'pending', pendingSubscriptionId: 'sub_9' })
    await transition(redis, SID, 'paid', { provisionId: PID, now: 1000, subscriptionId: 'sub_9', invoiceId: 'in_9' })
    expect(await redis.hgetall(MARK)).toMatchObject({ invoiceId: 'in_9' })
    redis = new FakeRedis()
    await seed({ status: 'held', billing: 'held', pendingSubscriptionId: 'sub_9' })
    await transition(redis, SID, 'handBack', { provisionId: PID, now: 1000, subscriptionId: 'sub_9', invoiceId: 'in_8' })
    expect(await redis.hgetall(MARK)).toMatchObject({ invoiceId: 'in_8' })
  })

  it('pending counts until the cap: refused at billingTries 9, where triesExhausted takes over (rejected, tries, out of sweep:billing, flagged)', async () => {
    await seed({ billing: 'pending', billingTries: 9 })
    await redis.zadd('sweep:billing', { score: 1, member: SID })
    expect((await transition(redis, SID, 'pending', { provisionId: PID, now: 1000, due: 2000 })).result).toBe('refused')
    expect((await transition(redis, SID, 'triesExhausted', { provisionId: PID, now: 1000 })).result).toBe('applied')
    expect(await rec()).toMatchObject({ billing: 'rejected', billingError: 'tries', billingTries: 10 })
    expect(await members('sweep:billing')).toEqual([])
    expect(await members('reconcile:flags')).toEqual([`stripe_unclear:${SID}`])
  })

  it('triesExhausted is refused below the cap', async () => {
    await seed({ billing: 'pending', billingTries: 3 })
    expect((await transition(redis, SID, 'triesExhausted', { provisionId: PID, now: 1000 })).result).toBe('refused')
  })

  it('unclear counts unclearTries and billingTries, stays pending, due again; refused when unclearTries is not what the caller read', async () => {
    await seed({ billing: 'pending', billingTries: 1 })
    expect((await transition(redis, SID, 'unclear', { provisionId: PID, now: 1000, due: 61000, unclearTries: 0 })).result).toBe('applied')
    expect(await rec()).toMatchObject({ billing: 'pending', billingError: 'unclear', unclearTries: 1, billingTries: 2 })
    expect((redis as unknown as { store: Map<string, { zset: Map<string, number> }> }).store.get('sweep:billing')!.zset.get(SID)).toBe(61000)
    expect((await transition(redis, SID, 'unclear', { provisionId: PID, now: 1000, due: 61000, unclearTries: 0 })).result).toBe('refused')
  })

  it('unclear is refused at the third (review takes it): unclearTries 2', async () => {
    await seed({ billing: 'pending', billingTries: 3, unclearTries: 2 })
    expect((await transition(redis, SID, 'unclear', { provisionId: PID, now: 1000, due: 61000, unclearTries: 2 })).result).toBe('refused')
  })

  it('review stops billing in one step: billing review, the kind as billingError, out of sweep:billing, one reconcile:flags entry', async () => {
    await seed({ billing: 'pending', billingTries: 3, unclearTries: 2 })
    await redis.zadd('sweep:billing', { score: 1, member: SID })
    expect((await transition(redis, SID, 'review', { provisionId: PID, now: 1000, kind: 'stripe_unclear', unclearTries: 2 })).result).toBe('applied')
    expect(await rec()).toMatchObject({ billing: 'review', billingError: 'stripe_unclear', unclearTries: 3, billingTries: 4 })
    expect(await members('sweep:billing')).toEqual([])
    expect(await members('reconcile:flags')).toEqual([`stripe_unclear:${SID}`])
  })

  it('review for several matches counts nothing', async () => {
    await seed({ billing: 'charging' })
    await transition(redis, SID, 'review', { provisionId: PID, now: 1000, kind: 'multiple_subscriptions' })
    const r = await rec()
    expect(r).toMatchObject({ billing: 'review', billingError: 'multiple_subscriptions' })
    expect(r).not.toHaveProperty('billingTries')
    expect(await members('reconcile:flags')).toEqual([`multiple_subscriptions:${SID}`])
  })

  it.each(['rejected', 'review'])('billing %s: pending, unclear and charging are refused', async (billing) => {
    await seed({ billing })
    expect((await transition(redis, SID, 'pending', { provisionId: PID, now: 1000, due: 1 })).result).toBe('refused')
    expect((await transition(redis, SID, 'unclear', { provisionId: PID, now: 1000, due: 1, unclearTries: 0 })).result).toBe('refused')
    expect((await transition(redis, SID, 'charging', { provisionId: PID, now: 1000 })).result).toBe('refused')
  })

  describe('CREATE_SCRIPT: the first writes of checkout.session.completed, one step', () => {
    const input = { sid: SID, provisionId: PID, subdomain: 'cascadia', now: 1794225600000 }

    it('created: the by-id map, the first hash (triggered, attempt 1, no failures), the marker with checkoutSession, the build lock, each with its lifetime', async () => {
      const { createProvision } = await import('../../server/utils/lifecycle')
      expect(await createProvision(redis, input)).toBe('created')
      expect(await redis.get(BYID)).toBe(SID)
      expect(await rec()).toMatchObject({ status: 'triggered', subdomain: 'cascadia', provisionId: PID, attempt: 1, failedAttempts: 0, startedAt: '2026-11-09T12:00:00.000Z' })
      expect(await redis.hgetall(MARK)).toMatchObject({ checkoutSession: SID })
      expect(await redis.get(BUILD_LOCK)).toBe('locked')
      const r = redis.atomic()
      expect(Math.round(r.pttl(REC) / 1000)).toBe(86400)
      expect(Math.round(r.pttl(BYID) / 1000)).toBe(86400)
      expect(Math.round(r.pttl(MARK) / 1000)).toBe(2592000)
      expect(Math.round(r.pttl(BUILD_LOCK) / 1000)).toBe(3600)
    })

    it('a record already there: exists, and nothing is written', async () => {
      const { createProvision } = await import('../../server/utils/lifecycle')
      await redis.hset(REC, { status: 'ready', provisionId: PID, attempt: 2 })
      const before = redis.dump()
      expect(await createProvision(redis, input)).toBe('exists')
      expect(redis.dump()).toBe(before)
    })

    it('the record expired but the marker is there (a redelivery 25 hours later): exists, and nothing is written', async () => {
      const { createProvision } = await import('../../server/utils/lifecycle')
      await redis.hset(MARK, { checkoutSession: SID })
      const before = redis.dump()
      expect(await createProvision(redis, input)).toBe('exists')
      expect(redis.dump()).toBe(before)
    })

    it('a wrong-type key is invalid and writes nothing', async () => {
      const { createProvision } = await import('../../server/utils/lifecycle')
      await redis.set(MARK, 'oops')
      const before = redis.dump()
      await expect(createProvision(redis, input)).rejects.toThrow(/invalid/)
      expect(redis.dump()).toBe(before)
    })

    it('a lost reply: the re-run with the same op id answers created, so the caller still dispatches once', async () => {
      const { createProvision, CREATE_SCRIPT } = await import('../../server/utils/lifecycle')
      redis.loseReplies(CREATE_SCRIPT, 1)
      expect(await createProvision(redis, input)).toBe('created')
      expect(await rec()).toMatchObject({ status: 'triggered' })
    })

    it('an eval that fails before it applies leaves nothing; the error is raised', async () => {
      const { createProvision, CREATE_SCRIPT } = await import('../../server/utils/lifecycle')
      redis.failEvals(CREATE_SCRIPT, 2)
      await expect(createProvision(redis, input)).rejects.toThrow()
      expect(redis.keys()).toEqual([])
    })
  })
})

// --- Task 6: the probe, the activation window and the refund (23-43 Task 6) -----------------------

describe('Task 6 rows: the probe, the 24 h activation window and the refund state table (23-43 Task 6)', () => {
  const SID = 'cs_test_refund_rows'
  const REC = `provision:${SID}`
  const BYID = `provision:by-id:${PID}`
  const SIGNUP = `signup:${PID}`
  const MARK = `dedupe:${PID}`
  const KEEP_MS = 259200 * 1000
  const DAY = 86400000
  let redis: FakeRedis

  async function seed(fields: Record<string, unknown>, ttl = 86400) {
    await redis.set(BYID, SID, { ex: ttl })
    await redis.hset(SIGNUP, { email: 'x@example.org' })
    await redis.expire(SIGNUP, ttl)
    await redis.hset(MARK, { checkoutSession: SID })
    await redis.expire(MARK, 2592000)
    await redis.hset(REC, { provisionId: PID, attempt: 1, subdomain: 'cascadia', ...fields })
    await redis.expire(REC, ttl)
  }
  const rec = async () => (await redis.hgetall<Record<string, unknown>>(REC))!
  const members = (key: string) => redis.zrange(key, 0, -1)
  const go = (name: Parameters<typeof transition>[2], params: Record<string, unknown> = {}) => transition(redis, SID, name, { provisionId: PID, ...params })
  /** Paid at 1000, its 24 h window ends at 1000 + DAY. */
  const paidRecord = { status: 'ready', billing: 'paid', subscriptionId: SUB, invoiceId: INVOICE, amountPaid: 4900, currency: 'usd', paidAt: new Date(1000).toISOString(), activationDeadline: 1000 + DAY, siteAnsweredAt: 'x' }

  beforeEach(() => {
    redis = new FakeRedis()
  })

  it('the windows are 24 hours: ACTIVATION_WINDOW_MS and PROBE_WINDOW_MS', async () => {
    const { ACTIVATION_WINDOW_MS, PROBE_WINDOW_MS } = await import('../../server/utils/lifecycle')
    expect(ACTIVATION_WINDOW_MS).toBe(DAY)
    expect(PROBE_WINDOW_MS).toBe(DAY)
  })

  it('ready writes readyAtMs once (a number the probe window guard can read), beside readyAt', async () => {
    await seed({ status: 'installing' })
    expect((await go('ready', { attempt: 1, now: 5000 })).result).toBe('applied')
    expect(await rec()).toMatchObject({ readyAt: new Date(5000).toISOString(), readyAtMs: 5000 })
  })

  it('paid and handBack write activationDeadline = now + ACTIVATION_WINDOW_MS (a number the refund guard can read)', async () => {
    await seed({ status: 'ready', billing: 'pending' })
    expect((await go('paid', { subscriptionId: SUB, now: 7000 })).result).toBe('applied')
    expect(await rec()).toMatchObject({ activationDeadline: 7000 + DAY })
    await redis.del(REC)
    await seed({ status: 'held', billing: 'held', pendingSubscriptionId: SUB })
    expect((await go('handBack', { subscriptionId: SUB, now: 9000 })).result).toBe('applied')
    expect(await rec()).toMatchObject({ activationDeadline: 9000 + DAY })
  })

  it('charging is refused until the site answered the probe (siteAnsweredAt set), and once siteNeverAnswered is set', async () => {
    await seed({ status: 'ready' })
    const before = redis.dump()
    expect((await go('charging')).result).toBe('refused')
    expect(redis.dump()).toBe(before)
    await redis.hset(REC, { siteAnsweredAt: 'x', siteNeverAnswered: true })
    expect((await go('charging')).result).toBe('refused')
    await redis.hset(REC, { siteNeverAnswered: '' })
    expect((await go('charging')).result).toBe('applied')
  })

  it('siteAnswered: fields only, from ready, written once; a second answer is refused', async () => {
    await seed({ status: 'ready' })
    await redis.zadd('sweep:billing', { score: 1, member: SID })
    expect((await go('siteAnswered', { now: 3000 })).result).toBe('applied')
    expect(await rec()).toMatchObject({ status: 'ready', siteAnsweredAt: new Date(3000).toISOString() })
    expect(await members('sweep:billing')).toEqual([SID])
    expect((await go('siteAnswered', { now: 4000 })).result).toBe('refused')
    expect((await rec()).siteAnsweredAt).toBe(new Date(3000).toISOString())
  })

  it('probeTry: probeTries plus one and sweep:billing due 60 s later; refused once the site answered', async () => {
    await seed({ status: 'ready' })
    expect((await go('probeTry', { due: 61000 })).result).toBe('applied')
    expect(await rec()).toMatchObject({ probeTries: 1 })
    expect(await redis.zrangebyscore('sweep:billing', 61000, 61000)).toEqual([SID])
    await redis.hset(REC, { siteAnsweredAt: 'x' })
    expect((await go('probeTry', { due: 1 })).result).toBe('refused')
  })

  it('siteNeverAnswered: only 24 h after readyAtMs with no answer; out of sweep:billing, one site_never_answered flag, 72 h', async () => {
    await seed({ status: 'ready', readyAtMs: 1000 })
    await redis.zadd('sweep:billing', { score: 1, member: SID })
    expect((await go('siteNeverAnswered', { now: 1000 + DAY - 1 })).result).toBe('refused')
    expect((await go('siteNeverAnswered', { now: 1000 + DAY })).result).toBe('applied')
    expect(await rec()).toMatchObject({ status: 'ready', siteNeverAnswered: true })
    expect(await members('sweep:billing')).toEqual([])
    expect(await members('reconcile:flags')).toEqual([`site_never_answered:${SID}`])
    expect(await redis.pttl(REC)).toBe(KEEP_MS)
  })

  it('siteNeverAnswered is refused with no readyAtMs, once the site answered, or once billing started', async () => {
    for (const fields of [{}, { readyAtMs: 1, siteAnsweredAt: 'x' }, { readyAtMs: 1, billing: 'charging' }]) {
      redis = new FakeRedis()
      await seed({ status: 'ready', ...fields })
      expect((await go('siteNeverAnswered', { now: 10 * DAY })).result, JSON.stringify(fields)).toBe('refused')
    }
  })

  it('activationTry has no try cap: billing paid, not activated, due again later, in sweep:billing', async () => {
    await seed({ ...paidRecord, activationTries: 400 })
    expect((await go('activationTry', { due: 5000 })).result).toBe('applied')
    expect(await rec()).toMatchObject({ activationTries: 401 })
    expect(await redis.zrangebyscore('sweep:billing', 5000, 5000)).toEqual([SID])
  })

  it('the 30-try cap rows are gone (activationGaveUp, parkBilling)', async () => {
    const { TRANSITIONS } = await import('../../server/utils/lifecycle')
    expect(TRANSITIONS).not.toHaveProperty('activationGaveUp')
    expect(TRANSITIONS).not.toHaveProperty('parkBilling')
  })

  it('refunding: from ready, billing paid, not activated, the window passed; teardownReason activation_failed, a refund_started flag, into sweep:refund, out of sweep:billing, 72 h', async () => {
    await seed(paidRecord)
    await redis.zadd('sweep:billing', { score: 1, member: SID })
    expect((await go('refunding', { now: 1000 + DAY - 1 })).result).toBe('refused')
    expect((await go('refunding', { now: 1000 + DAY })).result).toBe('applied')
    expect(await rec()).toMatchObject({ status: 'refunding', teardownReason: 'activation_failed', refundingAt: new Date(1000 + DAY).toISOString() })
    expect(await members('sweep:refund')).toEqual([SID])
    expect(await members('sweep:billing')).toEqual([])
    expect(await members('reconcile:flags')).toEqual([`refund_started:${SID}`])
    expect(await redis.pttl(REC)).toBe(KEEP_MS)
  })

  it.each([
    ['activated', { activatedAt: 'x' }],
    ['billing not paid', { billing: 'pending' }],
    ['billing in review', { billing: 'review' }],
    ['no activationDeadline', { activationDeadline: '' }],
    ['complete', { status: 'complete' }]
  ])('refunding is refused when %s: nothing written', async (_l, fields) => {
    await seed({ ...paidRecord, ...fields })
    const before = redis.dump()
    expect((await go('refunding', { now: 10 * DAY })).result).toBe('refused')
    expect(redis.dump()).toBe(before)
  })

  it('complete is never reachable from refunding or after: its from-set is ready only, and a refunding record refuses it', async () => {
    const { TRANSITIONS } = await import('../../server/utils/lifecycle')
    expect([...TRANSITIONS.complete.from]).toEqual(['ready'])
    for (const status of ['refunding', 'refunded', 'tearing_down', 'torn_down']) {
      redis = new FakeRedis()
      await seed({ ...paidRecord, status, teardownReason: 'activation_failed' })
      expect((await go('complete')).result, status).toBe('refused')
      expect((await rec()).activatedAt).toBeUndefined()
    }
  })

  it('refundSucceeded: from refunding; refundId and refundSucceededAt, refundId on the dedupe marker too', async () => {
    await seed({ ...paidRecord, status: 'refunding', teardownReason: 'activation_failed' })
    expect((await go('refundSucceeded', { refundId: 're_1', now: 6000 })).result).toBe('applied')
    expect(await rec()).toMatchObject({ status: 'refunding', refundId: 're_1', refundSucceededAt: new Date(6000).toISOString(), refundDone: true })
    expect(await redis.hgetall(MARK)).toMatchObject({ refundId: 're_1' })
  })

  it('refundPending: keeps refunding, stores the refund id and the next poll in sweep:refund', async () => {
    await seed({ ...paidRecord, status: 'refunding', teardownReason: 'activation_failed' })
    expect((await go('refundPending', { refundId: 're_1', due: 70000 })).result).toBe('applied')
    expect(await rec()).toMatchObject({ status: 'refunding', refundId: 're_1' })
    expect((await rec()).refundSucceededAt).toBeUndefined()
    expect(await redis.zrangebyscore('sweep:refund', 70000, 70000)).toEqual([SID])
  })

  it('refundProblem: stays refunding and in sweep:refund (R3-1), a refund_problem flag; refundSucceeded and refunded are refused after it', async () => {
    await seed({ ...paidRecord, status: 'refunding', teardownReason: 'activation_failed' })
    await redis.zadd('sweep:refund', { score: 1, member: SID })
    expect((await go('refundProblem', { kind: 'partial', refundId: 're_1' })).result).toBe('applied')
    expect(await rec()).toMatchObject({ status: 'refunding', refundProblem: 'partial' })
    expect(await members('sweep:refund')).toEqual([SID])
    expect(await members('reconcile:flags')).toEqual([`refund_problem:${SID}`])
    expect((await go('refundSucceeded', { refundId: 're_1' })).result).toBe('refused')
    await redis.hset(REC, { refundDone: true, refundCancelled: true })
    expect((await go('refunded')).result).toBe('refused')
  })

  // R3-1: the only way a refund problem leaves sweep:refund, and only with the cancel recorded done.
  it('refundProblemSettled: refused while the cancel is not done or without a refund problem; applied once, out of sweep:refund', async () => {
    await seed({ ...paidRecord, status: 'refunding', teardownReason: 'activation_failed' })
    await redis.zadd('sweep:refund', { score: 1, member: SID })
    expect((await go('refundProblemSettled')).result).toBe('refused')
    await redis.hset(REC, { refundCancelled: true })
    expect((await go('refundProblemSettled')).result).toBe('refused')
    await redis.hset(REC, { refundCancelled: '', refundProblem: 'partial' })
    expect((await go('refundProblemSettled')).result).toBe('refused')
    expect(await members('sweep:refund')).toEqual([SID])
    await redis.hset(REC, { refundCancelled: true })
    expect((await go('refundProblemSettled')).result).toBe('applied')
    expect(typeof (await rec()).refundSettledAt).toBe('string')
    expect(await members('sweep:refund')).toEqual([])
    expect((await go('refundProblemSettled')).result).toBe('refused')
  })

  // R3-2: the pass's first write also moves the sign-up to the back of sweep:refund.
  it('refundTick with a due time re-scores the sweep:refund member; without one it leaves the index alone; a settled refund problem is never put back', async () => {
    await seed({ ...paidRecord, status: 'refunding', teardownReason: 'activation_failed' })
    await redis.zadd('sweep:refund', { score: 1, member: SID })
    expect((await go('refundTick')).result).toBe('applied')
    expect(await redis.zscore('sweep:refund', SID)).toBe(1)
    expect((await go('refundTick', { due: 5000 })).result).toBe('applied')
    expect(await redis.zscore('sweep:refund', SID)).toBe(5000)
    await redis.hset(REC, { refundProblem: 'partial', refundCancelled: true, refundSettledAt: 'x' })
    await redis.zrem('sweep:refund', SID)
    expect((await go('refundTick', { due: 6000 })).result).toBe('refused')
    expect(await members('sweep:refund')).toEqual([])
    expect((await go('refundTick')).result).toBe('applied')
    expect(await members('sweep:refund')).toEqual([])
  })

  it('refundZero: amount paid 0, nothing to refund: refundZero and refundDone, no refund id', async () => {
    await seed({ ...paidRecord, amountPaid: 0, status: 'refunding', teardownReason: 'activation_failed' })
    expect((await go('refundZero')).result).toBe('applied')
    expect(await rec()).toMatchObject({ refundZero: true, refundDone: true })
  })

  it('refundInvoice records the invoice id, amount and currency recovered from the subscription (refunding only)', async () => {
    await seed({ status: 'refunding', billing: 'paid', subscriptionId: SUB, teardownReason: 'activation_failed' })
    expect((await go('refundInvoice', { invoiceId: INVOICE, amountPaid: 4900, currency: 'usd' })).result).toBe('applied')
    expect(await rec()).toMatchObject({ invoiceId: INVOICE, amountPaid: 4900, currency: 'usd' })
  })

  it('refunded: only after the refund is done (D2) and the subscription cancelled; stays in sweep:refund for the teardown hand-over', async () => {
    await seed({ ...paidRecord, status: 'refunding', teardownReason: 'activation_failed' })
    await redis.zadd('sweep:refund', { score: 1, member: SID })
    expect((await go('refunded')).result).toBe('refused')
    await redis.hset(REC, { refundDone: true })
    expect((await go('refundCancelled')).result).toBe('applied')
    expect((await go('refunded', { now: 8000 })).result).toBe('applied')
    expect(await rec()).toMatchObject({ status: 'refunded', refundedAt: new Date(8000).toISOString() })
    expect(await redis.zrangebyscore('sweep:refund', 8000, 8000)).toEqual([SID])
    expect(await redis.pttl(REC)).toBe(KEEP_MS)
  })

  it('tearingDownActivationFailed: from refunded only; tearing_down, out of sweep:refund and into sweep:teardown in the same step', async () => {
    await seed({ ...paidRecord, status: 'refunding', teardownReason: 'activation_failed', refundDone: true, refundCancelled: true })
    expect((await go('tearingDownActivationFailed')).result).toBe('refused')
    await redis.hset(REC, { status: 'refunded' })
    await redis.zadd('sweep:refund', { score: 1, member: SID })
    expect((await go('tearingDownActivationFailed', { now: 9000 })).result).toBe('applied')
    expect(await rec()).toMatchObject({ status: 'tearing_down', teardownReason: 'activation_failed' })
    expect(await members('sweep:refund')).toEqual([])
    expect(await members('sweep:teardown')).toEqual([SID])
  })

  it('lateActivation: on a refund state only; lateActivation true and a late_activation flag, nothing else', async () => {
    await seed({ ...paidRecord, status: 'refunding', teardownReason: 'activation_failed' })
    const before = await rec()
    expect((await go('lateActivation', { opId: '' })).result).toBe('applied')
    expect(await rec()).toEqual({ ...before, lateActivation: true })
    expect(await members('reconcile:flags')).toEqual([`late_activation:${SID}`])
    redis = new FakeRedis()
    await seed(paidRecord)
    expect((await go('lateActivation', { opId: '' })).result).toBe('refused')
  })

  it('CLEAR_INDEX keeps a refunding or refunded member of sweep:refund, a refund problem not yet settled too (R3-1), and drops a settled one or another status', async () => {
    const { clearIndex } = await import('../../server/utils/lifecycle')
    for (const [fields, kept] of [
      [{ status: 'refunding' }, true],
      [{ status: 'refunded' }, true],
      [{ status: 'refunding', refundProblem: 'failed' }, true],
      [{ status: 'refunding', refundProblem: 'failed', refundCancelled: true }, true],
      [{ status: 'refunding', refundProblem: 'failed', refundCancelled: true, refundSettledAt: 'x' }, false],
      [{ status: 'tearing_down' }, false],
      [{ status: 'ready' }, false]
    ] as const) {
      redis = new FakeRedis()
      await seed({ ...paidRecord, teardownReason: 'activation_failed', ...fields })
      await redis.zadd('sweep:refund', { score: 1, member: SID })
      await clearIndex(redis, SID, 'refund')
      expect(await members('sweep:refund'), JSON.stringify(fields)).toEqual(kept ? [SID] : [])
    }
  })

  // --- orchestrator ruling (a), 2026-11-09 (23-ORCH-INBOX.md): a zero invoice whose late activation
  // lands before the delete is asked for keeps the site live, in one guarded, fenced step. ---
  describe('orchestrator ruling (a): keepLateActivation, a free site that activated late stays live', () => {
    const zeroCase = { ...paidRecord, amountPaid: 0, teardownReason: 'activation_failed', refundZero: true, refundDone: true, lateActivation: true }

    it.each(['refunding', 'refunded', 'tearing_down'])('from %s: complete, activatedAt, out of every sweep, a kept flag naming what already ran, 72 h on all three keys', async (status) => {
      await seed({ ...zeroCase, status }, 60)
      for (const index of ['sweep:refund', 'sweep:teardown', 'sweep:stops', 'sweep:billing']) await redis.zadd(index, { score: 1, member: SID })
      expect((await go('keepLateActivation', { now: 9000, undone: 'cancel', mail: 'none' })).result).toBe('applied')
      const r = await rec()
      expect(r).toMatchObject({ status: 'complete', activatedAt: new Date(9000).toISOString(), lateKeptAt: new Date(9000).toISOString(), lateKeptAfter: 'cancel', lateActivation: true, refundZero: true })
      expect(r.stoppedMail).toBeUndefined()
      for (const index of ['sweep:refund', 'sweep:teardown', 'sweep:stops', 'sweep:billing']) expect(await members(index), index).toEqual([])
      expect(await members('reconcile:flags')).toEqual([`late_activation:${SID}:kept:mail_none:cancel`])
      for (const key of [REC, BYID, SIGNUP]) expect(await redis.pttl(key), key).toBeGreaterThan(KEEP_MS - 5000)
    })

    it('a money refund never goes live: refused without refundZero, even with lateActivation (T-23-195, T-23-198)', async () => {
      // A paid refund still pending at Stripe: every other guard would pass, so refundZero alone refuses it.
      await seed({ ...zeroCase, refundZero: '', refundDone: '', amountPaid: 4900, refundId: 're_1', refundStatus: 'pending', status: 'refunding' })
      expect((await go('keepLateActivation', { undone: 'none', mail: 'none' })).result).toBe('refused')
      expect((await rec()).status).toBe('refunding')
      // And a refunded one, refund proven, in its teardown.
      redis = new FakeRedis()
      await seed({ ...zeroCase, refundZero: '', amountPaid: 4900, refundSucceededAt: 'x', status: 'tearing_down' })
      expect((await go('keepLateActivation', { undone: 'none', mail: 'none' })).result).toBe('refused')
    })

    it.each([
      ['the delete was dispatched (stopApp)', { stopApp: true }],
      ['the delete was dispatched (teardownDispatchedAt)', { teardownDispatchedAt: 'x' }],
      ['the delete was asked for (dispatchAskedAt, an intent that may have gone out)', { dispatchAskedAt: 'x' }],
      ['a dispatch intent is open', { intentOp: 'dispatch', intentToken: 't', intentKey: 'k' }],
      ['no late activation was seen', { lateActivation: '' }],
      ['the site is already activated', { activatedAt: 'x' }],
      ['a refund problem waits for a person', { refundProblem: 'failed' }],
      ['another teardown reason', { teardownReason: 'build_failed' }]
    ])('refused when %s', async (_label, extra) => {
      await seed({ ...zeroCase, status: 'tearing_down', ...extra })
      expect((await go('keepLateActivation', { undone: 'none', mail: 'none' })).result).toBe('refused')
      expect((await rec()).status).toBe('tearing_down')
    })

    it.each(['torn_down', 'ready', 'complete', 'declined'])('refused from %s', async (status) => {
      await seed({ ...zeroCase, status })
      expect((await go('keepLateActivation', { undone: 'none', mail: 'none' })).result).toBe('refused')
    })

    it('the Stopped mail: sent (stopMail) or maybe sent (a mail intent was written) is recorded on the record and the flag; the claim must match the record', async () => {
      await seed({ ...zeroCase, status: 'tearing_down', stopMail: true })
      expect((await go('keepLateActivation', { undone: 'hold,lock,card,invite', mail: 'none' })).result).toBe('refused')
      expect((await go('keepLateActivation', { undone: 'hold,lock,card,invite', mail: 'sent' })).result).toBe('applied')
      expect(await rec()).toMatchObject({ status: 'complete', stoppedMail: 'sent', lateKeptAfter: 'hold,lock,card,invite' })
      expect(await members('reconcile:flags')).toEqual([`late_activation:${SID}:kept:mail_sent:hold,lock,card,invite`])
      redis = new FakeRedis()
      await seed({ ...zeroCase, status: 'tearing_down', mailAskedAt: 'x' })
      expect((await go('keepLateActivation', { undone: 'none', mail: 'none' })).result).toBe('refused')
      expect((await go('keepLateActivation', { undone: 'none', mail: 'maybe' })).result).toBe('applied')
      expect(await rec()).toMatchObject({ stoppedMail: 'maybe' })
    })

    it('an unknown step name or mail word is invalid and writes nothing', async () => {
      await seed({ ...zeroCase, status: 'tearing_down' })
      const before = redis.dump()
      await expect(go('keepLateActivation', { undone: 'card,app', mail: 'none' })).rejects.toThrow(/keepLateActivation/)
      await expect(go('keepLateActivation', { undone: 'none', mail: 'later' })).rejects.toThrow(/keepLateActivation/)
      expect(redis.dump()).toBe(before)
    })

    it('the intent row marks a dispatch or mail intent for good: dispatchAskedAt and mailAskedAt survive the intent being cleared', async () => {
      // C2: with the late activation recorded the dispatch intent refuses (next test), so this one has none.
      await seed({ ...zeroCase, lateActivation: false, status: 'tearing_down' })
      expect((await go('intent', { now: 7000, op: 'mail', key: 'k', token: 't' })).result).toBe('applied')
      expect((await go('intent', { now: 8000, op: 'dispatch', key: 'k', token: 't' })).result).toBe('applied')
      expect((await go('clearIntent', { token: 't' })).result).toBe('applied')
      expect(await rec()).toMatchObject({ mailAskedAt: new Date(7000).toISOString(), dispatchAskedAt: new Date(8000).toISOString(), intentOp: '' })
      redis = new FakeRedis()
      await seed({ ...zeroCase, status: 'tearing_down' })
      await go('intent', { op: 'card', key: 'k', token: 't' })
      const r = await rec()
      expect(r.mailAskedAt).toBeUndefined()
      expect(r.dispatchAskedAt).toBeUndefined()
    })

    it('C2: the dispatch intent refuses while lateActivation is set on a zero-charge sign-up, and writes nothing; a mail intent, a paid sign-up\'s late 200 or a zero charge with no late 200 do not stop it', async () => {
      await seed({ ...zeroCase, status: 'tearing_down' })
      const before = await rec()
      expect(await go('intent', { now: 8000, op: 'dispatch', key: 'k', token: 't' })).toEqual({ result: 'refused', status: 'tearing_down' })
      expect(await rec()).toEqual(before)
      expect((await go('intent', { now: 8000, op: 'mail', key: 'k', token: 't' })).result).toBe('applied')
      for (const variant of [{ refundZero: false }, { lateActivation: false }]) {
        redis = new FakeRedis()
        await seed({ ...zeroCase, ...variant, status: 'tearing_down' })
        expect((await go('intent', { now: 8000, op: 'dispatch', key: 'k', token: 't' })).result).toBe('applied')
        expect((await rec()).dispatchAskedAt).toBe(new Date(8000).toISOString())
      }
    })

    it('complete keeps its from-set (ready only); keepLateActivation is the one way from a refund state to complete, and only for a zero invoice', async () => {
      const { TRANSITIONS } = await import('../../server/utils/lifecycle')
      expect([...TRANSITIONS.complete.from]).toEqual(['ready'])
      expect([...TRANSITIONS.keepLateActivation.from]).toEqual(['refunding', 'refunded', 'tearing_down'])
      const built = TRANSITIONS.keepLateActivation.build({ undone: 'none', mail: 'none' }, 1, SID)
      expect(built.guards).toContainEqual(['refundZero', 'eq', 'true'])
      expect(built.guards).toContainEqual(['stopApp', 'nottrue'])
      expect(built.guards).toContainEqual(['dispatchAskedAt', 'empty'])
    })
  })

  it('no refund row is a charge row, and none starts from a building state', async () => {
    const { TRANSITIONS, BUILDING_STATES } = await import('../../server/utils/lifecycle')
    for (const name of ['refunding', 'refundSucceeded', 'refundPending', 'refundProblem', 'refundZero', 'refundInvoice', 'refundCancelled', 'refunded', 'tearingDownActivationFailed', 'lateActivation'] as const) {
      const row = TRANSITIONS[name] as { from: readonly string[] }
      for (const b of BUILDING_STATES) expect(row.from, name).not.toContain(b)
    }
  })
})

// Code review fix round 1, C1: every row that writes a refunding record raises its keys to 72 h.
describe('C1: every refund row carries the 72 h floor', () => {
  it.each(['refunding', 'refundInvoice', 'refundSucceeded', 'refundPending', 'refundPendingStale', 'refundProblem', 'refundProblemSettled', 'refundZero', 'refundCancelled', 'refunded', 'tearingDownActivationFailed'] as const)('%s raises the record to KEEP_SECONDS', (name) => {
    const params = { provisionId: PID, refundId: 're_1', kind: 'failed', invoiceId: 'in_1', amountPaid: 4900, currency: 'usd', due: 1 }
    expect(TRANSITIONS[name].build(params, 1794225600000, 'cs_test_floor').floor).toBe(KEEP_SECONDS)
  })
  it('the 7-day limit is 7 days', () => {
    expect(REFUND_PENDING_LIMIT_MS).toBe(7 * 86400000)
  })
})

// Code review fix round 1, C5: one lastOpId slot did not make a replay a no-op
// once another write came in between. Callback A applies installing and its
// EVAL reply is lost; callback B applies creating_user (lastOpId is now B's);
// A's re-run with its own op id then applied installing again. Each callback
// step now carries a per-callback key (attempt and status, cbSeen:{attempt}:{status})
// checked inside the transition: a callback already applied is refused,
// whatever was written since.
describe('C5: a replayed progress callback never re-applies after another write', () => {
  const SID = 'cs_test_callback_replay'
  const REC_ = `provision:${SID}`
  const bearer = `Bearer ${callbackToken(SECRET, PID)}`
  const cb = (redis: FakeRedis, status: string) => handleProvisionCallback(bearer, { provision_id: PID, attempt: 1, status }, { provisionCallbackSecret: SECRET }, redis as never)

  async function seedBuilding(redis: FakeRedis) {
    await redis.set(`provision:by-id:${PID}`, SID, { ex: 86400 })
    await redis.hset(REC_, { status: 'provisioning', provisionId: PID, attempt: 1, failedAttempts: 0, subdomain: 'cascadia' })
    await redis.expire(REC_, 86400)
  }

  it('A applies installing and its reply is lost, B applies creating_user, A\'s re-run is refused: the status stays creating_user', async () => {
    const redis = new FakeRedis()
    await seedBuilding(redis)
    const original = redis.eval.bind(redis)
    let interleaved = false
    vi.spyOn(redis, 'eval').mockImplementation(async (script: string, keys: string[], args: unknown[]) => {
      const out = await original(script, keys, args)
      if (!interleaved && script === TRANSITION_SCRIPT && (args as string[]).includes('installing')) {
        interleaved = true
        expect(await cb(redis, 'creating_user')).toEqual({ updated: true })
        throw new Error('fake-redis: the reply was lost')
      }
      return out
    })
    await cb(redis, 'installing')
    expect((await redis.hgetall<Record<string, unknown>>(REC_))!.status).toBe('creating_user')
  })

  it('an HTTP redelivery of installing after creating_user is refused and writes nothing', async () => {
    const redis = new FakeRedis()
    await seedBuilding(redis)
    expect(await cb(redis, 'installing')).toEqual({ updated: true })
    expect(await cb(redis, 'creating_user')).toEqual({ updated: true })
    const before = redis.dump()
    expect(await cb(redis, 'installing')).toEqual({ updated: false })
    expect(redis.dump()).toBe(before)
    expect((await redis.hgetall<Record<string, unknown>>(REC_))!.status).toBe('creating_user')
  })

  it('the ready rows carry the same key: a ready already applied for this attempt is refused even from a building status', async () => {
    const redis = new FakeRedis()
    await seedBuilding(redis)
    await redis.hset(REC_, { status: 'creating_user', 'cbSeen:1:ready': 'x' })
    expect((await transition(redis, SID, 'ready', { provisionId: PID, attempt: 1 })).result).toBe('refused')
    await redis.hset(REC_, { status: 'failed', provisionalUntil: 5 })
    expect((await transition(redis, SID, 'readyAfterProvisional', { provisionId: PID, attempt: 1 })).result).toBe('refused')
    await redis.hset(REC_, { status: 'creating_user', provisionalUntil: 0, 'cbSeen:1:ready': '' })
    expect((await transition(redis, SID, 'ready', { provisionId: PID, attempt: 1 })).result).toBe('applied')
    expect((await redis.hgetall<Record<string, unknown>>(REC_))!['cbSeen:1:ready']).toEqual(expect.any(String))
  })

  it('each status of an attempt applies once, in order; the next attempt starts fresh', async () => {
    const redis = new FakeRedis()
    await seedBuilding(redis)
    for (const status of ['provisioning', 'installing', 'creating_user', 'sending_email']) expect(await cb(redis, status)).toEqual({ updated: true })
    expect(await cb(redis, 'sending_email')).toEqual({ updated: false })
    // Attempt 2 (after a free retry) sends the same statuses again: they apply.
    await redis.hset(REC_, { status: 'triggered', attempt: 2 })
    expect(await handleProvisionCallback(bearer, { provision_id: PID, attempt: 2, status: 'installing' }, { provisionCallbackSecret: SECRET }, redis as never)).toEqual({ updated: true })
  })
})

// Code review round 2, R2-1: every refund-runner pass raises the record first; the intent row carries the floor too.
describe('R2-1: the intent row, refundTick and refundCancelStale raise the record to 72 h', () => {
  it.each(['intent', 'refundTick', 'refundCancelStale'] as const)('%s raises the record to KEEP_SECONDS', (name) => {
    expect(TRANSITIONS[name].build({ provisionId: PID, op: 'cancel', key: 'k', token: 't' }, 1794225600000, 'cs_test_floor').floor).toBe(KEEP_SECONDS)
  })
})

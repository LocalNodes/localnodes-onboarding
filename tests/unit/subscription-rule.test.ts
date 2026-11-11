// THE RULE (orchestrator, 2026-11-11, plan 23-43):
//
//   "A sign-up never leaves every sweep while its Stripe subscription can
//    still renew."
//
// Three review rounds each found a new corner of this one rule (C1, R2-1,
// R3-1). This file states it once and walks every lifecycle state in which a
// sign-up can carry a Stripe subscription. After every step it asserts that
// the sign-up is either in a sweep whose runner reaches the cancel, or the
// cancel is recorded done.
//
// How the terms are read here:
//   - "carries a subscription": subscriptionId or pendingSubscriptionId is set;
//   - "the cancel is recorded done": refundCancelled (the refund path's
//     cancel) or stopInvoice (the unpaid path's void and cancel,
//     retry-stop.ts voidAndCancel);
//   - "a sweep whose runner reaches the cancel":
//       sweep:billing   pays or gives up (held, declined), activates, or
//                       starts the refund when the 24 h window has passed;
//       sweep:held      voids and cancels when the hold runs out;
//       sweep:teardown  voids and cancels a declined sign-up;
//       sweep:refund    cancels on every pass (refund.ts continueRefund).
//     sweep:stops is not one: it serves failed builds, which carry nothing.
//   - A member only counts if CLEAR_INDEX_SCRIPT would keep it (INDEX_RULES),
//     because the sweeps drop members that script does not keep.
//
// Two kinds of state are outside the rule, each named in the table:
//   - delivered: status complete. The organizer has the site, and renewing is
//     the product.
//   - D3 (plan review round 1, ruled): billing rejected or in review on a
//     ready sign-up. A person decides, because cancelling there would be a
//     guess (two subscriptions, or a charge whose outcome is unknown). These
//     rows are marked `d3` and the test asserts the rule is NOT met there, so
//     a change to that ruling has to change this table too.
//
// The last test is the guard for new code: every row of TRANSITIONS must be
// walked by the table, or be shown unable to apply to a sign-up that carries
// a subscription, or be shown to touch neither the status nor any sweep.
import { describe, it, expect } from 'vitest'
import { FakeRedis } from './helpers/fake-redis'
import {
  BILLING_INDEX,
  BUILDING_STATES,
  HELD_INDEX,
  REFUND_INDEX,
  TEARDOWN_INDEX,
  TRANSITIONS,
  clearIndex,
  transition,
  type ClearableIndex,
  type TransitionName,
  type TransitionParams
} from '../../server/utils/lifecycle'

const SID = 'cs_test_rule'
const PID = 'RuLe000000000000000000'
const REC = `provision:${SID}`
const NOW = 1794225600000
const DAY = 86400000
const WEEK = 7 * DAY

const CANCEL_SWEEPS: Array<[ClearableIndex, string]> = [['billing', BILLING_INDEX], ['held', HELD_INDEX], ['teardown', TEARDOWN_INDEX], ['refund', REFUND_INDEX]]

type Step =
  /** One transition. `at` moves the clock forward first; `refused` is the expected answer; `d3` marks a state outside the rule by ruling D3. */
  | { row: TransitionName, params?: TransitionParams, at?: number, refused?: true, d3?: true }
  /** A field written by something other than a transition under test (named in `why`). */
  | { set: Record<string, unknown>, why: string }

const on = (v: unknown) => String(v ?? '') === 'true'
const filled = (v: unknown) => v !== undefined && v !== null && String(v) !== ''

async function seedReady(redis: FakeRedis) {
  await redis.set(`provision:by-id:${PID}`, SID, { ex: 259200 })
  await redis.hset(`signup:${PID}`, { email: 'organizer@example.org' })
  await redis.expire(`signup:${PID}`, 259200)
  await redis.hset(`dedupe:${PID}`, { checkoutSession: SID })
  await redis.expire(`dedupe:${PID}`, 2592000)
  await redis.hset(REC, { status: 'ready', provisionId: PID, attempt: 1, failedAttempts: 0, siteUrl: 'https://cascadia.localnodes.xyz', appUuid: 'app-1', readyAtMs: NOW, siteAnsweredAt: new Date(NOW).toISOString() })
  await redis.expire(REC, 259200)
  await redis.zadd(BILLING_INDEX, { score: NOW, member: SID })
}

/** The rule on the record as it stands: where it is kept, and whether that is enough. */
async function ruleState(redis: FakeRedis) {
  const state = (await redis.hgetall<Record<string, unknown>>(REC)) ?? {}
  const carries = filled(state.subscriptionId) || filled(state.pendingSubscriptionId)
  const cancelDone = on(state.refundCancelled) || on(state.stopInvoice)
  const sweeps: string[] = []
  for (const [index, key] of CANCEL_SWEEPS) {
    if ((await redis.zscore(key, SID)) === null) continue
    // The sweeps clear members through this script: a member it would drop does not count.
    await clearIndex(redis, SID, index)
    if ((await redis.zscore(key, SID)) !== null) sweeps.push(key)
  }
  const delivered = state.status === 'complete'
  return { state, carries, cancelDone, sweeps, delivered, met: !carries || cancelDone || sweeps.length > 0 || delivered }
}

const SUB = { subscriptionId: 'sub_1', invoiceId: 'in_1', subscriptionCreatedAt: 1 }
const PAID = { subscriptionId: 'sub_1', invoiceId: 'in_1', amountPaid: 4900, currency: 'usd' }
const charged: Step[] = [{ row: 'charging' }, { row: 'pendingSubscription', params: SUB }]
const paid: Step[] = [...charged, { row: 'paid', params: PAID }]
const refunding: Step[] = [...paid, { row: 'refunding', at: DAY + 1000 }]
const held: Step[] = [...charged, { row: 'held', params: { heldUntil: NOW + DAY } }]
const voided: Step = { row: 'teardownStep', params: { flag: 'stopInvoice' } }

const TABLE: Array<[string, Step[]]> = [
  ['a charge that keeps erroring stays in sweep:billing', [...charged, { row: 'pending', params: { due: NOW + 60000 } }, { row: 'unclear', params: { due: NOW + 120000, unclearTries: 0 } }, { row: 'pending', params: { due: NOW + 180000 } }]],
  ['D3: billing rejected with a subscription made waits for a person', [...charged, { row: 'rejected', params: { billingError: 'invalid' }, d3: true }]],
  ['D3: an idempotency mismatch is rejected and flagged', [...charged, { row: 'rejected', params: { billingError: 'invalid', flag: 'idempotency_mismatch' }, d3: true }]],
  ['D3: several subscriptions go to review', [...charged, { row: 'review', params: { kind: 'multiple_subscriptions' }, d3: true }]],
  ['D3: the third unclear outcome goes to review', [...charged, { row: 'unclear', params: { unclearTries: 0 } }, { row: 'unclear', params: { unclearTries: 1 } }, { row: 'review', params: { kind: 'stripe_unclear', unclearTries: 2 }, d3: true }]],
  ['D3: the tenth try is rejected', [...charged, { set: { billingTries: 9 }, why: 'nine pending outcomes before' }, { row: 'triesExhausted', d3: true }]],
  ['a 3DS hold that runs out is voided, cancelled and torn down', [...held, { row: 'heldUntilBad' }, voided, { row: 'tearingDownHeldExpired' }, { row: 'teardownStep', params: { flag: 'stopHold' } }, { row: 'stopFinished', params: {} }, { row: 'tornDown', params: { result: 'deleted', removedMailDue: true } }, { row: 'removedMailSent' }]],
  ['a held sign-up paid at the last moment is handed back to billing', [...held, { row: 'handBack', params: PAID }, { row: 'activationTry', params: { due: NOW + 60000 } }, { row: 'complete' }]],
  ['a held sign-up that is paid', [...held, { row: 'paid', params: PAID }]],
  ['a declined sign-up is voided, cancelled and torn down, a refused delete included', [...held, { row: 'declined' }, voided, { row: 'tearingDownDeclined' }, { row: 'teardownProblem', params: { result: 'failed' } }, { row: 'stopFinished', params: {} }, { row: 'tornDown', params: { result: 'deleted' } }]],
  ['a declined sign-up paid before the void is handed back', [...charged, { row: 'declined' }, { row: 'handBack', params: PAID }]],
  ['a paid sign-up waits in sweep:billing until it is activated', [...paid, { row: 'activationTry', params: { due: NOW + 60000 } }, { row: 'complete' }]],
  ['the refund, cancel first: refunded and torn down', [...refunding, { row: 'refundCancelled' }, { row: 'refundSucceeded', params: { refundId: 're_1' } }, { row: 'refunded' }, { row: 'tearingDownActivationFailed' }, { row: 'lateActivation', params: { opId: '' } }, { row: 'stopFinished', params: {} }, { row: 'tornDown', params: { result: 'deleted' } }]],
  ['the refund with a cancel that keeps failing: pending, stale, succeeded, flagged, then cancelled', [
    ...refunding,
    { row: 'refundPending', params: { refundId: 're_1', due: NOW + DAY + 61000 } },
    { row: 'refundPendingStale', at: WEEK },
    { row: 'refundSucceeded', params: { refundId: 're_1' } },
    { row: 'refunded', refused: true },
    { row: 'refundCancelStale' },
    { row: 'refundCancelled' },
    { row: 'refunded' }
  ]],
  ['R3-1: a refund problem with the cancel not done stays in sweep:refund until the cancel is done', [
    ...refunding,
    { row: 'refundProblem', params: { kind: 'partial', refundId: 're_1' } },
    { row: 'refundCancelStale', params: { problem: true } },
    { row: 'refundProblemSettled', refused: true },
    { row: 'refundCancelled' },
    { row: 'refundProblemSettled' }
  ]],
  ['a refund problem after the cancel leaves sweep:refund with the cancel done', [...refunding, { row: 'refundCancelled' }, { row: 'refundProblem', params: { kind: 'failed', refundId: 're_1' } }, { row: 'refundProblemSettled' }]],
  ['a zero invoice whose late activation is kept (ruling (a)) is delivered', [...charged, { row: 'paid', params: { ...PAID, amountPaid: 0 } }, { row: 'refunding', at: DAY + 1000 }, { row: 'refundZero' }, { row: 'lateActivation', params: { opId: '' } }, { row: 'keepLateActivation', params: { undone: 'none', mail: 'none' } }]],
  ['a zero invoice kept after its cancel is delivered', [...charged, { row: 'paid', params: { ...PAID, amountPaid: 0 } }, { row: 'refunding', at: DAY + 1000 }, { row: 'refundCancelled' }, { row: 'refundZero' }, { row: 'lateActivation', params: { opId: '' } }, { row: 'keepLateActivation', params: { undone: 'cancel', mail: 'none' } }]],
  ['a zero invoice not kept is torn down after its cancel', [...charged, { row: 'paid', params: { ...PAID, amountPaid: 0 } }, { row: 'refunding', at: DAY + 1000 }, { row: 'refundZero' }, { row: 'refunded', refused: true }, { row: 'refundCancelled' }, { row: 'refunded' }, { row: 'tearingDownActivationFailed' }]]
]

/** Rows that cannot apply to a sign-up that carries a subscription (checked below). */
const NO_SUBSCRIPTION: TransitionName[] = ['progress', 'ready', 'readyAfterProvisional', 'provisional', 'retry', 'dispatched', 'probeTry', 'siteNeverAnswered', 'tearingDownBuildFailed']
/** Rows that touch neither the status nor any sweep (checked below), with params their build accepts. */
const NEUTRAL: Array<[TransitionName, TransitionParams]> = [
  ['intent', { op: 'cancel', key: 'cancel:sub_1', token: 't' }],
  ['clearIntent', { token: 't' }],
  ['siteAnswered', {}],
  ['refundInvoice', { invoiceId: 'in_1', amountPaid: 4900, currency: 'usd' }],
  ['refundTick', {}],
  ['teardownResult', { result: 'failed' }],
  ['flag', { kind: 'late_activation' }],
  ['paymentRecorded', { eventId: 'evt_1', invoiceId: 'in_1', amount: 4900 }]
]

describe('the rule: a sign-up never leaves every sweep while its Stripe subscription can still renew', () => {
  it.each(TABLE)('%s', async (_name, steps) => {
    const redis = new FakeRedis()
    await seedReady(redis)
    let now = NOW
    for (const [i, step] of steps.entries()) {
      const label = 'row' in step ? `step ${i + 1}, ${step.row}` : `step ${i + 1}, ${step.why}`
      if ('set' in step) {
        await redis.hset(REC, step.set)
      } else {
        now += step.at ?? 1000
        const out = await transition(redis, SID, step.row, { provisionId: PID, now, ...step.params })
        expect(out.result, label).toBe(step.refused ? 'refused' : 'applied')
      }
      const rule = await ruleState(redis)
      if ('row' in step && step.d3) {
        // Outside the rule by ruling D3: pinned, so a change to the ruling changes this table.
        expect(rule.state, label).toMatchObject({ status: 'ready' })
        expect(['rejected', 'review'], label).toContain(rule.state.billing)
        expect({ carries: rule.carries, cancelDone: rule.cancelDone, sweeps: rule.sweeps }, label).toEqual({ carries: true, cancelDone: false, sweeps: [] })
      } else {
        expect(rule.met, `${label}: status ${String(rule.state.status)}, carries ${rule.carries}, cancel done ${rule.cancelDone}, sweeps [${rule.sweeps.join(', ')}]`).toBe(true)
      }
    }
  })

  it('every lifecycle step is in the table, or cannot apply to a sign-up that carries a subscription, or touches no status and no sweep', async () => {
    const walked = new Set<string>(TABLE.flatMap(([, steps]) => steps.flatMap(s => ('row' in s ? [s.row] : []))))
    const all = Object.keys(TRANSITIONS).sort()
    const sorted = [...new Set([...walked, ...NO_SUBSCRIPTION, ...NEUTRAL.map(([name]) => name)])].sort()
    expect(sorted).toEqual(all)

    const preReady: readonly string[] = [...BUILDING_STATES, 'failed']
    const carriers: Array<Record<string, unknown>> = [
      { status: 'ready', billing: 'pending', pendingSubscriptionId: 'sub_1', invoiceId: 'in_1' },
      { status: 'ready', billing: 'paid', subscriptionId: 'sub_1', invoiceId: 'in_1' },
      { status: 'failed', failedAttempts: 2, billing: 'paid', subscriptionId: 'sub_1', invoiceId: 'in_1' }
    ]
    for (const name of NO_SUBSCRIPTION) {
      const row = TRANSITIONS[name]
      for (const carrier of carriers) {
        if (!(row.from as readonly string[]).includes(String(carrier.status))) continue
        const redis = new FakeRedis()
        await seedReady(redis)
        await redis.hset(REC, carrier)
        const out = await transition(redis, SID, name, { provisionId: PID, now: NOW + 2 * DAY, attempt: 1, siteUrl: 'https://cascadia.localnodes.xyz', appUuid: 'app-1', githubRunId: 1, githubRunUrl: 'https://github.com/x/y/actions/runs/1', provisionalUntil: NOW + 3 * DAY, reason: 'deploy_failed', due: NOW })
        expect(out.result, `${name} on ${JSON.stringify(carrier)}`).toBe('refused')
      }
      // A row no carrier above can test must be limited to the build, before any subscription exists.
      if (!carriers.some(c => (row.from as readonly string[]).includes(String(c.status)))) {
        expect((row.from as readonly string[]).every(st => preReady.includes(st)), `${name} starts only from the build`).toBe(true)
      }
    }
    for (const [name, params] of NEUTRAL) {
      const spec = TRANSITIONS[name].build({ provisionId: PID, ...params }, NOW, SID)
      expect(spec.zrem ?? [], `${name} removes no sweep member`).toEqual([])
      expect((spec.zadd ?? []).filter(([index]) => index !== 'flags'), `${name} adds no sweep member`).toEqual([])
      expect((spec.set as Record<string, unknown> | undefined)?.status, `${name} writes no status`).toBeUndefined()
    }
  })
})

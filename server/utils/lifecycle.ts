// The sign-up lifecycle (Phase 23, plan 23-43; review HIGHs 3 to 8, the
// escalation's points 1 and 2, review round 1 D1 and Codex 1, 6 and 9, review
// round 2 H1 and the replay MEDIUM). Plain module, everything injected, as
// billing.ts: tests import it directly.
//
// One authority: the `status` field of provision:{sid}. The server-only
// states (tearing_down, torn_down, refunding, refunded) are values of it, not
// a second field, and every change of it is one named transition (TRANSITIONS
// below), a Lua step that checks the status and guards it expects and writes
// the record, its sweep index membership and its key lifetimes together.
// Terminal states exclude each other (Task 2): tearing_down is entered only
// through a guarded tearingDown step and left only for torn_down; no charge
// row names either, and a paid sign-up comes back from held or declined only
// through handBack, before anything is undone.
//
// One lock: provision:{sid}:lifecycle (withLifecycleLock), taken by billing,
// the stop and teardown, the held step and every QStash step. SET NX PX 60 s
// with a random token, renewed every 15 s by one renewal at a time, released
// by compare-and-delete. The build lock provision:{sid}:lock ("a build is
// running") is a different thing and stays. The lease keeps its own deadline
// on a monotonic clock (performance.now, never the wall clock): the send time
// of the SET or of the last renewal that answered 1, plus 60 s. No remote call
// starts with less than LEASE_MARGIN_MS (20 s) left, and the margin is larger
// than every call timeout below (asserted in a test).
//
// Intents (D1). Before each remote mutation a fenced transition writes
// intentOp, intentKey, intentToken and intentAt. A result is applied only
// while intentToken is still this lease's (applyResult); a stale one is logged
// as a fixed line and dropped, and the next holder reconciles from the intent
// before anything else. What Redis cannot fence: a call already in flight when
// the lease ends (Stripe or the site may still complete it; the intent is how
// the next holder finds out), and a Drupal activation already running inside
// the site (Tom's accepted straggler, recorded as lateActivation in Task 6).
//
// Validate, then write (review round 1, Codex 1). A Lua script is isolated but
// has no rollback, so every script checks every key type, count, number,
// score and counter before its first write; one that cannot apply writes
// nothing and answers invalid. Each transition carries an op id stored as
// lastOpId: a re-run after a lost EVAL reply answers replayed and writes
// nothing (review round 2), even for a step that keeps its status (pending's
// billingTries). The record keeps one op id (lastOpId): it guards the
// immediate re-run of the same step after a lost reply, not a history; a
// replay of an older op after a newer one has applied is not recognised by it.
// The build callbacks, which run without the lifecycle lease, carry their own
// key for that (code review fix round 1, C5): cbSeen:{attempt}:{status},
// checked and written inside the step, so a callback that already applied is
// refused whatever was written since. A transition never recreates an expired record, and a key
// lifetime is only ever raised, never lowered.
//
// Twins. FakeRedis has no Lua engine, so each script has a JS twin that runs
// synchronously over the same store (atomic inside the event loop, as Lua is
// inside Redis). Twins can drift from the Lua: tests/unit/lifecycle-lua.test.ts
// runs every script against a throwaway local Redis beside its twin, and
// 23-22's dry run runs every script first on Upstash (flat ARGV, no cjson,
// every key declared, multi-key calls across record keys and the global sweep
// indexes, which are not one cluster slot) before any real sign-up.
//
// Remote calls. Every call to Stripe, a community site, GitHub or Resend made
// under the lifecycle lease has one total deadline (withDeadline): an
// AbortController whose signal goes to the transport, and a race against the
// same deadline, so a connect that never completes and a body that trickles in
// both end at the call's timeout (review round 2, H1). Stripe's RequestOptions
// has no signal (stripe-node 20.4.0), so the deadline reaches the transport
// another way (code review fix round 1, C3): stripeCall runs the call inside
// withStripeSignal, and the Stripe client is built on stripe-node's own
// createFetchHttpClient with a fetch that joins that signal
// (stripe-deadline.ts). The deadline aborts the connect and the body read, and
// the race still bounds the call. The call also carries timeout
// STRIPE_TIMEOUT_MS with maxNetworkRetries 0. A call that hits its deadline has an unknown outcome
// at Stripe or the site, never a cancelled one: the intent record written
// before it lets the next lease holder reconcile from what Stripe or the site
// now says.
import { withStripeSignal } from './stripe-deadline'

export const LIFECYCLE_LOCK_MS = 60000
export const LIFECYCLE_RENEW_MS = 15000
/** No remote call starts with less than this left on the lease; larger than every call timeout below (D1, asserted in a test). */
export const LEASE_MARGIN_MS = 20000
export const STRIPE_TIMEOUT_MS = 15000
export const PROBE_TIMEOUT_MS = 10000
export const DISPATCH_TIMEOUT_MS = 15000
export const MAIL_TIMEOUT_MS = 15000

/** A remote call that ran out of time. The message carries no id. */
export class DeadlineError extends Error {
  constructor(ms: number) {
    super(`lifecycle: remote call passed its ${ms} ms deadline`)
    this.name = 'DeadlineError'
  }
}

/**
 * Run one remote call under one total deadline: the signal handed to `work`
 * aborts at `ms`, and the call is raced against the same deadline, so work
 * that ignores the signal (a body read, a Stripe SDK call) still ends there.
 * The timer is cleared when the work settles first.
 */
export async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new DeadlineError(ms)
      controller.abort(err)
      reject(err)
    }, ms)
  })
  try {
    return await Promise.race([work(controller.signal), expired])
  } finally {
    clearTimeout(timer)
  }
}

/** The request options every Stripe call under the lease carries (stripe-node RequestOptions). */
export interface StripeCallOptions {
  timeout: number
  maxNetworkRetries: 0
}

export const stripeOptions = (): StripeCallOptions => ({ timeout: STRIPE_TIMEOUT_MS, maxNetworkRetries: 0 })

/**
 * One Stripe call: the options above, under one total deadline (STRIPE_TIMEOUT_MS
 * unless a test gives another). The deadline's signal is handed to the
 * transport through withStripeSignal (C3), so the request itself is aborted,
 * not only no longer awaited.
 */
export function stripeCall<T>(call: (opts: StripeCallOptions) => Promise<T>, ms: number = STRIPE_TIMEOUT_MS): Promise<T> {
  return withDeadline(ms, signal => withStripeSignal(signal, () => call(stripeOptions())))
}

// --- keys, states and indexes ---------------------------------------------------

/** Every status a sign-up can hold. The last four are server-only (never sent by a site, never shown as such). */
export const LIFECYCLE_STATES = [
  'triggered', 'provisioning', 'installing', 'creating_user', 'sending_email',
  'ready', 'held', 'declined', 'complete', 'failed',
  'tearing_down', 'torn_down', 'refunding', 'refunded'
] as const
export type LifecycleState = (typeof LIFECYCLE_STATES)[number]

/** The build is still running: the only statuses a progress callback moves between. */
export const BUILDING_STATES = ['triggered', 'provisioning', 'installing', 'creating_user', 'sending_email'] as const

export const BILLING_INDEX = 'sweep:billing'
export const HELD_INDEX = 'sweep:held'
export const TEARDOWN_INDEX = 'sweep:teardown'
export const STOPS_INDEX = 'sweep:stops'
export const REFUND_INDEX = 'sweep:refund'
export const RECONCILE_FLAGS = 'reconcile:flags'

/**
 * What a reconcile:flags entry can say (23-21 reads them). A member is
 * {kind}:{sid}, scored by when it was raised; the sign-up's own record says
 * the rest. Task 2 raises paid_after_void, held_until_bad and
 * teardown_refused_or_failed; Tasks 3 and 6 the others. paid_in_review (the
 * orchestrator's addition to Task 6) is one entry per skipped invoice.paid
 * event: {kind}:{sid}:{eventId}:{invoiceId}:{amount}, scored by the event's
 * own time (paymentRecorded below).
 */
export const FLAG_KINDS = [
  'site_never_answered', 'multiple_subscriptions', 'stripe_unclear', 'idempotency_mismatch',
  'refund_problem', 'refund_started', 'late_activation', 'held_until_bad',
  'teardown_refused_or_failed', 'paid_after_void', 'paid_in_review'
] as const
export type FlagKind = (typeof FLAG_KINDS)[number]
export const flagMember = (kind: FlagKind, sid: string) => `${kind}:${sid}`

/**
 * Orchestrator ruling (a) (23-43 Task 7): the teardown steps that may already
 * have run when a zero invoice's late activation is kept, in the order they
 * run, each with the record field that says it ran. The kept flag
 * (late_activation:{sid}:kept:mail_{sent|maybe|none}:{steps|none}) and
 * lateKeptAfter name them, so a person sees what to put back: a cancelled
 * subscription, a detached card, a reopened invite, a released room or a
 * forgotten AI key. Nothing is put back automatically.
 */
export const KEPT_STEPS = ['cancel', 'hold', 'lock', 'card', 'invite', 'capacity', 'aikey'] as const
export const KEPT_MAIL = ['sent', 'maybe', 'none'] as const
const KEPT_FIELD: Record<(typeof KEPT_STEPS)[number], string> = {
  cancel: 'refundCancelled',
  hold: 'stopHold',
  lock: 'stopLock',
  card: 'stopCard',
  invite: 'stopInvite',
  capacity: 'stopCapacity',
  aikey: 'stopAiKey'
}

/** Why a sign-up is being torn down (teardownReason). activation_failed is Task 6's refund case. */
export const TEARDOWN_REASONS = ['build_failed', 'declined', 'held_expired', 'activation_failed'] as const
export type TeardownReason = (typeof TEARDOWN_REASONS)[number]

/** The teardown runner's done flags (retry-stop.ts runStop), one per step. */
export const STOP_FLAGS = ['stopInvoice', 'stopHold', 'stopLock', 'stopCard', 'stopInvite', 'stopMail', 'stopCapacity', 'stopAiKey', 'stopApp'] as const
export type StopFlag = (typeof STOP_FLAGS)[number]

/** A build or a callback keeps the record a day; held, declined, ready and paid keep all three keys 72 hours. */
export const PROVISION_TTL = 86400
export const KEEP_SECONDS = 259200

export const lifecycleLockKey = (sid: string) => `provision:${sid}:lifecycle`

/**
 * The de-duplication marker (23-43 Task 3, D3): dedupe:{provisionId}, a hash
 * kept 30 days, separate from the record (which lives 24 to 72 hours). It
 * holds checkoutSession (CREATE_SCRIPT, at checkout.session.completed),
 * subscriptionId (pendingSubscription, in the same step as the record),
 * invoiceId (paid, handBack) and refundId (Task 6). Only CREATE_SCRIPT makes
 * it; a transition writes to it only while it exists, so no transition can
 * leave a marker with no lifetime.
 */
export const DEDUPE_SECONDS = 2592000
export const dedupeKey = (provisionId: string) => `dedupe:${provisionId}`

/** Billing that only a person moves again (D3): rejected, or review. No charge, resume, nudge or invoice.paid acts on it. */
export const BILLING_STOPPED = ['rejected', 'review'] as const
export const billingStopped = (billing: unknown) => (BILLING_STOPPED as readonly string[]).includes(String(billing ?? ''))

/**
 * 23-43 Task 6. A paid sign-up's activation is retried for this long after
 * paidAt (activationDeadline = paidAt + this, a number the refunding guard
 * reads); then the QStash billing step starts the automatic full refund (Tom,
 * 2026-11-09).
 */
export const ACTIVATION_WINDOW_MS = 86400000
/** A ready site that never answers the probe within this long of readyAtMs is flagged for a person (Q-probe-24h): nothing charged, nothing deleted. */
export const PROBE_WINDOW_MS = 86400000
/**
 * A refund still pending or requires_action this long after the refund started
 * (refundingAtMs) is flagged for a person (refundPendingStale, code review fix
 * round 1, C1): 7 days. It stays refunding, polled, and its keys raised.
 */
export const REFUND_PENDING_LIMIT_MS = 7 * 86400000

/**
 * Billing waits for a person: rejected or review (D3), or a site that never
 * answered the probe within 24 hours (23-43 Task 6, Q-probe-24h). No charge,
 * resume, nudge or repeated ready acts on it.
 */
export const billingWaits = (state: Record<string, unknown> | null | undefined) =>
  billingStopped(state?.billing) || String(state?.siteNeverAnswered ?? '') === 'true'

/** billingTries (every pending and unclear outcome) stops at this many: billing rejected, billingError tries. */
export const BILLING_MAX_TRIES = 10
/** A replayed stored Stripe error with nothing to adopt, this many times: billing review, stripe_unclear (D3). */
export const UNCLEAR_MAX_TRIES = 3

/** Stands in for a key a record without a provision id does not have; no script ever touches it. */
export const PLACEHOLDER_KEY = 'lifecycle:none'

/** The index KEYS slots of TRANSITION_SCRIPT (1-based, as Lua counts). */
const INDEX_SLOT = {
  billing: 5,
  held: 6,
  teardown: 7,
  stops: 8,
  refund: 9,
  flags: 10
} as const
export type IndexName = keyof typeof INDEX_SLOT

/** Every key a transition may touch, all declared (Upstash rejects an undeclared key; review round 1). */
export function transitionKeys(sid: string, provisionId?: string): string[] {
  const pid = provisionId ?? ''
  return [
    `provision:${sid}`,
    pid ? `provision:by-id:${pid}` : PLACEHOLDER_KEY,
    pid ? `signup:${pid}` : PLACEHOLDER_KEY,
    lifecycleLockKey(sid),
    BILLING_INDEX,
    HELD_INDEX,
    TEARDOWN_INDEX,
    STOPS_INDEX,
    REFUND_INDEX,
    RECONCILE_FLAGS,
    pid ? `dedupe:${pid}` : PLACEHOLDER_KEY
  ]
}

// --- the synchronous view the twins run on ----------------------------------------

/**
 * What a twin may do, synchronously, over raw stored strings (as Lua sees
 * them). FakeRedis implements it; a twin never awaits, so it is atomic inside
 * the event loop as a script is inside Redis.
 */
export interface AtomicView {
  type: (key: string) => 'none' | 'string' | 'hash' | 'zset'
  exists: (key: string) => 0 | 1
  get: (key: string) => string | null
  set: (key: string, value: string, opts: { nx?: boolean, ex?: number, px?: number }) => boolean
  del: (key: string) => number
  hget: (key: string, field: string) => string | null
  hset: (key: string, pairs: Array<[string, string]>) => void
  hincrby: (key: string, field: string, by: number) => number
  zadd: (key: string, score: number, member: string) => void
  zrem: (key: string, member: string) => number
  pttl: (key: string) => number
  pexpire: (key: string, ms: number) => number
}

export type ScriptTwin = (r: AtomicView, keys: string[], args: string[]) => string | number

/** The number formats every script accepts, the same in Lua and in the twins: no exponent, no sign but minus, no spaces. */
const INT_RE = /^-?\d+$/
const NUM_RE = /^-?\d+\.?\d*$/
const isInt = (v: unknown): v is string => typeof v === 'string' && INT_RE.test(v)
const isNum = (v: unknown): v is string => typeof v === 'string' && NUM_RE.test(v)

// --- guards ---------------------------------------------------------------------

/**
 * One condition on a record field: eq, ne, empty, set, nottrue (string tests),
 * lt, le, gt, ge (numbers; missing or empty is 0), or notboth (code review fix
 * round 1, C2): holds unless the field and the field named by the value are
 * both 'true'. Guards are ANDed; notboth is the one "not (A and B)".
 */
export type GuardOp = 'eq' | 'ne' | 'empty' | 'set' | 'nottrue' | 'lt' | 'le' | 'gt' | 'ge' | 'notboth'
export type Guard = [field: string, op: GuardOp, value?: string | number]
const GUARD_OPS = new Set<string>(['eq', 'ne', 'empty', 'set', 'nottrue', 'lt', 'le', 'gt', 'ge', 'notboth'])
const NUMERIC_OPS = new Set<string>(['lt', 'le', 'gt', 'ge'])

/** The Lua side of the guards: validation (first) and evaluation, shared by the scripts below. */
const LUA_COMMON = `
local PH = '${PLACEHOLDER_KEY}'
local function isint(v) return type(v) == 'string' and string.match(v, '^%-?%d+$') ~= nil end
local function isnum(v) return type(v) == 'string' and string.match(v, '^%-?%d+%.?%d*$') ~= nil end
local function ktype(k) return redis.call('TYPE', k)['ok'] end
local OPS = {eq=true, ne=true, empty=true, set=true, nottrue=true, lt=true, le=true, gt=true, ge=true, notboth=true}
local NUMOPS = {lt=true, le=true, gt=true, ge=true}
local function guardvalid(key, g)
  if not OPS[g[2]] or g[1] == '' then return false end
  if g[2] == 'notboth' and (not g[3] or g[3] == '') then return false end
  if NUMOPS[g[2]] then
    if not isnum(g[3]) then return false end
    local cur = redis.call('HGET', key, g[1])
    if cur and cur ~= '' and not isnum(cur) then return false end
  end
  return true
end
local function guardholds(key, g)
  local cur = redis.call('HGET', key, g[1])
  if not cur then cur = '' end
  local op = g[2]
  if op == 'eq' then return cur == g[3] end
  if op == 'ne' then return cur ~= g[3] end
  if op == 'empty' then return cur == '' end
  if op == 'set' then return cur ~= '' end
  if op == 'nottrue' then return cur ~= 'true' end
  if op == 'notboth' then return not (cur == 'true' and redis.call('HGET', key, g[3]) == 'true') end
  local a = 0
  if cur ~= '' then a = tonumber(cur) end
  local b = tonumber(g[3])
  if op == 'lt' then return a < b end
  if op == 'le' then return a <= b end
  if op == 'gt' then return a > b end
  return a >= b
end
local function raisefloor(keys, floorms)
  if floorms <= 0 then return end
  for _, k in ipairs(keys) do
    if k ~= PH then
      local p = redis.call('PTTL', k)
      if p > 0 and p < floorms then redis.call('PEXPIRE', k, floorms) end
    end
  end
end
`

function guardValid(r: AtomicView, key: string, g: [string, string, string]): boolean {
  if (!GUARD_OPS.has(g[1]) || g[0] === '') return false
  if (g[1] === 'notboth' && (g[2] === undefined || g[2] === '')) return false
  if (NUMERIC_OPS.has(g[1])) {
    if (!isNum(g[2])) return false
    const cur = r.hget(key, g[0])
    if (cur !== null && cur !== '' && !isNum(cur)) return false
  }
  return true
}

function guardHolds(r: AtomicView, key: string, g: [string, string, string]): boolean {
  const cur = r.hget(key, g[0]) ?? ''
  const op = g[1]
  if (op === 'eq') return cur === g[2]
  if (op === 'ne') return cur !== g[2]
  if (op === 'empty') return cur === ''
  if (op === 'set') return cur !== ''
  if (op === 'nottrue') return cur !== 'true'
  if (op === 'notboth') return !(cur === 'true' && r.hget(key, g[2]) === 'true')
  const a = cur === '' ? 0 : Number(cur)
  const b = Number(g[2])
  if (op === 'lt') return a < b
  if (op === 'le') return a <= b
  if (op === 'gt') return a > b
  return a >= b
}

function raiseFloor(r: AtomicView, keys: string[], floorMs: number): void {
  if (floorMs <= 0) return
  keys.filter(k => k !== PLACEHOLDER_KEY).forEach((k) => {
    const p = r.pttl(k)
    if (p > 0 && p < floorMs) r.pexpire(k, floorMs)
  })
}

// --- TRANSITION_SCRIPT ------------------------------------------------------------

/**
 * One change of a sign-up's state, all or nothing (review round 1, Codex 1:
 * a script has no rollback, so it validates everything before its first
 * write). KEYS: transitionKeys (11, all declared). ARGV, flat, no cjson:
 *   now, opId, fence,
 *   nFrom, from..., nGuards, (field, op, value)..., nSet, (field, value)...,
 *   nIfEmpty, (field, value)..., nSignup, (field, value)..., nDedupe, (field, value)...,
 *   incrField, incrBy,
 *   nZadd, (slot, score, member)..., nZrem, (slot, member)..., floorSeconds.
 * Order: validate (key types, counts, numbers, scores, counters, guard
 * fields); a missing record is refused (a transition never recreates one);
 * an op id equal to the record's lastOpId answers replayed (review round 2:
 * a re-run after a lost reply is a no-op even when the status stays); a fence
 * whose lock holds another value answers lost; a status outside the from-set
 * or a false guard is refused; only then the writes: the record, lastOpId,
 * fields-if-empty, the signup fields (only on an existing signup), the
 * dedupe marker fields (only on an existing marker, whose own 30-day lifetime
 * is left as it is), the counter, the index adds and removes, and the lifetime floor (raised, never
 * lowered, only on keys that exist with a positive PTTL).
 * Answers applied, replayed, lost, refused:<status> or invalid:<why>.
 */
export const TRANSITION_SCRIPT = `${LUA_COMMON}
local A = ARGV
local i = 1
local over = false
local function nxt()
  local v = A[i]
  i = i + 1
  if v == nil then over = true; return '' end
  return v
end
local function cnt()
  local v = nxt()
  if not isint(v) or tonumber(v) < 0 then over = true; return 0 end
  return tonumber(v)
end
local WANT = {'hash', 'string', 'hash', 'string', 'zset', 'zset', 'zset', 'zset', 'zset', 'zset', 'hash'}
if #KEYS ~= 11 or KEYS[1] == PH or KEYS[4] == PH then return 'invalid:keys' end
for k = 1, 11 do
  if KEYS[k] ~= PH then
    local t = ktype(KEYS[k])
    if t ~= 'none' and t ~= WANT[k] then return 'invalid:type' end
  end
end
local now = nxt()
local opId = nxt()
local fence = nxt()
local from = {}
local n = cnt()
for _ = 1, n do from[nxt()] = true end
local guards = {}
n = cnt()
for _ = 1, n do guards[#guards + 1] = {nxt(), nxt(), nxt()} end
local sets = {}
n = cnt()
for _ = 1, n do sets[#sets + 1] = {nxt(), nxt()} end
local empties = {}
n = cnt()
for _ = 1, n do empties[#empties + 1] = {nxt(), nxt()} end
local sups = {}
n = cnt()
for _ = 1, n do sups[#sups + 1] = {nxt(), nxt()} end
local deds = {}
n = cnt()
for _ = 1, n do deds[#deds + 1] = {nxt(), nxt()} end
local incrField = nxt()
local incrBy = nxt()
local adds = {}
n = cnt()
for _ = 1, n do adds[#adds + 1] = {nxt(), nxt(), nxt()} end
local rems = {}
n = cnt()
for _ = 1, n do rems[#rems + 1] = {nxt(), nxt()} end
local floor = nxt()
if over or i - 1 ~= #A then return 'invalid:argv' end
if not isint(now) or not isint(floor) or tonumber(floor) < 0 then return 'invalid:number' end
for _, g in ipairs(guards) do
  if not guardvalid(KEYS[1], g) then return 'invalid:guard' end
end
for _, p in ipairs(sets) do if p[1] == '' then return 'invalid:field' end end
for _, p in ipairs(empties) do if p[1] == '' then return 'invalid:field' end end
for _, p in ipairs(sups) do if p[1] == '' then return 'invalid:field' end end
for _, p in ipairs(deds) do if p[1] == '' then return 'invalid:field' end end
if incrField ~= '' then
  if not isint(incrBy) then return 'invalid:counter' end
  local cur = redis.call('HGET', KEYS[1], incrField)
  if cur and not isint(cur) then return 'invalid:counter' end
end
for _, a in ipairs(adds) do
  if not isint(a[1]) or tonumber(a[1]) < 5 or tonumber(a[1]) > 10 then return 'invalid:slot' end
  if not isnum(a[2]) then return 'invalid:score' end
  if a[3] == '' then return 'invalid:member' end
end
for _, z in ipairs(rems) do
  if not isint(z[1]) or tonumber(z[1]) < 5 or tonumber(z[1]) > 10 then return 'invalid:slot' end
  if z[2] == '' then return 'invalid:member' end
end
if redis.call('EXISTS', KEYS[1]) == 0 then return 'refused:none' end
if opId ~= '' and redis.call('HGET', KEYS[1], 'lastOpId') == opId then return 'replayed' end
if fence ~= '' and redis.call('GET', KEYS[4]) ~= fence then return 'lost' end
local status = redis.call('HGET', KEYS[1], 'status')
if not status then status = '' end
if not from[status] then return 'refused:' .. status end
for _, g in ipairs(guards) do
  if not guardholds(KEYS[1], g) then return 'refused:' .. status end
end
local hs = {}
for _, p in ipairs(sets) do hs[#hs + 1] = p[1]; hs[#hs + 1] = p[2] end
if opId ~= '' then hs[#hs + 1] = 'lastOpId'; hs[#hs + 1] = opId end
if #hs > 0 then redis.call('HSET', KEYS[1], unpack(hs)) end
for _, p in ipairs(empties) do
  local cur = redis.call('HGET', KEYS[1], p[1])
  if not cur or cur == '' then redis.call('HSET', KEYS[1], p[1], p[2]) end
end
if #sups > 0 and KEYS[3] ~= PH and redis.call('EXISTS', KEYS[3]) == 1 then
  local ss = {}
  for _, p in ipairs(sups) do ss[#ss + 1] = p[1]; ss[#ss + 1] = p[2] end
  redis.call('HSET', KEYS[3], unpack(ss))
end
if #deds > 0 and KEYS[11] ~= PH and redis.call('EXISTS', KEYS[11]) == 1 then
  local ds = {}
  for _, p in ipairs(deds) do ds[#ds + 1] = p[1]; ds[#ds + 1] = p[2] end
  redis.call('HSET', KEYS[11], unpack(ds))
end
if incrField ~= '' then redis.call('HINCRBY', KEYS[1], incrField, incrBy) end
for _, a in ipairs(adds) do redis.call('ZADD', KEYS[tonumber(a[1])], a[2], a[3]) end
for _, z in ipairs(rems) do redis.call('ZREM', KEYS[tonumber(z[1])], z[2]) end
raisefloor({KEYS[1], KEYS[2], KEYS[3]}, tonumber(floor) * 1000)
return 'applied'
`

/** TRANSITION_SCRIPT, step for step, over the synchronous view (see AtomicView). Validates first, never rolls back. */
export const transitionTwin: ScriptTwin = (r, KEYS, A) => {
  let i = 0
  let over = false
  const nxt = () => {
    const v = A[i]
    i++
    if (v === undefined) {
      over = true
      return ''
    }
    return v
  }
  const cnt = () => {
    const v = nxt()
    if (!isInt(v) || Number(v) < 0) {
      over = true
      return 0
    }
    return Number(v)
  }
  const WANT = ['hash', 'string', 'hash', 'string', 'zset', 'zset', 'zset', 'zset', 'zset', 'zset', 'hash']
  if (KEYS.length !== 11 || KEYS[0] === PLACEHOLDER_KEY || KEYS[3] === PLACEHOLDER_KEY) return 'invalid:keys'
  for (let k = 0; k < 11; k++) {
    if (KEYS[k] !== PLACEHOLDER_KEY) {
      const t = r.type(KEYS[k]!)
      if (t !== 'none' && t !== WANT[k]) return 'invalid:type'
    }
  }
  const now = nxt()
  const opId = nxt()
  const fence = nxt()
  const from = new Set<string>()
  let n = cnt()
  for (let j = 0; j < n; j++) from.add(nxt())
  const guards: Array<[string, string, string]> = []
  n = cnt()
  for (let j = 0; j < n; j++) guards.push([nxt(), nxt(), nxt()])
  const pairs = () => {
    const out: Array<[string, string]> = []
    const m = cnt()
    for (let j = 0; j < m; j++) out.push([nxt(), nxt()])
    return out
  }
  const sets = pairs()
  const empties = pairs()
  const sups = pairs()
  const deds = pairs()
  const incrField = nxt()
  const incrBy = nxt()
  const adds: Array<[string, string, string]> = []
  n = cnt()
  for (let j = 0; j < n; j++) adds.push([nxt(), nxt(), nxt()])
  const rems: Array<[string, string]> = []
  n = cnt()
  for (let j = 0; j < n; j++) rems.push([nxt(), nxt()])
  const floor = nxt()
  if (over || i !== A.length) return 'invalid:argv'
  if (!isInt(now) || !isInt(floor) || Number(floor) < 0) return 'invalid:number'
  if (!guards.every(g => guardValid(r, KEYS[0]!, g))) return 'invalid:guard'
  if ([...sets, ...empties, ...sups, ...deds].some(p => p[0] === '')) return 'invalid:field'
  if (incrField !== '') {
    if (!isInt(incrBy)) return 'invalid:counter'
    const cur = r.hget(KEYS[0]!, incrField)
    if (cur !== null && !isInt(cur)) return 'invalid:counter'
  }
  const slotOk = (s: string) => isInt(s) && Number(s) >= 5 && Number(s) <= 10
  for (const a of adds) {
    if (!slotOk(a[0])) return 'invalid:slot'
    if (!isNum(a[1])) return 'invalid:score'
    if (a[2] === '') return 'invalid:member'
  }
  for (const z of rems) {
    if (!slotOk(z[0])) return 'invalid:slot'
    if (z[1] === '') return 'invalid:member'
  }
  if (r.exists(KEYS[0]!) === 0) return 'refused:none'
  if (opId !== '' && r.hget(KEYS[0]!, 'lastOpId') === opId) return 'replayed'
  if (fence !== '' && r.get(KEYS[3]!) !== fence) return 'lost'
  const status = r.hget(KEYS[0]!, 'status') ?? ''
  if (!from.has(status)) return `refused:${status}`
  if (!guards.every(g => guardHolds(r, KEYS[0]!, g))) return `refused:${status}`
  const hs: Array<[string, string]> = [...sets]
  if (opId !== '') hs.push(['lastOpId', opId])
  if (hs.length > 0) r.hset(KEYS[0]!, hs)
  empties.forEach(([f, v]) => {
    const cur = r.hget(KEYS[0]!, f)
    if (cur === null || cur === '') r.hset(KEYS[0]!, [[f, v]])
  })
  if (sups.length > 0 && KEYS[2] !== PLACEHOLDER_KEY && r.exists(KEYS[2]!) === 1) r.hset(KEYS[2]!, sups)
  if (deds.length > 0 && KEYS[10] !== PLACEHOLDER_KEY && r.exists(KEYS[10]!) === 1) r.hset(KEYS[10]!, deds)
  if (incrField !== '') r.hincrby(KEYS[0]!, incrField, Number(incrBy))
  adds.forEach(([slot, score, member]) => r.zadd(KEYS[Number(slot) - 1]!, Number(score), member))
  rems.forEach(([slot, member]) => r.zrem(KEYS[Number(slot) - 1]!, member))
  raiseFloor(r, [KEYS[0]!, KEYS[1]!, KEYS[2]!], Number(floor) * 1000)
  return 'applied'
}

// --- the transition table -----------------------------------------------------------

/** Two failed builds stop a sign-up (retry-stop.ts MAX_FAILURES). */
const MAX_FAILURES = 2

const CLEARED_INTENT = { intentOp: '', intentKey: '', intentToken: '', intentAt: '' }

type FieldValue = string | number | boolean
type Fields = Record<string, FieldValue | undefined>

/** What one transition does, given its parameters. */
export interface TransitionSpec {
  guards?: Guard[]
  set?: Fields
  ifEmpty?: Fields
  signup?: Fields
  /** Fields on dedupe:{provisionId}, written only while the marker exists. */
  dedupe?: Fields
  incr?: [field: string, by: number]
  zadd?: Array<[index: IndexName, score: number, member?: string]>
  zrem?: Array<[index: IndexName, member?: string]>
  /** Seconds: each record key that exists with a lower positive lifetime is raised to this. */
  floor?: number
}

/** The parameters a caller gives a transition (the row reads what it needs). */
export interface TransitionParams {
  provisionId?: string
  /** Generated when absent; reused on the one re-run after a lost reply. */
  opId?: string
  /** Wall clock, ms (persisted timestamps). */
  now?: number
  /** Extra guards (applyResult adds the intent token guard). */
  guards?: Guard[]
  /** Clear the intent fields in the same step (applyResult). */
  clearIntent?: boolean
  [key: string]: unknown
}

export interface TransitionRow {
  from: readonly string[]
  build: (p: TransitionParams, now: number, sid: string) => TransitionSpec
}

const iso = (ms: number) => new Date(ms).toISOString()
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const attemptGuards = (p: TransitionParams): Guard[] => [
  ['attempt', 'le', Number(p.attempt)],
  ['countedAttempt', 'lt', Number(p.attempt)],
  ['stopped', 'nottrue']
]
/** No money has moved: no billing state, no invoice, no subscription. */
const unpaidGuards: Guard[] = [
  ['billing', 'empty'],
  ['invoiceId', 'empty'],
  ['pendingSubscriptionId', 'empty'],
  ['subscriptionId', 'empty']
]
const notPaid: Guard = ['billing', 'ne', 'paid']
/**
 * C5 (code review fix round 1): the per-callback key of a build callback, one
 * record field per attempt and status. The step is refused when it is already
 * set and writes it when it applies, so a callback re-run after a lost reply,
 * or redelivered, never applies twice, even after another callback wrote in
 * between (one lastOpId slot cannot tell that apart).
 */
const callbackSeen = (attempt: unknown, status: string) => `cbSeen:${s(attempt)}:${status}`

export const TRANSITIONS = {
  // A build progress callback: only between building statuses, for this attempt, with no window open.
  // HIGH 6: a late callback can never move a ready, paid or complete sign-up.
  progress: {
    from: BUILDING_STATES,
    build: (p, now) => ({
      guards: [...attemptGuards(p), ['provisionalUntil', 'le', 0], [callbackSeen(p.attempt, s(p.status)), 'empty']],
      set: { status: s(p.status), siteUrl: p.siteUrl as string | undefined, reason: p.reason as string | undefined, appUuid: p.appUuid as string | undefined, updatedAt: iso(now), [callbackSeen(p.attempt, s(p.status))]: iso(now) },
      floor: PROVISION_TTL
    })
  },
  // ready: from a building status; readyAt written once; all three keys raised to 72 h (the 24 h probe window).
  ready: {
    from: BUILDING_STATES,
    build: (p, now) => ({
      guards: [...attemptGuards(p), ['provisionalUntil', 'le', 0], [callbackSeen(p.attempt, 'ready'), 'empty']],
      set: { status: 'ready', siteUrl: p.siteUrl as string | undefined, appUuid: p.appUuid as string | undefined, updatedAt: iso(now), [callbackSeen(p.attempt, 'ready')]: iso(now) },
      ifEmpty: { readyAt: iso(now), readyAtMs: now },
      zadd: [['billing', now]],
      floor: KEEP_SECONDS
    })
  },
  // ready over a site's own provisional failed of this attempt: the window closes, ready wins (23-14).
  readyAfterProvisional: {
    from: ['failed'],
    build: (p, now) => ({
      guards: [...attemptGuards(p), ['provisionalUntil', 'gt', 0], [callbackSeen(p.attempt, 'ready'), 'empty']],
      set: { status: 'ready', provisionalUntil: 0, reason: '', siteUrl: p.siteUrl as string | undefined, appUuid: p.appUuid as string | undefined, updatedAt: iso(now), [callbackSeen(p.attempt, 'ready')]: iso(now) },
      ifEmpty: { readyAt: iso(now), readyAtMs: now },
      zadd: [['billing', now]],
      zrem: [['stops']],
      floor: KEEP_SECONDS
    })
  },
  // A site's own failed: provisional for 10 minutes; the sweep settles it. HIGH 6: never on a sign-up past the build.
  provisional: {
    from: BUILDING_STATES,
    build: (p, now) => ({
      guards: [...attemptGuards(p), ['provisionalUntil', 'le', 0], ...unpaidGuards],
      set: { status: 'failed', reason: s(p.reason) || 'unknown', appUuid: p.appUuid as string | undefined, provisionalUntil: Number(p.provisionalUntil), canRetry: false, updatedAt: iso(now) },
      zadd: [['stops', Number(p.provisionalUntil)]],
      floor: PROVISION_TTL
    })
  },
  // The free retry: failed with canRetry becomes triggered, attempt plus one, in one step (two retries, one dispatch).
  retry: {
    from: ['failed'],
    build: (p, now) => ({
      guards: [['canRetry', 'eq', 'true'], ['failedAttempts', 'lt', 2], ['stopped', 'nottrue'], ['attempt', 'eq', Number(p.attempt)], ...unpaidGuards],
      set: { status: 'triggered', canRetry: false, reason: '', updatedAt: iso(now) },
      incr: ['attempt', 1],
      floor: PROVISION_TTL
    })
  },
  dispatched: {
    from: ['triggered'],
    build: (p, now) => ({
      guards: [['attempt', 'eq', Number(p.attempt)]],
      set: { status: 'provisioning', githubRunId: p.githubRunId as number, githubRunUrl: s(p.githubRunUrl), updatedAt: iso(now) },
      floor: PROVISION_TTL
    })
  },
  // D1: written (fenced) before each remote mutation; the result is applied only under the same token.
  // A mail or dispatch intent also leaves a mark that clearing the intent does not remove
  // (orchestrator ruling (a)): once the delete may have been asked for, a late activation never
  // keeps the site, and a mail that may have gone out is recorded when it does.
  // Code review fix round 1, C2: the dispatch intent is the one decision between keep and delete.
  // It refuses while lateActivation is set on a zero-charge (refundZero) sign-up, in the same step
  // that would write dispatchAskedAt, so a late 200 landing after the runner's last check can no
  // longer be deleted; the runner then keeps the site (retry-stop.ts runStop). A real payment's
  // late 200 (no refundZero) never stops the delete.
  // Code review round 2, R2-2: notboth decides the FIRST dispatch only. A retry of a dispatch
  // already recorded (p.retry, guarded here by dispatchAskedAt set) goes through: the keep is
  // refused once the delete may have been asked for, so refusing the retry too left the stop stuck.
  // The late_activation flag, raised with the field, is how a person learns to reach out (ruling (a)).
  // R2-1: every intent raises the record to 72 h (raise-only), so a pass that only writes intents
  // (a cancel failing again and again) still keeps a refunding record alive.
  intent: {
    from: LIFECYCLE_STATES,
    build: (p, now) => ({
      guards: p.op === 'dispatch'
        ? (p.retry === true ? [['dispatchAskedAt', 'set']] : [['lateActivation', 'notboth', 'refundZero']])
        : undefined,
      floor: KEEP_SECONDS,
      set: {
        intentOp: s(p.op),
        intentKey: s(p.key),
        intentToken: s(p.token),
        intentAt: iso(now),
        mailAskedAt: p.op === 'mail' ? iso(now) : undefined,
        dispatchAskedAt: p.op === 'dispatch' ? iso(now) : undefined
      }
    })
  },
  // The next holder clears a foreign intent once it has reconciled from it.
  clearIntent: {
    from: LIFECYCLE_STATES,
    build: p => ({
      guards: [['intentToken', 'eq', s(p.token)]],
      set: CLEARED_INTENT
    })
  },
  // The Stripe attempt counters start at 1 here and are never changed by any row (D3): only a
  // person advances one (the 23-21 runbook, Q-attempt-advance).
  // 23-43 Task 6: no Stripe call before the site's own 401 to the probe (siteAnsweredAt), and none
  // once the 24 h probe window ran out (siteNeverAnswered). The Lua is the authority here, not only billing.ts.
  charging: {
    from: ['ready'],
    build: (_p, now) => ({ guards: [['billing', 'empty'], ['siteAnsweredAt', 'set'], ['siteNeverAnswered', 'nottrue']], set: { billing: 'charging', updatedAt: iso(now) }, ifEmpty: { subscribeAttempt: 1, payAttempt: 1 } })
  },
  // The probe (23-43 Task 6): the site's first 401 {"error":"unauthorized"}, written once, fields only.
  siteAnswered: {
    from: ['ready'],
    build: (_p, now) => ({ guards: [['siteAnsweredAt', 'empty'], ['siteNeverAnswered', 'nottrue']], set: { siteAnsweredAt: iso(now) } })
  },
  // Not yet: probeTries plus one, due again a minute later. Never once billing started.
  probeTry: {
    from: ['ready'],
    build: (p, now) => ({
      guards: [['siteAnsweredAt', 'empty'], ['siteNeverAnswered', 'nottrue'], ['billing', 'empty']],
      incr: ['probeTries', 1],
      zadd: [['billing', Number(p.due ?? now)]]
    })
  },
  // No answer within PROBE_WINDOW_MS of readyAtMs (Q-probe-24h): flagged for a person, out of sweep:billing.
  // Nothing is charged and nothing is torn down; no charge, resume or nudge acts on it again.
  siteNeverAnswered: {
    from: ['ready'],
    build: (_p, now, sid) => ({
      guards: [['siteAnsweredAt', 'empty'], ['siteNeverAnswered', 'nottrue'], ['billing', 'empty'], ['readyAtMs', 'set'], ['readyAtMs', 'le', now - PROBE_WINDOW_MS]],
      set: { siteNeverAnswered: true, updatedAt: iso(now) },
      zadd: [['flags', now, flagMember('site_never_answered', sid)]],
      zrem: [['billing']],
      floor: KEEP_SECONDS
    })
  },
  // The subscription id lands on the record and on the 30-day marker in one step (D3).
  pendingSubscription: {
    from: ['ready'],
    build: p => ({
      guards: [notPaid, ['pendingSubscriptionId', 'empty']],
      set: { pendingSubscriptionId: s(p.subscriptionId), invoiceId: s(p.invoiceId), subscriptionCreatedAt: Number(p.subscriptionCreatedAt) },
      dedupe: { subscriptionId: s(p.subscriptionId) }
    })
  },
  // Same status, a counter: the op id makes a re-run after a lost reply a no-op (review round 2).
  // The tenth outcome is triesExhausted's, never pending's (the guard below).
  pending: {
    from: ['ready'],
    build: (p, now) => ({
      guards: [notPaid, ['billing', 'ne', 'rejected'], ['billing', 'ne', 'review'], ['billingTries', 'lt', BILLING_MAX_TRIES - 1]],
      set: { billing: 'pending', billingError: 'api', updatedAt: iso(now) },
      incr: ['billingTries', 1],
      zadd: [['billing', Number(p.due ?? now)]]
    })
  },
  // Billing rejected; with `flag` (idempotency_mismatch) the reconcile:flags entry lands in the same step.
  rejected: {
    from: ['ready'],
    build: (p, now, sid) => {
      const flag = p.flag === undefined ? '' : s(p.flag)
      if (flag && !(FLAG_KINDS as readonly string[]).includes(flag)) throw new Error('lifecycle: unknown flag')
      return {
        guards: [notPaid],
        set: { billing: 'rejected', billingError: s(p.billingError), updatedAt: iso(now) },
        zadd: flag ? [['flags', now, flagMember(flag as FlagKind, sid)]] : undefined,
        zrem: [['billing']]
      }
    }
  },
  // D3: a replayed stored Stripe error with nothing to adopt. Never read as "no effect": the key
  // stays, the attempt never advances, unclearTries and billingTries go up, due again later. The
  // caller passes the unclearTries it read (a compare-and-set); the third is review's.
  unclear: {
    from: ['ready'],
    build: (p, now) => {
      const n = Number(p.unclearTries ?? 0)
      return {
        guards: [notPaid, ['billing', 'ne', 'rejected'], ['billing', 'ne', 'review'], ['unclearTries', 'ge', n], ['unclearTries', 'le', n], ['unclearTries', 'lt', UNCLEAR_MAX_TRIES - 1], ['billingTries', 'lt', BILLING_MAX_TRIES - 1]],
        set: { billing: 'pending', billingError: 'unclear', unclearTries: n + 1, updatedAt: iso(now) },
        incr: ['billingTries', 1],
        zadd: [['billing', Number(p.due ?? now)]]
      }
    }
  },
  // D3: billing stops for a person, in one step: several subscriptions carry this provision id
  // (multiple_subscriptions), or the third unclear outcome (stripe_unclear, counted, with the
  // unclearTries the caller read as a compare-and-set). Out of sweep:billing, one flag. Nothing
  // charges, nudges or resumes a sign-up in billing review.
  review: {
    from: ['ready'],
    build: (p, now, sid) => {
      const kind = s(p.kind)
      if (kind !== 'multiple_subscriptions' && kind !== 'stripe_unclear') throw new Error('lifecycle: unknown review kind')
      const counted = p.unclearTries !== undefined
      const n = Number(p.unclearTries ?? 0)
      return {
        guards: [notPaid, ['billing', 'ne', 'rejected'], ['billing', 'ne', 'review'], ...(counted ? [['unclearTries', 'ge', n], ['unclearTries', 'le', n]] as Guard[] : [])],
        set: { billing: 'review', billingError: kind, unclearTries: counted ? n + 1 : undefined, updatedAt: iso(now) },
        incr: counted ? ['billingTries', 1] : undefined,
        zadd: [['flags', now, flagMember(kind, sid)]],
        zrem: [['billing']],
        floor: KEEP_SECONDS
      }
    }
  },
  // The billingTries cap (point 6): the tenth pending or unclear outcome rejects (billingError
  // tries), leaves sweep:billing and is flagged stripe_unclear (the same runbook step: a person
  // checks Stripe, then adopts or advances).
  triesExhausted: {
    from: ['ready'],
    build: (_p, now, sid) => ({
      guards: [notPaid, ['billing', 'ne', 'rejected'], ['billing', 'ne', 'review'], ['billingTries', 'ge', BILLING_MAX_TRIES - 1]],
      set: { billing: 'rejected', billingError: 'tries', updatedAt: iso(now) },
      incr: ['billingTries', 1],
      zadd: [['flags', now, flagMember('stripe_unclear', sid)]],
      zrem: [['billing']],
      floor: KEEP_SECONDS
    })
  },
  // HIGH 7: held, its link, its sweep:held member and its removal from sweep:billing land together, or not at all.
  held: {
    from: ['ready'],
    build: (p, now) => ({
      guards: [notPaid],
      set: { status: 'held', billing: 'held', billingError: '', heldUntil: Number(p.heldUntil), heldAt: iso(now), updatedAt: iso(now) },
      signup: p.hostedInvoiceUrl ? { hostedInvoiceUrl: s(p.hostedInvoiceUrl) } : undefined,
      zadd: [['held', Number(p.heldUntil)]],
      zrem: [['billing']],
      floor: KEEP_SECONDS
    })
  },
  declined: {
    from: ['ready', 'held'],
    build: (_p, now) => ({
      guards: [notPaid],
      set: { status: 'declined', billing: 'declined', billingError: '', teardownReason: 'declined', declinedAt: iso(now), updatedAt: iso(now) },
      zadd: [['teardown', now]],
      zrem: [['billing'], ['held']],
      floor: KEEP_SECONDS
    })
  },
  // Codex 3: the paid record keeps the invoice id, the amount and the currency.
  paid: {
    from: ['ready', 'held'],
    build: (p, now) => ({
      guards: [notPaid],
      set: {
        status: 'ready',
        subscriptionId: s(p.subscriptionId),
        billing: 'paid',
        billingError: '',
        paidAt: iso(now),
        invoiceId: p.invoiceId ? s(p.invoiceId) : undefined,
        amountPaid: p.amountPaid === undefined ? undefined : Number(p.amountPaid),
        currency: p.currency ? s(p.currency) : undefined,
        activationDeadline: now + ACTIVATION_WINDOW_MS,
        updatedAt: iso(now)
      },
      dedupe: p.invoiceId ? { invoiceId: s(p.invoiceId) } : undefined,
      zadd: [['billing', now]],
      zrem: [['held']],
      floor: KEEP_SECONDS
    })
  },
  // One activation try that did not activate: counted, due again later. No try cap (23-43 Task 6):
  // the window (activationDeadline) ends the tries, and the billing step then starts the refund.
  activationTry: {
    from: ['ready'],
    build: p => ({
      guards: [['billing', 'eq', 'paid'], ['activatedAt', 'empty']],
      incr: ['activationTries', 1],
      zadd: [['billing', Number(p.due)]]
    })
  },
  complete: {
    from: ['ready'],
    build: (_p, now) => ({
      guards: [['billing', 'eq', 'paid'], ['activatedAt', 'empty']],
      set: { status: 'complete', activatedAt: iso(now), updatedAt: iso(now) },
      zrem: [['billing']],
      floor: PROVISION_TTL
    })
  },

  // --- Task 6: the automatic full refund (Tom's ruling 2026-11-09; review round 1 D2 and Codex 3) ---
  // The state table, each state with one sweep index kept by its transitions:
  //   ready, paid, past the window      sweep:billing (the billing step starts the refund)
  //   refunding (any sub-step)          sweep:refund
  //   refunding, pending past 7 days    sweep:refund and reconcile:flags (refund_problem:{sid}:pending)
  //   refunding with refundProblem      reconcile:flags (a person); sweep:refund until the cancel is
  //                                     done (R3-1: cancel-only passes), then no sweep
  //   refunded                          sweep:refund, until tearingDownActivationFailed moves it
  //   tearing_down, activation_failed   sweep:teardown
  // complete's from-set stays ready only: nothing from refunding on can ever be completed.
  // Code review fix round 1, C1: every row below that writes a refunding record raises its three
  // keys to 72 h (floor KEEP_SECONDS; raised, never lowered), so a refund pending at Stripe for days
  // keeps its record while the refunds step polls it; and the cancel (refundCancelled) runs when
  // the refund starts, before the refund itself, so a slow refund can never let the subscription renew.

  // Step 2: from ready, billing paid, never activated, the 24 h window passed (activationDeadline).
  refunding: {
    from: ['ready'],
    build: (_p, now, sid) => ({
      guards: [['billing', 'eq', 'paid'], ['activatedAt', 'empty'], ['activationDeadline', 'set'], ['activationDeadline', 'le', now]],
      set: { status: 'refunding', teardownReason: 'activation_failed', refundingAt: iso(now), refundingAtMs: now, updatedAt: iso(now) },
      zadd: [['refund', now], ['flags', now, flagMember('refund_started', sid)]],
      zrem: [['billing']],
      floor: KEEP_SECONDS
    })
  },
  // A record without its invoice data recovers it from the subscription's latest invoice (Codex 3).
  refundInvoice: {
    from: ['refunding'],
    build: p => ({
      guards: [['refundProblem', 'empty']],
      set: {
        invoiceId: p.invoiceId ? s(p.invoiceId) : undefined,
        amountPaid: p.amountPaid === undefined ? undefined : Number(p.amountPaid),
        currency: p.currency ? s(p.currency) : undefined
      },
      dedupe: p.invoiceId ? { invoiceId: s(p.invoiceId) } : undefined,
      floor: KEEP_SECONDS
    })
  },
  // D2: only a refund that is succeeded, for exactly the amount paid, in the invoice's currency and
  // on this payment (refund.ts checks all four before it asks for this step).
  refundSucceeded: {
    from: ['refunding'],
    build: (p, now) => ({
      guards: [['refundProblem', 'empty'], ['activatedAt', 'empty']],
      set: { refundId: s(p.refundId), refundStatus: 'succeeded', refundSucceededAt: iso(now), refundDone: true, updatedAt: iso(now) },
      dedupe: { refundId: s(p.refundId) },
      floor: KEEP_SECONDS
    })
  },
  // A pending or requires_action refund: still refunding; the refunds step polls it later. Each poll
  // raises the three keys to 72 h again (C1), so the record outlives a refund pending for days.
  refundPending: {
    from: ['refunding'],
    build: (p, now) => ({
      guards: [['refundProblem', 'empty'], ['refundDone', 'nottrue']],
      set: { refundId: s(p.refundId), refundStatus: s(p.refundStatus) || 'pending', updatedAt: iso(now) },
      dedupe: { refundId: s(p.refundId) },
      zadd: [['refund', Number(p.due ?? now)]],
      floor: KEEP_SECONDS
    })
  },
  // R2-1: the first write of every refund-runner pass, before any remote call: the three keys raised
  // to 72 h, nothing else, so no failure later in the pass (a cancel or a poll that errors) can let
  // the record run out.
  // R3-2 (the last confirming pass): with p.due the same write moves the sign-up to the back of
  // sweep:refund. The refunds step reads the oldest due members up to a limit, so a sign-up that is
  // served must fall behind the ones not yet served, or enough stuck ones would keep the rest from
  // ever getting a pass. Never for a settled refund problem (refundSettledAt): that one has left the
  // sweep and is not put back; the caller then ticks without a due time.
  refundTick: {
    from: ['refunding', 'refunded'],
    build: p => (p.due === undefined
      ? { floor: KEEP_SECONDS }
      : { guards: [['refundSettledAt', 'empty']], zadd: [['refund', Number(p.due)]], floor: KEEP_SECONDS })
  },
  // R2-1: a cancel still not done REFUND_PENDING_LIMIT_MS (7 days) after the refunding step, or not
  // done when the refund itself needs a person (p.now: the refund problem path): one reconcile:flags
  // entry, refund_problem:{sid}:cancel, raised once (refundCancelStaleAt). The cancel is still
  // retried on every pass while the record is refunding, a refund problem included (R3-1).
  refundCancelStale: {
    from: ['refunding'],
    build: (p, now, sid) => ({
      guards: [
        ['refundCancelled', 'nottrue'], ['refundCancelStaleAt', 'empty'],
        ...(p.problem === true ? [['refundProblem', 'set']] as Guard[] : [['refundingAtMs', 'set'], ['refundingAtMs', 'le', now - REFUND_PENDING_LIMIT_MS]] as Guard[])
      ],
      set: { refundCancelStaleAt: iso(now) },
      zadd: [['flags', now, `${flagMember('refund_problem', sid)}:cancel`]],
      floor: KEEP_SECONDS
    })
  },
  // C1: a refund still pending REFUND_PENDING_LIMIT_MS (7 days) after the refunding step: one
  // reconcile:flags entry for a person (refund_problem:{sid}:pending, scored when raised, once:
  // refundStaleAt), nothing else. It stays refunding and in sweep:refund, so it is still polled,
  // its keys still raised, and a refund that then succeeds still finishes on its own.
  refundPendingStale: {
    from: ['refunding'],
    build: (_p, now, sid) => ({
      guards: [['refundProblem', 'empty'], ['refundDone', 'nottrue'], ['refundStaleAt', 'empty'], ['refundingAtMs', 'set'], ['refundingAtMs', 'le', now - REFUND_PENDING_LIMIT_MS]],
      set: { refundStaleAt: iso(now) },
      zadd: [['flags', now, `${flagMember('refund_problem', sid)}:pending`]],
      floor: KEEP_SECONDS
    })
  },
  // A failed or canceled refund, one for less than paid, another currency or payment, or two refunds:
  // a person decides. No refunded state, no mail, no teardown, never a second refund.
  // R3-1 (the confirming pass, 2026-11-11): this row no longer leaves sweep:refund. A sign-up never
  // leaves every sweep while its Stripe subscription can still renew, and the cancel may not be
  // done yet (R2-1 lets the refund go first when the cancel fails). The refunds step keeps raising
  // the record and retrying the cancel only; refundProblemSettled is the one way out of the sweep.
  refundProblem: {
    from: ['refunding'],
    build: (p, now, sid) => ({
      guards: [['refundDone', 'nottrue']],
      set: { refundProblem: s(p.kind) || 'unknown', refundId: p.refundId ? s(p.refundId) : undefined, refundProblemAt: iso(now), updatedAt: iso(now) },
      zadd: [['flags', now, flagMember('refund_problem', sid)]],
      floor: KEEP_SECONDS
    })
  },
  // R3-1: a refund problem whose cancel is recorded done leaves sweep:refund, once. The guards are
  // the rule: without refundCancelled this is refused and the sign-up stays in the sweep.
  refundProblemSettled: {
    from: ['refunding'],
    build: (_p, now) => ({
      guards: [['refundProblem', 'set'], ['refundCancelled', 'eq', 'true'], ['refundSettledAt', 'empty']],
      set: { refundSettledAt: iso(now) },
      zrem: [['refund']],
      floor: KEEP_SECONDS
    })
  },
  // amount_paid 0 (a 100%-off pilot): nothing to refund, no refund call (Argon 3). The Stopped mail (P5).
  refundZero: {
    from: ['refunding'],
    build: (_p, now) => ({
      guards: [['refundProblem', 'empty'], ['activatedAt', 'empty']],
      set: { refundZero: true, refundDone: true, updatedAt: iso(now) },
      floor: KEEP_SECONDS
    })
  },
  // The cancel done: the subscription is cancelled (or was already). C1: this runs when the refund
  // starts, before the refund itself, so it no longer waits for refundDone (refunded still needs both).
  refundCancelled: {
    from: ['refunding'],
    build: () => ({ set: { refundCancelled: true }, floor: KEEP_SECONDS })
  },
  // Step 5: refunded only after D2's refund (or a zero invoice) and the cancel.
  refunded: {
    from: ['refunding'],
    build: (_p, now) => ({
      guards: [['refundDone', 'eq', 'true'], ['refundCancelled', 'eq', 'true'], ['refundProblem', 'empty'], ['activatedAt', 'empty']],
      set: { status: 'refunded', refundedAt: iso(now), updatedAt: iso(now) },
      zadd: [['refund', now]],
      floor: KEEP_SECONDS
    })
  },
  // Step 6's first write: the shared teardown runner (retry-stop.ts runStop) moves a refunded sign-up
  // to tearing_down, out of sweep:refund and into sweep:teardown in the same step.
  tearingDownActivationFailed: {
    from: ['refunded'],
    build: (_p, now) => ({
      guards: [['teardownReason', 'eq', 'activation_failed'], ['refundDone', 'eq', 'true'], ['refundProblem', 'empty'], ['activatedAt', 'empty']],
      set: { status: 'tearing_down', tearingDownAt: iso(now), updatedAt: iso(now) },
      zadd: [['teardown', now]],
      zrem: [['refund']],
      floor: KEEP_SECONDS
    })
  },
  // Q-straggler (accepted): a 200 {activated: true} seen after the refunding step (a request already
  // in flight). Run with op id '' and no fence by the stale runner that saw it: the field and the
  // flag only, nothing else changes. The mail and the page then say only "We've refunded your payment in full."
  lateActivation: {
    from: ['refunding', 'refunded', 'tearing_down', 'torn_down'],
    build: (_p, now, sid) => ({
      guards: [['teardownReason', 'eq', 'activation_failed']],
      set: { lateActivation: true },
      zadd: [['flags', now, flagMember('late_activation', sid)]]
    })
  },

  // Orchestrator ruling (a), 2026-11-09 (23-43 Task 7): a zero invoice (refundZero, a 100%-off
  // pilot) whose late activation landed before the delete was asked for keeps its site. The one
  // way from a refund state to complete, and only for a zero invoice: a refund of real money
  // never goes live (complete's own from-set stays ready only). Run fenced, under the lifecycle
  // lock, by whichever runner holds it (keepIfLateZero below). undone names the teardown steps
  // that already ran (KEPT_STEPS), mail whether the Stopped mail went out (sent), may have
  // (maybe: its intent was written) or did not (none); both are checked against the record and
  // written on it and on the kept flag, so a person can follow up.
  keepLateActivation: {
    from: ['refunding', 'refunded', 'tearing_down'],
    build: (p, now, sid) => {
      const undone = s(p.undone)
      const mail = s(p.mail)
      if (!/^(none|[a-z]+(,[a-z]+)*)$/.test(undone) || (undone !== 'none' && undone.split(',').some(w => !(KEPT_STEPS as readonly string[]).includes(w)))) {
        throw new Error('lifecycle: keepLateActivation needs known step names')
      }
      if (!(KEPT_MAIL as readonly string[]).includes(mail)) throw new Error('lifecycle: keepLateActivation needs a known mail word')
      const mailGuards: Guard[] = mail === 'sent'
        ? [['stopMail', 'eq', 'true']]
        : [['stopMail', 'nottrue'], ['mailAskedAt', mail === 'maybe' ? 'set' : 'empty']]
      return {
        guards: [
          ['teardownReason', 'eq', 'activation_failed'], ['refundZero', 'eq', 'true'], ['lateActivation', 'eq', 'true'],
          ['activatedAt', 'empty'], ['refundProblem', 'empty'], ['refundSucceededAt', 'empty'],
          ['stopApp', 'nottrue'], ['teardownDispatchedAt', 'empty'], ['dispatchAskedAt', 'empty'], ['intentOp', 'ne', 'dispatch'],
          ...mailGuards
        ],
        set: {
          status: 'complete',
          activatedAt: iso(now),
          lateKeptAt: iso(now),
          lateKeptAfter: undone,
          stoppedMail: mail === 'none' ? undefined : mail,
          updatedAt: iso(now)
        },
        zadd: [['flags', now, `${flagMember('late_activation', sid)}:kept:mail_${mail}:${undone}`]],
        zrem: [['refund'], ['teardown'], ['stops'], ['billing']],
        floor: KEEP_SECONDS
      }
    }
  },

  // --- Task 2: terminal states that exclude each other (escalation point 3; HIGHs 3 and 8) ---
  // tearing_down is entered before the delete is asked for and is left only for torn_down,
  // which the workflow's deleted or gone writes. No charge row names either (a test checks).

  // HIGH 3: a build that failed twice, with no money moved, and only from failed: a ready,
  // charging or complete sign-up is never approved for teardown, whatever its failure count.
  tearingDownBuildFailed: {
    from: ['failed'],
    build: (_p, now) => ({
      guards: [['failedAttempts', 'ge', MAX_FAILURES], ['stopped', 'nottrue'], ...unpaidGuards],
      set: { status: 'tearing_down', teardownReason: 'build_failed', canRetry: false, tearingDownAt: iso(now), updatedAt: iso(now) },
      zadd: [['teardown', now]],
      zrem: [['stops']],
      floor: KEEP_SECONDS
    })
  },
  // An unpaid first payment, right after its invoice is void (stopInvoice): the void is the
  // last moment a payment can still land; a paid invoice hands back instead.
  tearingDownDeclined: {
    from: ['declined'],
    build: (_p, now) => ({
      guards: [['teardownReason', 'eq', 'declined'], ['stopInvoice', 'eq', 'true'], ['subscriptionId', 'empty'], ['paidAt', 'empty'], notPaid],
      set: { status: 'tearing_down', tearingDownAt: iso(now), updatedAt: iso(now) },
      zadd: [['teardown', now]],
      zrem: [['billing'], ['held']],
      floor: KEEP_SECONDS
    })
  },
  // A 3DS hold that ran out, in the held step's lease, after the void (point 6: held decides under one lease).
  tearingDownHeldExpired: {
    from: ['held'],
    build: (_p, now) => ({
      guards: [['stopInvoice', 'eq', 'true'], ['subscriptionId', 'empty'], ['paidAt', 'empty'], notPaid],
      set: { status: 'tearing_down', billing: 'declined', billingError: '', teardownReason: 'held_expired', declinedAt: iso(now), tearingDownAt: iso(now), updatedAt: iso(now) },
      zadd: [['teardown', now]],
      zrem: [['held'], ['billing']],
      floor: KEEP_SECONDS
    })
  },
  // The workflow confirmed the app is gone (deleted or gone). Joins sweep:teardown so the
  // teardowns step finishes what follows (the removed mail a 3DS hold that ran out is owed).
  tornDown: {
    from: ['tearing_down'],
    build: (p, now) => ({
      set: {
        status: 'torn_down',
        teardownApp: p.result ? s(p.result) : undefined,
        teardownAppAt: p.result ? iso(now) : undefined,
        removedMailDue: p.removedMailDue === true ? true : undefined,
        tornDownAt: iso(now),
        updatedAt: iso(now)
      },
      zadd: [['teardown', now]],
      floor: KEEP_SECONDS
    })
  },
  // HIGH 8 and review round 1 Argon 1: an invoice paid at the last moment hands a held or
  // declined sign-up back to billing in one step, before anything is undone (stopInvoice not
  // set). The subscription is the pending one or, when empty, the webhook invoice's own.
  handBack: {
    from: ['held', 'declined'],
    build: (p, now) => {
      if (!p.subscriptionId) throw new Error('lifecycle: handBack needs a subscription')
      return {
        guards: [['stopInvoice', 'nottrue'], ['subscriptionId', 'empty'], notPaid],
        set: {
          status: 'ready',
          billing: 'paid',
          billingError: '',
          subscriptionId: s(p.subscriptionId),
          invoiceId: p.invoiceId ? s(p.invoiceId) : undefined,
          amountPaid: p.amountPaid === undefined ? undefined : Number(p.amountPaid),
          currency: p.currency ? s(p.currency) : undefined,
          paidAt: iso(now),
          activationDeadline: now + ACTIVATION_WINDOW_MS,
          teardownReason: '',
          updatedAt: iso(now)
        },
        dedupe: p.invoiceId ? { invoiceId: s(p.invoiceId) } : undefined,
        zadd: [['billing', now]],
        zrem: [['teardown'], ['held']],
        floor: KEEP_SECONDS
      }
    }
  },
  // One done flag of the teardown runner (and, for the app delete, when it was asked for).
  teardownStep: {
    from: ['declined', 'held', 'tearing_down', 'torn_down'],
    build: (p, now) => {
      const flag = s(p.flag)
      if (!(STOP_FLAGS as readonly string[]).includes(flag)) throw new Error('lifecycle: unknown teardown step')
      return { set: { [flag]: true, teardownDispatchedAt: p.dispatchedAt ? iso(Number(p.dispatchedAt)) : undefined } }
    }
  },
  // Every runner step ran: tornDown true (stopped too for a build that failed twice). A
  // record with no address to delete goes straight to torn_down. Lifetimes stay 72 h.
  stopFinished: {
    from: ['tearing_down', 'torn_down'],
    build: (p, now) => ({
      set: {
        tornDown: true,
        stopped: p.reason === 'build_failed' ? true : undefined,
        canRetry: false,
        status: p.noApp ? 'torn_down' : undefined,
        tornDownAt: p.noApp ? iso(now) : undefined,
        removedMailDue: p.noApp && p.removedMailDue === true ? true : undefined,
        updatedAt: iso(now)
      },
      zrem: [['stops']],
      floor: KEEP_SECONDS
    })
  },
  // The workflow's refused or failed on a sign-up being torn down: the word, its time, and a
  // reconcile:flags entry; the status stays tearing_down and a person decides (D-18).
  teardownProblem: {
    from: ['tearing_down'],
    build: (p, now, sid) => ({
      set: { teardownApp: s(p.result), teardownAppAt: iso(now) },
      zadd: [['flags', now, flagMember('teardown_refused_or_failed', sid)]]
    })
  },
  // Any result on a sign-up not being torn down: the word and its time only.
  teardownResult: {
    from: LIFECYCLE_STATES,
    build: (p, now) => ({ set: { teardownApp: s(p.result), teardownAppAt: iso(now) } })
  },
  // One reconcile:flags entry. With opId '' nothing is written on the record (invoice.paid on a voided sign-up).
  flag: {
    from: LIFECYCLE_STATES,
    build: (p, now, sid) => {
      const kind = s(p.kind)
      if (!(FLAG_KINDS as readonly string[]).includes(kind)) throw new Error('lifecycle: unknown flag')
      return { zadd: [['flags', now, flagMember(kind as FlagKind, sid)]] }
    }
  },
  // 23-43, the orchestrator's addition (judgement call 3): an invoice.paid skipped because billing
  // waits for a person (review, or rejected) is recorded, never dropped. One reconcile:flags entry
  // per event, paid_in_review:{sid}:{eventId}:{invoiceId}:{amount}, scored by the event's own time
  // (ms), so a redelivery writes the same member with the same score: nothing new. Run with op id
  // '' so the record is untouched. Each part is checked: no colon, no space, or '-' in its place.
  paymentRecorded: {
    from: LIFECYCLE_STATES,
    build: (p, now, sid) => {
      const part = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : '-')
      const amount = typeof p.amount === 'number' && Number.isInteger(p.amount) && p.amount >= 0 ? String(p.amount) : '-'
      const given = Number(p.eventAt)
      const at = Number.isFinite(given) && given > 0 ? given : now
      const member = `${flagMember('paid_in_review', sid)}:${part(p.eventId, /^evt_[A-Za-z0-9_.-]{1,250}$/)}:${part(p.invoiceId, /^in_[A-Za-z0-9_.-]{1,250}$/)}:${amount}`
      return { zadd: [['flags', Math.trunc(at), member]] }
    }
  },
  // A held sign-up whose heldUntil is missing or not a number (point 6): marked and flagged; it stays held.
  heldUntilBad: {
    from: ['held'],
    build: (_p, now, sid) => ({
      set: { heldUntilBad: true },
      zadd: [['flags', now, flagMember('held_until_bad', sid)]]
    })
  },
  // The removed mail went out after the delete was confirmed (P4): stopMail, nothing more owed.
  removedMailSent: {
    from: ['torn_down'],
    build: () => ({
      guards: [['removedMailDue', 'eq', 'true']],
      set: { stopMail: true, removedMailDue: '' }
    })
  }
} satisfies Record<string, TransitionRow>

export type TransitionName = keyof typeof TRANSITIONS

export type TransitionResult =
  | { result: 'applied' | 'replayed' | 'lost', status?: undefined }
  | { result: 'refused', status: string }
  | { result: 'invalid', why: string, status?: undefined }

/** Applied, or applied by an earlier run of the same op id. */
export const isApplied = (r: TransitionResult) => r.result === 'applied' || r.result === 'replayed'

/** The Upstash call a transition makes. */
export interface EvalRedis {
  eval: (script: string, keys: string[], args: unknown[]) => Promise<unknown>
}

/** Flatten a spec into TRANSITION_SCRIPT's ARGV. Undefined field values are left out. */
export function transitionArgs(spec: TransitionSpec & { from: readonly string[] }, sid: string, now: number, opId: string, fence: string): string[] {
  const out: string[] = [String(Math.trunc(now)), opId, fence]
  const pairs = (f?: Fields) => Object.entries(f ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)] as [string, string])
  out.push(String(spec.from.length), ...spec.from)
  const guards = spec.guards ?? []
  out.push(String(guards.length), ...guards.flatMap(([f, op, v]) => [f, op, v === undefined ? '' : String(v)]))
  for (const f of [spec.set, spec.ifEmpty, spec.signup, spec.dedupe]) {
    const p = pairs(f)
    out.push(String(p.length), ...p.flat())
  }
  out.push(spec.incr ? spec.incr[0] : '', spec.incr ? String(spec.incr[1]) : '')
  const adds = spec.zadd ?? []
  out.push(String(adds.length), ...adds.flatMap(([ix, score, member]) => [String(INDEX_SLOT[ix]), String(score), member ?? sid]))
  const rems = spec.zrem ?? []
  out.push(String(rems.length), ...rems.flatMap(([ix, member]) => [String(INDEX_SLOT[ix]), member ?? sid]))
  out.push(String(spec.floor ?? 0))
  return out
}

function parseResult(raw: unknown): TransitionResult {
  const text = String(raw)
  if (text === 'applied' || text === 'replayed' || text === 'lost') return { result: text }
  if (text.startsWith('refused:')) return { result: 'refused', status: text.slice('refused:'.length) }
  return { result: 'invalid', why: text.startsWith('invalid:') ? text.slice('invalid:'.length) : text }
}

/**
 * Run one named transition for a sign-up. With a lease the step is fenced:
 * it answers lost when the lock holds another token. The op id is made here
 * when not given; a throw from the eval (a lost reply) is retried once with
 * the same op id, so a step that did apply answers replayed and is never
 * applied twice. A second throw is raised.
 */
export async function transition(redis: EvalRedis, sid: string, name: TransitionName, params: TransitionParams = {}, lease?: { token: string }): Promise<TransitionResult> {
  const row: TransitionRow = TRANSITIONS[name]
  const now = params.now ?? Date.now()
  const built = row.build(params, now, sid)
  const spec = {
    ...built,
    from: row.from,
    guards: [...(built.guards ?? []), ...(params.guards ?? [])],
    set: params.clearIntent ? { ...built.set, ...CLEARED_INTENT } : built.set
  }
  const opId = params.opId ?? crypto.randomUUID()
  const keys = transitionKeys(sid, params.provisionId)
  const args = transitionArgs(spec, sid, now, opId, lease?.token ?? '')
  let raw: unknown
  try {
    raw = await redis.eval(TRANSITION_SCRIPT, keys, args)
  } catch {
    raw = await redis.eval(TRANSITION_SCRIPT, keys, args)
  }
  return parseResult(raw)
}


// --- COUNT_FAILURE_SCRIPT --------------------------------------------------------------


export function countFailureKeys(sid: string, provisionId: string | undefined, attempt: number): string[] {
  const pid = provisionId ?? ''
  return [
    `provision:${sid}`,
    pid ? `provision:by-id:${pid}` : PLACEHOLDER_KEY,
    pid ? `signup:${pid}` : PLACEHOLDER_KEY,
    `provision:${sid}:failed:${attempt}`,
    `provision:${sid}:lock`,
    STOPS_INDEX
  ]
}

export interface CountFailureParams {
  provisionId?: string
  attempt: number
  reason?: string
  appUuid?: string
  now?: number
  opId?: string
}

export function countFailureArgs(sid: string, p: CountFailureParams, now: number, opId: string): string[] {
  const statuses = [...BUILDING_STATES, 'failed']
  return [
    String(Math.trunc(now)), opId, sid, String(p.attempt), p.reason || 'unknown', p.appUuid ?? '', iso(now),
    String(PROVISION_TTL), String(MAX_FAILURES), String(PROVISION_TTL),
    String(statuses.length), ...statuses
  ]
}

/**
 * Count one failed build, once per attempt, in one step (23-14's countFailure,
 * made atomic; HIGH 6). KEYS: the record, by-id, signup, the claim
 * provision:{sid}:failed:{attempt}, the build lock provision:{sid}:lock and
 * sweep:stops. ARGV: now, opId, sid, attempt, reason, appUuid, updatedAt,
 * claimTtl, maxFailures, floorSeconds, nStatuses, statuses... Validate first;
 * then a missing record is refused, a replayed op id answers its count, and
 * the guard: the status is a building one or failed, no money has moved
 * (billing, invoiceId, pendingSubscriptionId, subscriptionId empty), not
 * stopped; a claim already there answers taken (a replay: the caller may
 * finish a stop cut short); this attempt not counted and not older than the
 * stored one. Then the claim (SET NX EX; taken: nothing more), HINCRBY failedAttempts, status
 * failed with the reason, canRetry (count below the max), the build lock
 * freed; at the max the sign-up joins sweep:stops (score now) so a crash
 * right after still leaves the stop to the sweep, below it leaves sweep:stops
 * (nothing is owed). Answers counted:<n>, replayed:<n>, taken,
 * refused:<status> or invalid:<why>.
 */
export const COUNT_FAILURE_SCRIPT = `${LUA_COMMON}
local A = ARGV
if #KEYS ~= 6 or KEYS[1] == PH then return 'invalid:keys' end
local WANT = {'hash', 'string', 'hash', 'string', 'string', 'zset'}
for k = 1, 6 do
  if KEYS[k] ~= PH then
    local t = ktype(KEYS[k])
    if t ~= 'none' and t ~= WANT[k] then return 'invalid:type' end
  end
end
if #A < 11 then return 'invalid:argv' end
local now, opId, sid, attempt, reason, app, at = A[1], A[2], A[3], A[4], A[5], A[6], A[7]
local claimTtl, maxF, floor, n = A[8], A[9], A[10], A[11]
if not isint(n) or #A ~= 11 + tonumber(n) then return 'invalid:argv' end
if not isint(now) or not isint(attempt) or tonumber(attempt) < 1 or not isint(claimTtl) or tonumber(claimTtl) < 1
  or not isint(maxF) or tonumber(maxF) < 1 or not isint(floor) or tonumber(floor) < 0 or sid == '' then
  return 'invalid:number'
end
local fa = redis.call('HGET', KEYS[1], 'failedAttempts')
if fa and fa ~= '' and not isint(fa) then return 'invalid:counter' end
for _, f in ipairs({'countedAttempt', 'attempt'}) do
  local v = redis.call('HGET', KEYS[1], f)
  if v and v ~= '' and not isnum(v) then return 'invalid:field' end
end
if redis.call('EXISTS', KEYS[1]) == 0 then return 'refused:none' end
if opId ~= '' and redis.call('HGET', KEYS[1], 'lastOpId') == opId then
  return 'replayed:' .. (redis.call('HGET', KEYS[1], 'failedAttempts') or '0')
end
local status = redis.call('HGET', KEYS[1], 'status') or ''
local ok = false
for j = 1, tonumber(n) do if A[11 + j] == status then ok = true end end
if not ok then return 'refused:' .. status end
local guards = {
  {'billing', 'empty', ''}, {'invoiceId', 'empty', ''}, {'pendingSubscriptionId', 'empty', ''},
  {'subscriptionId', 'empty', ''}, {'stopped', 'nottrue', ''}
}
for _, g in ipairs(guards) do
  if not guardholds(KEYS[1], g) then return 'refused:' .. status end
end
if redis.call('EXISTS', KEYS[4]) == 1 then return 'taken' end
for _, g in ipairs({{'countedAttempt', 'lt', attempt}, {'attempt', 'le', attempt}}) do
  if not guardholds(KEYS[1], g) then return 'refused:' .. status end
end
if not redis.call('SET', KEYS[4], '1', 'NX', 'EX', claimTtl) then return 'taken' end
local count = redis.call('HINCRBY', KEYS[1], 'failedAttempts', 1)
local canRetry = 'false'
if count < tonumber(maxF) then canRetry = 'true' end
local hs = {'status', 'failed', 'reason', reason, 'countedAttempt', attempt, 'provisionalUntil', '0', 'canRetry', canRetry, 'updatedAt', at}
if app ~= '' then hs[#hs + 1] = 'appUuid'; hs[#hs + 1] = app end
if opId ~= '' then hs[#hs + 1] = 'lastOpId'; hs[#hs + 1] = opId end
redis.call('HSET', KEYS[1], unpack(hs))
redis.call('DEL', KEYS[5])
if count >= tonumber(maxF) then redis.call('ZADD', KEYS[6], now, sid) else redis.call('ZREM', KEYS[6], sid) end
raisefloor({KEYS[1], KEYS[2], KEYS[3]}, tonumber(floor) * 1000)
return 'counted:' .. count
`

/** COUNT_FAILURE_SCRIPT, step for step, over the synchronous view. */
export const countFailureTwin: ScriptTwin = (r, KEYS, A) => {
  if (KEYS.length !== 6 || KEYS[0] === PLACEHOLDER_KEY) return 'invalid:keys'
  const WANT = ['hash', 'string', 'hash', 'string', 'string', 'zset']
  for (let k = 0; k < 6; k++) {
    if (KEYS[k] !== PLACEHOLDER_KEY) {
      const t = r.type(KEYS[k]!)
      if (t !== 'none' && t !== WANT[k]) return 'invalid:type'
    }
  }
  if (A.length < 11) return 'invalid:argv'
  const [now, opId, sid, attempt, reason, app, at, claimTtl, maxF, floor, n] = A as [string, string, string, string, string, string, string, string, string, string, string]
  if (!isInt(n) || A.length !== 11 + Number(n)) return 'invalid:argv'
  if (!isInt(now) || !isInt(attempt) || Number(attempt) < 1 || !isInt(claimTtl) || Number(claimTtl) < 1
    || !isInt(maxF) || Number(maxF) < 1 || !isInt(floor) || Number(floor) < 0 || sid === '') {
    return 'invalid:number'
  }
  const rec = KEYS[0]!
  const fa = r.hget(rec, 'failedAttempts')
  if (fa !== null && fa !== '' && !isInt(fa)) return 'invalid:counter'
  for (const f of ['countedAttempt', 'attempt']) {
    const v = r.hget(rec, f)
    if (v !== null && v !== '' && !isNum(v)) return 'invalid:field'
  }
  if (r.exists(rec) === 0) return 'refused:none'
  if (opId !== '' && r.hget(rec, 'lastOpId') === opId) return `replayed:${r.hget(rec, 'failedAttempts') ?? '0'}`
  const status = r.hget(rec, 'status') ?? ''
  if (!A.slice(11).includes(status)) return `refused:${status}`
  const guards: Array<[string, string, string]> = [
    ['billing', 'empty', ''], ['invoiceId', 'empty', ''], ['pendingSubscriptionId', 'empty', ''],
    ['subscriptionId', 'empty', ''], ['stopped', 'nottrue', '']
  ]
  if (!guards.every(g => guardHolds(r, rec, g))) return `refused:${status}`
  // This attempt was counted before (a replay after a stop cut short): taken, so the caller can finish the stop.
  if (r.exists(KEYS[3]!) === 1) return 'taken'
  const order: Array<[string, string, string]> = [['countedAttempt', 'lt', attempt], ['attempt', 'le', attempt]]
  if (!order.every(g => guardHolds(r, rec, g))) return `refused:${status}`
  if (!r.set(KEYS[3]!, '1', { nx: true, ex: Number(claimTtl) })) return 'taken'
  const count = r.hincrby(rec, 'failedAttempts', 1)
  const hs: Array<[string, string]> = [
    ['status', 'failed'], ['reason', reason], ['countedAttempt', attempt], ['provisionalUntil', '0'],
    ['canRetry', count < Number(maxF) ? 'true' : 'false'], ['updatedAt', at]
  ]
  if (app !== '') hs.push(['appUuid', app])
  if (opId !== '') hs.push(['lastOpId', opId])
  r.hset(rec, hs)
  r.del(KEYS[4]!)
  if (count >= Number(maxF)) r.zadd(KEYS[5]!, Number(now), sid)
  else r.zrem(KEYS[5]!, sid)
  raiseFloor(r, [KEYS[0]!, KEYS[1]!, KEYS[2]!], Number(floor) * 1000)
  return `counted:${count}`
}

export type CountFailureResult =
  | { result: 'counted', count: number }
  | { result: 'taken' }
  | { result: 'refused', status: string }
  | { result: 'invalid', why: string }

/**
 * Count one failed build (COUNT_FAILURE_SCRIPT). A lost reply is retried once
 * with the same op id: a step that did apply answers its count again.
 */
export async function countFailureAtomic(redis: EvalRedis, sid: string, p: CountFailureParams): Promise<CountFailureResult> {
  const now = p.now ?? Date.now()
  const opId = p.opId ?? crypto.randomUUID()
  const keys = countFailureKeys(sid, p.provisionId, p.attempt)
  const args = countFailureArgs(sid, p, now, opId)
  let raw: unknown
  try {
    raw = await redis.eval(COUNT_FAILURE_SCRIPT, keys, args)
  } catch {
    raw = await redis.eval(COUNT_FAILURE_SCRIPT, keys, args)
  }
  const text = String(raw)
  if (text.startsWith('counted:') || text.startsWith('replayed:')) return { result: 'counted', count: Number(text.split(':')[1]) }
  if (text === 'taken') return { result: 'taken' }
  if (text.startsWith('refused:')) return { result: 'refused', status: text.slice('refused:'.length) }
  return { result: 'invalid', why: text.replace(/^invalid:/, '') }
}

// --- CLEAR_INDEX_SCRIPT ----------------------------------------------------------------

/**
 * Which records a sweep index serves (Codex 6). A member is removed only when
 * its record is gone, its status is not in `states`, any `drop` guard holds,
 * or (when `any` is not empty) none of the `any` guards holds.
 */
export const INDEX_RULES: Record<'billing' | 'held' | 'teardown' | 'stops' | 'refund', { key: string, states: string[], drop: Guard[], any: Guard[] }> = {
  billing: { key: BILLING_INDEX, states: ['ready'], drop: [], any: [] },
  held: { key: HELD_INDEX, states: ['held'], drop: [], any: [] },
  // A declined sign-up not yet torn down, a teardown with steps left, or a torn_down sign-up still
  // owed the removed mail. No subscriptionId drop (Codex 3): an activation_failed refund carries one;
  // the states already exclude a paying sign-up (ready, complete).
  teardown: { key: TEARDOWN_INDEX, states: ['declined', 'tearing_down', 'torn_down'], drop: [], any: [['status', 'eq', 'declined'], ['tornDown', 'nottrue'], ['removedMailDue', 'eq', 'true']] },
  // Stopped, or paying: nothing owed. Otherwise only a second failure or an open window keeps it.
  stops: { key: STOPS_INDEX, states: ['failed'], drop: [['stopped', 'eq', 'true'], ['subscriptionId', 'set']], any: [['failedAttempts', 'ge', MAX_FAILURES], ['provisionalUntil', 'gt', 0]] },
  // 23-43 Task 6: a refund in flight (refunding, or refunded before its teardown). A refund problem
  // waits for a person, but stays here until its cancel is done (R3-1: refundSettledAt, which only
  // refundProblemSettled writes, and only with refundCancelled).
  refund: { key: REFUND_INDEX, states: ['refunding', 'refunded'], drop: [['refundSettledAt', 'set']], any: [] }
}
export type ClearableIndex = keyof typeof INDEX_RULES

export function clearIndexArgs(index: ClearableIndex, sid: string): string[] {
  const rule = INDEX_RULES[index]
  const flat = (gs: Guard[]) => gs.flatMap(([f, op, v]) => [f, op, v === undefined ? '' : String(v)])
  return [
    sid,
    String(rule.states.length), ...rule.states,
    String(rule.drop.length), ...flat(rule.drop),
    String(rule.any.length), ...flat(rule.any)
  ]
}

/**
 * Compare-and-remove one sweep member. KEYS: the record, the index. ARGV:
 * member, nStates, states..., nDrop, (field, op, value)..., nAny, (field, op, value)...
 * Validate first (key types, counts, guards). Answers removed, kept or
 * invalid:<why>; nothing is written but the one ZREM.
 */
export const CLEAR_INDEX_SCRIPT = `${LUA_COMMON}
local A = ARGV
if #KEYS ~= 2 then return 'invalid:keys' end
local t1, t2 = ktype(KEYS[1]), ktype(KEYS[2])
if (t1 ~= 'none' and t1 ~= 'hash') or (t2 ~= 'none' and t2 ~= 'zset') then return 'invalid:type' end
local i = 2
local member = A[1]
if not member or member == '' then return 'invalid:argv' end
local function list()
  local n = A[i]
  if not isint(n) then return nil end
  local out = {}
  for j = 1, tonumber(n) do out[j] = A[i + j] end
  i = i + tonumber(n) + 1
  return out
end
local states = list()
if not states then return 'invalid:argv' end
local function triples()
  local n = A[i]
  if not isint(n) then return nil end
  local out = {}
  for j = 1, tonumber(n) do out[j] = {A[i + 3 * j - 2], A[i + 3 * j - 1], A[i + 3 * j]} end
  i = i + 3 * tonumber(n) + 1
  return out
end
local drop = triples()
if not drop then return 'invalid:argv' end
local any = triples()
if not any then return 'invalid:argv' end
if #A ~= i - 1 then return 'invalid:argv' end
for _, g in ipairs(drop) do
  if not g[1] or not g[2] or not g[3] or not guardvalid(KEYS[1], g) then return 'invalid:guard' end
end
for _, g in ipairs(any) do
  if not g[1] or not g[2] or not g[3] or not guardvalid(KEYS[1], g) then return 'invalid:guard' end
end
local remove = false
if redis.call('EXISTS', KEYS[1]) == 0 then
  remove = true
else
  local status = redis.call('HGET', KEYS[1], 'status') or ''
  local served = false
  for _, st in ipairs(states) do if st == status then served = true end end
  if not served then remove = true end
  for _, g in ipairs(drop) do
    if guardholds(KEYS[1], g) then remove = true end
  end
  if #any > 0 then
    local holds = false
    for _, g in ipairs(any) do if guardholds(KEYS[1], g) then holds = true end end
    if not holds then remove = true end
  end
end
if remove then
  redis.call('ZREM', KEYS[2], member)
  return 'removed'
end
return 'kept'
`

/** CLEAR_INDEX_SCRIPT, step for step, over the synchronous view. */
export const clearIndexTwin: ScriptTwin = (r, KEYS, A) => {
  if (KEYS.length !== 2) return 'invalid:keys'
  const t1 = r.type(KEYS[0]!)
  const t2 = r.type(KEYS[1]!)
  if ((t1 !== 'none' && t1 !== 'hash') || (t2 !== 'none' && t2 !== 'zset')) return 'invalid:type'
  let i = 1
  const member = A[0]
  if (member === undefined || member === '') return 'invalid:argv'
  const list = () => {
    const n = A[i]
    if (!isInt(n)) return null
    const out = A.slice(i + 1, i + 1 + Number(n))
    i += Number(n) + 1
    return out
  }
  const states = list()
  if (!states) return 'invalid:argv'
  const triples = () => {
    const n = A[i]
    if (!isInt(n)) return null
    const out: Array<[string, string, string]> = []
    for (let j = 1; j <= Number(n); j++) out.push([A[i + 3 * j - 2]!, A[i + 3 * j - 1]!, A[i + 3 * j]!])
    i += 3 * Number(n) + 1
    return out
  }
  const drop = triples()
  if (!drop) return 'invalid:argv'
  const any = triples()
  if (!any) return 'invalid:argv'
  if (A.length !== i) return 'invalid:argv'
  if (![...drop, ...any].every(g => g.every(x => x !== undefined) && guardValid(r, KEYS[0]!, g))) return 'invalid:guard'
  let remove = false
  if (r.exists(KEYS[0]!) === 0) {
    remove = true
  } else {
    const status = r.hget(KEYS[0]!, 'status') ?? ''
    if (!states.includes(status)) remove = true
    if (drop.some(g => guardHolds(r, KEYS[0]!, g))) remove = true
    if (any.length > 0 && !any.some(g => guardHolds(r, KEYS[0]!, g))) remove = true
  }
  if (remove) {
    r.zrem(KEYS[1]!, member)
    return 'removed'
  }
  return 'kept'
}

/**
 * Remove a sweep member only if its record no longer needs that index
 * (CLEAR_INDEX_SCRIPT). Every sweep step's clean-up uses this; none calls a
 * bare ZREM on a sweep index. True when removed; invalid keeps the member.
 */
export async function clearIndex(redis: EvalRedis, sid: string, index: ClearableIndex): Promise<boolean> {
  const out = await redis.eval(CLEAR_INDEX_SCRIPT, [`provision:${sid}`, INDEX_RULES[index].key], clearIndexArgs(index, sid))
  return String(out) === 'removed'
}

// --- CREATE_SCRIPT (Task 3) -------------------------------------------------------------------

/** The build lock provision:{sid}:lock ("a build is running"), taken by the create step for an hour. */
export const BUILD_LOCK_SECONDS = 3600

/** KEYS of CREATE_SCRIPT, all declared: the record, the by-id map, the dedupe marker, the build lock. */
export function createKeys(sid: string, provisionId: string): string[] {
  return [`provision:${sid}`, `provision:by-id:${provisionId}`, dedupeKey(provisionId), `provision:${sid}:lock`]
}

export interface CreateInput {
  sid: string
  provisionId: string
  subdomain: string
  /** Wall clock, ms. */
  now: number
}

/** ARGV of CREATE_SCRIPT, flat: now, opId, sid, provisionId, subdomain, startedAt, record, marker and lock lifetimes (s). */
export function createArgs(input: CreateInput, opId: string): string[] {
  return [
    String(Math.trunc(input.now)), opId, input.sid, input.provisionId, input.subdomain, iso(input.now),
    String(PROVISION_TTL), String(DEDUPE_SECONDS), String(BUILD_LOCK_SECONDS)
  ]
}

/**
 * The first writes of checkout.session.completed, as one step (23-43 Task 3;
 * the orchestrator's addition of 2026-11-09). Validate first (key types,
 * argv); then: a record whose createOpId is this op id answers replayed (the
 * re-run after a lost reply); a record, a dedupe marker or a build lock
 * already there answers exists:<which> and writes nothing; otherwise it writes
 * the by-id map, the first hash (triggered, attempt 1, no failures,
 * startedAt), the marker with checkoutSession, their lifetimes and the build
 * lock for an hour, and answers created. The record and the 30-day marker,
 * not the lock, are the de-duplication: a redelivery after the record expired
 * still finds the marker.
 */
export const CREATE_SCRIPT = `
local function isint(v) return type(v) == 'string' and string.match(v, '^%-?%d+$') ~= nil end
if #KEYS ~= 4 then return 'invalid:keys' end
local WANT = {'hash', 'string', 'hash', 'string'}
for k = 1, 4 do
  local t = redis.call('TYPE', KEYS[k])['ok']
  if t ~= 'none' and t ~= WANT[k] then return 'invalid:type' end
end
if #ARGV ~= 9 then return 'invalid:argv' end
for a = 2, 6 do if ARGV[a] == '' then return 'invalid:argv' end end
for _, a in ipairs({1, 7, 8, 9}) do
  if not isint(ARGV[a]) or tonumber(ARGV[a]) <= 0 then return 'invalid:number' end
end
if redis.call('EXISTS', KEYS[1]) == 1 then
  if redis.call('HGET', KEYS[1], 'createOpId') == ARGV[2] then return 'replayed' end
  return 'exists:record'
end
if redis.call('EXISTS', KEYS[3]) == 1 then return 'exists:dedupe' end
if redis.call('EXISTS', KEYS[4]) == 1 then return 'exists:lock' end
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[7])
redis.call('HSET', KEYS[1], 'status', 'triggered', 'subdomain', ARGV[5], 'provisionId', ARGV[4], 'attempt', '1', 'failedAttempts', '0', 'startedAt', ARGV[6], 'updatedAt', ARGV[6], 'createOpId', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[7])
redis.call('HSET', KEYS[3], 'checkoutSession', ARGV[3], 'createdAt', ARGV[6])
redis.call('EXPIRE', KEYS[3], ARGV[8])
redis.call('SET', KEYS[4], 'locked', 'EX', ARGV[9])
return 'created'
`

/** CREATE_SCRIPT, step for step, over the synchronous view. */
export const createTwin: ScriptTwin = (r, KEYS, A) => {
  if (KEYS.length !== 4) return 'invalid:keys'
  const want = ['hash', 'string', 'hash', 'string']
  for (let k = 0; k < 4; k++) {
    const t = r.type(KEYS[k]!)
    if (t !== 'none' && t !== want[k]) return 'invalid:type'
  }
  if (A.length !== 9) return 'invalid:argv'
  for (let a = 1; a <= 5; a++) if (A[a] === '') return 'invalid:argv'
  for (const a of [0, 6, 7, 8]) if (!isInt(A[a]) || Number(A[a]) <= 0) return 'invalid:number'
  if (r.exists(KEYS[0]!) === 1) return r.hget(KEYS[0]!, 'createOpId') === A[1] ? 'replayed' : 'exists:record'
  if (r.exists(KEYS[2]!) === 1) return 'exists:dedupe'
  if (r.exists(KEYS[3]!) === 1) return 'exists:lock'
  r.set(KEYS[1]!, A[2]!, { ex: Number(A[6]) })
  r.hset(KEYS[0]!, [['status', 'triggered'], ['subdomain', A[4]!], ['provisionId', A[3]!], ['attempt', '1'], ['failedAttempts', '0'], ['startedAt', A[5]!], ['updatedAt', A[5]!], ['createOpId', A[1]!]])
  r.pexpire(KEYS[0]!, Number(A[6]) * 1000)
  r.hset(KEYS[2]!, [['checkoutSession', A[2]!], ['createdAt', A[5]!]])
  r.pexpire(KEYS[2]!, Number(A[7]) * 1000)
  r.set(KEYS[3]!, 'locked', { ex: Number(A[8]) })
  return 'created'
}

/**
 * Run CREATE_SCRIPT for a completed checkout. 'created' (or the re-run of a
 * lost reply with the same op id, which answers replayed): the caller
 * dispatches. 'exists': a record, a marker or a build lock was there, nothing
 * was written, and the caller answers alreadyProcessing. A throw from the
 * eval is retried once with the same op id; a second throw is raised, so the
 * webhook answers 5xx and Stripe redelivers onto a clean slate. Invalid is
 * raised (fixed words and the reason only).
 */
export async function createProvision(redis: EvalRedis, input: CreateInput, opId: string = crypto.randomUUID()): Promise<'created' | 'exists'> {
  const keys = createKeys(input.sid, input.provisionId)
  const args = createArgs(input, opId)
  let raw: unknown
  try {
    raw = await redis.eval(CREATE_SCRIPT, keys, args)
  } catch {
    raw = await redis.eval(CREATE_SCRIPT, keys, args)
  }
  const text = String(raw)
  if (text === 'created' || text === 'replayed') return 'created'
  if (text.startsWith('exists:')) return 'exists'
  throw new Error(`lifecycle: create could not apply (invalid: ${text.startsWith('invalid:') ? text.slice('invalid:'.length) : 'unknown'})`)
}

// --- RECORD_SETUP_SCRIPT (code review fix round 1, C6) -----------------------------------

/**
 * checkout.session.completed's write of the Stripe ids on signup:{provisionId}
 * and its lifetime raise, as one step (stripe-webhook.ts recordSetupInRedis).
 * PTTL then EXPIRE were two commands, so a concurrent raise to 72 h could be
 * cut back to 48 h; and a record that ran out between the read and the HSET
 * came back with no lifetime. EXPIRE GT alone (Redis 7) fixes the first but not
 * the second, so this is a script. KEYS: the signup record. ARGV:
 * stripeCustomerId, setupIntentId, floorMs. Validate first; a missing record
 * answers none and is never made; then HSET both ids and raise the lifetime to
 * floorMs only when it is lower (a key with no lifetime, -1, is left as it is).
 * Answers recorded, none or invalid:<why>.
 */
export const RECORD_SETUP_SCRIPT = `
local function isint(v) return type(v) == 'string' and string.match(v, '^%-?%d+$') ~= nil end
if #KEYS ~= 1 then return 'invalid:keys' end
if #ARGV ~= 3 or ARGV[1] == '' or ARGV[2] == '' then return 'invalid:argv' end
if not isint(ARGV[3]) or tonumber(ARGV[3]) <= 0 then return 'invalid:number' end
local t = redis.call('TYPE', KEYS[1])['ok']
if t == 'none' then return 'none' end
if t ~= 'hash' then return 'invalid:type' end
redis.call('HSET', KEYS[1], 'stripeCustomerId', ARGV[1], 'setupIntentId', ARGV[2])
local p = redis.call('PTTL', KEYS[1])
if p >= 0 and p < tonumber(ARGV[3]) then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
return 'recorded'
`

/** RECORD_SETUP_SCRIPT, step for step, over the synchronous view. */
export const recordSetupTwin: ScriptTwin = (r, KEYS, A) => {
  if (KEYS.length !== 1) return 'invalid:keys'
  if (A.length !== 3 || A[0] === '' || A[1] === '') return 'invalid:argv'
  if (!isInt(A[2]) || Number(A[2]) <= 0) return 'invalid:number'
  const t = r.type(KEYS[0]!)
  if (t === 'none') return 'none'
  if (t !== 'hash') return 'invalid:type'
  r.hset(KEYS[0]!, [['stripeCustomerId', A[0]!], ['setupIntentId', A[1]!]])
  const p = r.pttl(KEYS[0]!)
  if (p >= 0 && p < Number(A[2])) r.pexpire(KEYS[0]!, Number(A[2]))
  return 'recorded'
}

// --- the lease ---------------------------------------------------------------------------

/** Compare-and-pexpire: renew only while the key still holds this token. */
export const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0
`
export const renewTwin: ScriptTwin = (r, KEYS, A) => (r.get(KEYS[0]!) === A[0] ? r.pexpire(KEYS[0]!, Number(A[1])) : 0)

/** Compare-and-delete: release only while the key still holds this token. */
export const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`
export const releaseTwin: ScriptTwin = (r, KEYS, A) => (r.get(KEYS[0]!) === A[0] ? r.del(KEYS[0]!) : 0)

/** The lease ran out, or too little is left for a remote call. The message names the op only. */
export class LeaseLostError extends Error {
  constructor(op: string) {
    super(`lifecycle: lease lost before ${op}`)
    this.name = 'LeaseLostError'
  }
}

export interface Lease {
  readonly token: string
  readonly key: string
  readonly lost: boolean
  /** Monotonic ms: the send time of the SET or of the last renewal that answered 1, plus LIFECYCLE_LOCK_MS. */
  readonly deadline: number
  /** Throws LeaseLostError when the lease is lost or fewer than LEASE_MARGIN_MS remain. */
  beforeRemote: (op: string) => void
  assertHeld: () => void
  /** beforeRemote, then one call under its own total deadline. */
  remote: <T>(op: string, ms: number, call: (signal: AbortSignal) => Promise<T>) => Promise<T>
  /** beforeRemote, then one Stripe call (stripeCall). */
  stripe: <T>(op: string, call: (opts: StripeCallOptions) => Promise<T>) => Promise<T>
}

export interface LockRedis extends EvalRedis {
  set: (key: string, value: string, opts: { nx: true, px: number }) => Promise<unknown>
}

export interface LockDeps {
  redis: LockRedis
  /** Monotonic ms for the lease; performance.now by default. Never the wall clock. */
  tick?: () => number
  timers?: { setInterval: (fn: () => void, ms: number) => unknown, clearInterval: (handle: unknown) => void }
  log?: (msg: string) => void
}

/**
 * Run work under the sign-up's one lifecycle lock (escalation point 1).
 * Taken by another runner: 'busy', and the work is never called. Held: the
 * work gets a lease, renewed every LIFECYCLE_RENEW_MS by one renewal at a time
 * (RENEW_SCRIPT); a renewal that answers 0, throws, or answers after the local
 * deadline marks the lease lost. A LeaseLostError from the work ends it as
 * 'lost' (the next holder reconciles from the intent). Released in finally by
 * RELEASE_SCRIPT, which never deletes another runner's lock.
 */
export async function withLifecycleLock<T>(sid: string, deps: LockDeps, work: (lease: Lease) => Promise<T>): Promise<T | 'busy' | 'lost'> {
  const tick = deps.tick ?? (() => performance.now())
  const timers = deps.timers ?? {
    setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms),
    clearInterval: (h: unknown) => globalThis.clearInterval(h as ReturnType<typeof setInterval>)
  }
  const key = lifecycleLockKey(sid)
  const token = crypto.randomUUID()
  const sent = tick()
  const taken = await deps.redis.set(key, token, { nx: true, px: LIFECYCLE_LOCK_MS })
  if (!taken) return 'busy'
  let deadline = sent + LIFECYCLE_LOCK_MS
  let lost = false
  let renewing = false
  const renew = async () => {
    if (renewing || lost) return
    renewing = true
    const at = tick()
    try {
      const answered = Number(await deps.redis.eval(RENEW_SCRIPT, [key], [token, String(LIFECYCLE_LOCK_MS)]))
      if (answered === 1 && tick() < deadline) deadline = at + LIFECYCLE_LOCK_MS
      else lost = true
    } catch {
      lost = true
    } finally {
      renewing = false
    }
  }
  const beforeRemote = (op: string) => {
    if (lost || tick() + LEASE_MARGIN_MS > deadline) {
      lost = true
      throw new LeaseLostError(op)
    }
  }
  const lease: Lease = {
    token,
    key,
    get lost() {
      return lost || tick() >= deadline
    },
    get deadline() {
      return deadline
    },
    beforeRemote,
    assertHeld: () => {
      if (lost || tick() >= deadline) throw new LeaseLostError('write')
    },
    remote: (op, ms, call) => {
      beforeRemote(op)
      return withDeadline(ms, call)
    },
    stripe: (op, call) => {
      beforeRemote(op)
      return stripeCall(call)
    }
  }
  const handle = timers.setInterval(() => {
    void renew()
  }, LIFECYCLE_RENEW_MS)
  try {
    return await work(lease)
  } catch (err) {
    if (err instanceof LeaseLostError) {
      deps.log?.('lifecycle: lease lost, the next holder reconciles')
      return 'lost'
    }
    throw err
  } finally {
    timers.clearInterval(handle)
    try {
      await deps.redis.eval(RELEASE_SCRIPT, [key], [token])
    } catch {
      deps.log?.('lifecycle: release failed, the lock runs out on its own')
    }
  }
}

// --- intents (D1) -----------------------------------------------------------------------

/** The remote mutations an intent names. Billing reconciles subscribe, pay and activate; the teardown runner (retry-stop.ts reconcileStop) void, cancel, detach, dispatch and mail; Task 6 adds refund. */
export type IntentOp = 'subscribe' | 'pay' | 'activate' | 'void' | 'cancel' | 'detach' | 'dispatch' | 'mail' | 'refund'

/**
 * Before a remote mutation: a fenced transition writes intentOp, intentKey
 * (the idempotency key or the target), intentToken (this lease) and intentAt.
 * Lost or refused: LeaseLostError, so no call is made.
 */
export async function writeIntent(redis: EvalRedis, sid: string, lease: { token: string }, op: IntentOp, key: string, p: { provisionId?: string, now?: number }): Promise<void> {
  const out = await transition(redis, sid, 'intent', { provisionId: p.provisionId, now: p.now, op, key, token: lease.token }, lease)
  if (!isApplied(out)) throw new LeaseLostError(op)
}

/**
 * Apply a remote call's result: the named transition, fenced, guarded by
 * intentToken equal to this lease's token, clearing the intent in the same
 * step. Refused or lost: the result is stale; it is logged as a fixed line
 * naming the op and dropped, and the next holder reconciles from the intent.
 */
export async function applyResult(
  redis: EvalRedis,
  sid: string,
  lease: { token: string },
  op: IntentOp,
  name: TransitionName,
  params: TransitionParams,
  log?: (msg: string) => void
): Promise<TransitionResult['result'] | 'dropped'> {
  const out = await transition(redis, sid, name, { ...params, clearIntent: true, guards: [...(params.guards ?? []), ['intentToken', 'eq', lease.token]] }, lease)
  if (isApplied(out)) return out.result
  // Invalid is not stale: the step could not apply at all (a wrong-type key, a bad number). Logged and raised, never dropped.
  if (out.result === 'invalid') {
    log?.(`lifecycle: ${name} could not apply (${out.why})`)
    throw new Error(`lifecycle: ${name} could not apply (invalid)`)
  }
  log?.(`lifecycle: stale result dropped (${op})`)
  return 'dropped'
}

/** An intent written under another token: the next holder's to reconcile before anything else. */
/**
 * Ruling (a): may this record's late activation still keep the site? A zero
 * invoice in a refund state, with the late activation seen, nothing activated,
 * no refund problem, and no delete asked for (no stopApp, no dispatch mark, no
 * open dispatch intent). The row's guards decide again inside the step.
 */
export function lateKeepable(state: Record<string, unknown>): boolean {
  const filled = (v: unknown) => s(v) !== ''
  return ['refunding', 'refunded', 'tearing_down'].includes(s(state.status))
    && s(state.teardownReason) === 'activation_failed'
    && s(state.refundZero) === 'true'
    && s(state.lateActivation) === 'true'
    && !filled(state.activatedAt) && !filled(state.refundProblem) && !filled(state.refundSucceededAt)
    && s(state.stopApp) !== 'true' && !filled(state.teardownDispatchedAt) && !filled(state.dispatchAskedAt)
    && s(state.intentOp) !== 'dispatch'
}

/**
 * Ruling (a), run by whichever runner holds the lifecycle lock: the refund
 * runner at its checks before the cancel, the card, the invite, the Stopped
 * mail and the delete; the teardown runner the same way; the activation run
 * that saw a late 200, once it can take the lock. Reads the record under the
 * lease and, when it is a zero invoice that activated before the delete was
 * asked for, applies keepLateActivation (fenced) with what already ran.
 * True when the site was kept. A lost lease throws LeaseLostError.
 */
export async function keepIfLateZero(redis: EvalRedis & { hgetall: (key: string) => Promise<Record<string, unknown> | null> }, sid: string, lease: { token: string }, p: { now?: number, log?: (msg: string) => void } = {}): Promise<boolean> {
  const state = (await redis.hgetall(`provision:${sid}`)) ?? {}
  if (!lateKeepable(state)) return false
  const undone = KEPT_STEPS.filter(step => s(state[KEPT_FIELD[step]]) === 'true')
  const mail = s(state.stopMail) === 'true' ? 'sent' : s(state.mailAskedAt) ? 'maybe' : 'none'
  const out = await transition(redis, sid, 'keepLateActivation', {
    provisionId: s(state.provisionId) || undefined,
    now: p.now,
    undone: undone.length ? undone.join(',') : 'none',
    mail
  }, lease)
  if (out.result === 'lost') throw new LeaseLostError('keep')
  if (!isApplied(out)) return false
  p.log?.('lifecycle: a free site activated before its delete was asked for; kept live and flagged for a person')
  return true
}

export function foreignIntent(state: Record<string, unknown>, lease: { token: string }): { op: string, key: string, token: string } | null {
  const token = s(state.intentToken)
  const op = s(state.intentOp)
  if (!token || !op || token === lease.token) return null
  return { op, key: s(state.intentKey), token }
}

/** Every lifecycle script and its twin, for FakeRedis (tests/unit/helpers/fake-redis.ts registers them all). */
export const LIFECYCLE_TWINS: Array<[script: string, twin: ScriptTwin]> = [
  [TRANSITION_SCRIPT, transitionTwin],
  [COUNT_FAILURE_SCRIPT, countFailureTwin],
  [CLEAR_INDEX_SCRIPT, clearIndexTwin],
  [RENEW_SCRIPT, renewTwin],
  [RELEASE_SCRIPT, releaseTwin],
  [CREATE_SCRIPT, createTwin],
  [RECORD_SETUP_SCRIPT, recordSetupTwin]
]

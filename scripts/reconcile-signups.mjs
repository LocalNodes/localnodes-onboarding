#!/usr/bin/env node
// Reconcile sign-ups: a read-only report of what is stuck or out of step
// (Phase 23, plan 23-21; threat T-23-103).
//
// Run by Tom or the orchestrator, never by the web app. It looks at three
// places and prints one line for each thing that needs a human look:
//   - the sign-up records and the sweep lists in Upstash Redis,
//   - the flags other code raised (the reconcile:flags list),
//   - Stripe: finished checkout sessions of the last --hours, and the
//     subscriptions that are running.
// Healthy sign-ups print nothing.
//
// Usage:
//   node scripts/reconcile-signups.mjs [--hours 72] [--json]
//
// Environment (all required; none is ever printed). Each is read from the
// NUXT_ name the app uses first, then from the shorter name older scripts use:
//   NUXT_STRIPE_SECRET_KEY    or STRIPE_SECRET_KEY
//   NUXT_UPSTASH_REDIS_URL    or UPSTASH_REDIS_REST_URL
//   NUXT_UPSTASH_REDIS_TOKEN  or UPSTASH_REDIS_REST_TOKEN
//
// READ ONLY, by design. Redis: get, hgetall, zrange, scan, type, ttl. Stripe:
// list calls only. There is no write call anywhere in this file, and
// tests/unit/reconcile-signups.test.ts runs it against a Redis and a Stripe
// that throw on any write. To repair something, use the repair command of
// plan 23-44. Never edit Redis by hand on the money path (T-23-104).
//
// Output carries no email address. Only a fixed list of fields is printed
// (ids, subdomain, state names, ages, flag parts); no record, session or error
// body is ever dumped, and any value that holds an "@" is replaced.
//
// Nothing here talks to a network when the module is imported: the work is in
// reconcile and main, which take Redis, Stripe and the lifecycle constants as
// arguments. Only the default dependency builder at the bottom reaches the
// real services.
import { parseArgs as nodeParseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = 'Usage: node scripts/reconcile-signups.mjs [--hours <n>] [--json]'
const ENV_NAMES = {
  stripeKey: ['NUXT_STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY'],
  redisUrl: ['NUXT_UPSTASH_REDIS_URL', 'UPSTASH_REDIS_REST_URL'],
  redisToken: ['NUXT_UPSTASH_REDIS_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']
}

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const TRIGGERED_LIMIT_MS = 15 * MIN
const BUILT_NOT_PAID_MS = 24 * HOUR
const TEARDOWN_LIMIT_MS = HOUR
/** A pilot that ended within this many days is marked for a person (pilot ended row). */
const PILOT_ENDED_ATTENTION_DAYS = 60
/**
 * A lapsed pilot's site stays up this many days after the end, then a person
 * removes it after a written notice sent PILOT_REMOVAL_NOTICE_DAYS before
 * (project rule, 2026-11-11). The row only prints the dates; nothing here removes a site.
 */
const PILOT_LAPSE_DAYS = 30
const PILOT_REMOVAL_NOTICE_DAYS = 7
/**
 * The end notice goes out 14 days before (pilot-end.ts, every 6 hours, retried
 * for 20 hours). A pilot with fewer days left and no notice mark needs a person.
 */
const PILOT_NOTICE_OVERDUE_DAYS = 12
const B2_WARN_DAYS = 14
const PAGE_LIMIT = 100
const MAX_PAGES = 1000
const SWEEPS = ['sweep:billing', 'sweep:held', 'sweep:refund', 'sweep:stops', 'sweep:teardown']
const FLAGS_KEY = 'reconcile:flags'
const RECORD_KEY = /^provision:[^:]+$/

class UsageError extends Error {}
/** A read from Stripe or Redis failed. The message is fixed text: the original error can carry an address. */
class ReadError extends Error {
  constructor(source, cause) {
    const status = Number(cause?.statusCode ?? cause?.status)
    super(`the ${source} read failed${Number.isFinite(status) && status > 0 ? ` (status ${status})` : ''}`)
    this.source = source
  }
}

/** Read the command line. Throws UsageError; the message never repeats what was typed. */
export function parseArgs(argv) {
  let values
  try {
    ;({ values } = nodeParseArgs({
      args: argv,
      options: { hours: { type: 'string' }, json: { type: 'boolean' } },
      strict: true,
      allowPositionals: false
    }))
  } catch {
    throw new UsageError('Unknown or malformed arguments.')
  }
  let hours = 72
  if (values.hours !== undefined) {
    if (!/^\d{1,5}$/.test(values.hours) || Number(values.hours) < 1) throw new UsageError('--hours must be a whole number of hours, 1 or more.')
    hours = Number(values.hours)
  }
  return { hours, json: values.json === true }
}

/** Each setting from its NUXT_ name first, then the unprefixed name. */
export function readEnv(env) {
  const pick = names => names.map(n => env[n]).find(v => typeof v === 'string' && v !== '')
  return { stripeKey: pick(ENV_NAMES.stripeKey), redisUrl: pick(ENV_NAMES.redisUrl), redisToken: pick(ENV_NAMES.redisToken) }
}

/** FLAG_KINDS, LIFECYCLE_STATES and billingWaits from the app's own lifecycle.ts, so there is no copy to drift. */
export async function loadLifecycle() {
  const { createJiti } = await import('jiti')
  const mod = await createJiti(import.meta.url).import('../server/utils/lifecycle.ts')
  return { FLAG_KINDS: mod.FLAG_KINDS, LIFECYCLE_STATES: mod.LIFECYCLE_STATES, billingWaits: mod.billingWaits }
}

// ---------------------------------------------------------------------------
// small helpers

const present = v => v !== undefined && v !== null && v !== ''
const truthy = v => String(v ?? '') === 'true'
/** A time as milliseconds: a number (ms), a numeric string, or an ISO date. NaN when it is none of these. */
function toMs(v) {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v !== '') return /^\d+$/.test(v) ? Number(v) : Date.parse(v)
  return Number.NaN
}
const iso = ms => new Date(ms).toISOString()
const str = (v, fallback = '-') => (present(v) ? String(v) : fallback)

/** Format an age in milliseconds the way a person reads it: 20m, 3h, 2d. */
export function formatAge(ms) {
  if (!Number.isFinite(ms)) return '-'
  const abs = Math.abs(ms)
  const sign = ms < 0 ? '-' : ''
  if (abs < HOUR) return `${sign}${Math.floor(abs / MIN)}m`
  if (abs < 48 * HOUR) return `${sign}${Math.floor(abs / HOUR)}h`
  return `${sign}${Math.floor(abs / DAY)}d`
}

/** Copy only the listed fields that are set, as text. */
function pick(rec, fields) {
  const out = {}
  for (const f of fields) if (present(rec?.[f])) out[f] = String(rec[f])
  return out
}

/** Replace any text holding an "@" so no address can reach the output, whatever field it came from. */
function scrub(value) {
  if (typeof value === 'string') return value.includes('@') ? '[hidden]' : value
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]))
  return value
}

/** Run a read call; any failure becomes a ReadError with fixed text. */
async function reading(source, fn) {
  try {
    return await fn()
  } catch (err) {
    throw new ReadError(source, err)
  }
}

// ---------------------------------------------------------------------------
// reading Redis

/** Every sign-up record, by sid. SCAN, then TYPE, because string keys also start with "provision:". */
async function readRecords(redis) {
  const records = new Map()
  let cursor = '0'
  for (let i = 0; i < MAX_PAGES * 10; i++) {
    const [next, keys] = await redis.scan(cursor, { match: 'provision:*', count: PAGE_LIMIT })
    for (const key of keys ?? []) {
      if (!RECORD_KEY.test(key)) continue
      if ((await redis.type(key)) !== 'hash') continue
      const rec = await redis.hgetall(key)
      if (rec && Object.keys(rec).length) records.set(key.slice('provision:'.length), rec)
    }
    cursor = String(next)
    if (cursor === '0') break
  }
  return records
}

async function readSweep(redis, key) {
  const members = await redis.zrange(key, 0, -1)
  return new Set((members ?? []).map(String))
}

async function readFlags(redis) {
  const flat = (await redis.zrange(FLAGS_KEY, 0, -1, { withScores: true })) ?? []
  const out = []
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ member: String(flat[i]), score: Number(flat[i + 1]) })
  return out
}

// ---------------------------------------------------------------------------
// reading Stripe (list calls only)

async function listAll(listFn, params) {
  const all = []
  let startingAfter
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await listFn({ ...params, limit: PAGE_LIMIT, ...(startingAfter ? { starting_after: startingAfter } : {}) })
    const data = Array.isArray(res?.data) ? res.data : []
    all.push(...data)
    if (res?.has_more !== true || data.length === 0) break
    startingAfter = data[data.length - 1]?.id
    if (!startingAfter) break
  }
  return all
}

// ---------------------------------------------------------------------------
// flags

/** The parts of a flag member. Kind and sid are the first two segments; sids hold underscores, never colons. */
function parseFlag(member) {
  const parts = member.split(':')
  const kind = parts[0]
  const sid = parts[1] ?? '-'
  const rest = parts.slice(2).join(':')
  const detail = { kind, rest }
  if (kind === 'paid_in_review') {
    const [eventId, invoiceId, amount] = parts.slice(2)
    Object.assign(detail, { eventId: str(eventId), invoiceId: str(invoiceId), amount: str(amount) })
  } else if (kind === 'late_activation') {
    const [kept, mail, steps] = parts.slice(2)
    Object.assign(detail, { kept: kept === 'kept', mail: str(mail?.replace(/^mail_/, '')), steps: str(steps) })
  }
  return { kind, sid, detail }
}

// ---------------------------------------------------------------------------
// the reconciliation

/**
 * Read everything and return { rows }. Each row:
 *   { row, sid, subdomain, status, billing, ageMs, needsPerson, raisedAt?, provisionId?, detail }
 * Healthy sign-ups produce no row. Throws ReadError if Stripe or Redis cannot be read.
 */
export async function reconcile({ hours, now }, { redis, stripe, lifecycle }) {
  const nowMs = now()
  const { FLAG_KINDS, LIFECYCLE_STATES, billingWaits } = lifecycle
  const rows = []
  const add = (row, sid, rec, extra = {}) => rows.push({
    row,
    sid: str(sid),
    subdomain: str(rec?.subdomain),
    status: str(rec?.status),
    billing: str(rec?.billing),
    ageMs: null,
    needsPerson: false,
    detail: {},
    ...(present(rec?.provisionId) ? { provisionId: String(rec.provisionId) } : {}),
    ...extra
  })

  const records = await reading('Redis', () => readRecords(redis))
  const sweeps = {}
  for (const key of SWEEPS) sweeps[key] = await reading('Redis', () => readSweep(redis, key))
  const flags = await reading('Redis', () => readFlags(redis))

  // ---- rows read from each record ----
  for (const [sid, rec] of records) {
    const status = String(rec.status ?? '')
    const startedMs = toMs(rec.startedAt)
    const updatedMs = toMs(rec.updatedAt)
    const sinceMs = Number.isFinite(toMs(rec.readyAtMs)) ? toMs(rec.readyAtMs) : Number.isFinite(startedMs) ? startedMs : updatedMs
    const sinceAge = Number.isFinite(sinceMs) ? nowMs - sinceMs : null
    // Every billing step writes updatedAt, so a sign-up that has not moved for a day is a stalled sweep (the plan's wording).
    const idleAge = Number.isFinite(updatedMs) ? nowMs - updatedMs : sinceAge
    const waits = billingWaits(rec)

    if (!LIFECYCLE_STATES.includes(status)) {
      add('unknown status', sid, rec, { ageMs: sinceAge, detail: {} })
    }

    if (status === 'triggered' && Number.isFinite(updatedMs) && nowMs - updatedMs > TRIGGERED_LIMIT_MS) {
      // A retry keeps the old run id, so the age alone is the test (reported against the plan's "no githubRunId").
      add('triggered, no run', sid, rec, { ageMs: nowMs - updatedMs, detail: pick(rec, ['attempt', 'githubRunId']) })
    }

    if (status === 'ready' && waits) {
      add('waiting for a person', sid, rec, {
        ageMs: sinceAge,
        needsPerson: true,
        detail: pick(rec, ['billingError', 'siteNeverAnswered', 'siteAnsweredAt'])
      })
    }

    const builtNotPaid =
      (status === 'ready' && !waits && String(rec.billing ?? '') !== 'paid' && idleAge !== null && idleAge > BUILT_NOT_PAID_MS) ||
      (status === 'held' && ((idleAge !== null && idleAge > BUILT_NOT_PAID_MS) || truthy(rec.heldUntilBad)))
    if (builtNotPaid) {
      add('built, not paid', sid, rec, { ageMs: idleAge, detail: pick(rec, ['heldUntil', 'heldUntilBad', 'billingError', 'billingTries']) })
    }

    const deadline = toMs(rec.activationDeadline)
    if (status === 'ready' && String(rec.billing ?? '') === 'paid' && !present(rec.activatedAt) && Number.isFinite(deadline) && deadline < nowMs) {
      add('paid, not activated', sid, rec, { ageMs: nowMs - deadline, detail: pick(rec, ['activationDeadline', 'lateActivation', 'lateKeptAfter']) })
    }

    if (status === 'refunding' || (status === 'refunded' && (!present(rec.refundSettledAt) || present(rec.refundProblem)))) {
      const refundingMs = toMs(rec.refundingAtMs)
      add('refund waiting', sid, rec, {
        ageMs: Number.isFinite(refundingMs) ? nowMs - refundingMs : sinceAge,
        needsPerson: present(rec.refundProblem) && String(rec.refundProblem) !== 'false',
        detail: pick(rec, ['refundProblem', 'refundCancelled', 'refundDone', 'refundSettledAt', 'refundSucceededAt'])
      })
    }

    const dispatchedMs = toMs(rec.teardownDispatchedAt)
    if (Number.isFinite(dispatchedMs)) {
      const result = String(rec.teardownApp ?? '')
      const finished = result === 'deleted' || result === 'gone'
      const bad = result === 'refused' || result === 'failed'
      if (bad || (!finished && nowMs - dispatchedMs > TEARDOWN_LIMIT_MS)) {
        add('teardown unfinished', sid, rec, { ageMs: nowMs - dispatchedMs, needsPerson: bad, detail: pick(rec, ['teardownApp', 'teardownDispatchedAt']) })
      }
    }

    // ---- the sweep lists: does each record sit where its state says ----
    const expect = []
    if (status === 'ready' && !waits) expect.push('sweep:billing')
    if (status === 'held') expect.push('sweep:held')
    if ((status === 'refunding' || status === 'refunded') && !present(rec.refundSettledAt)) expect.push('sweep:refund')
    for (const sweep of expect) {
      if (!sweeps[sweep].has(sid)) add('index mismatch', sid, rec, { ageMs: sinceAge, detail: { sweep, problem: 'record not in the sweep' } })
    }
  }

  for (const sweep of SWEEPS) {
    for (const sid of sweeps[sweep]) {
      if (!records.has(sid)) add('index mismatch', sid, null, { detail: { sweep, problem: 'member with no record' } })
    }
  }

  // ---- flags ----
  for (const { member, score } of flags) {
    const { kind, sid, detail } = parseFlag(member)
    const known = FLAG_KINDS.includes(kind)
    const rec = records.get(sid)
    add(known ? 'flag' : 'unknown flag', sid, rec, {
      ageMs: Number.isFinite(score) ? nowMs - score : null,
      raisedAt: Number.isFinite(score) ? iso(score) : undefined,
      needsPerson: true,
      detail
    })
  }

  // ---- Stripe: finished checkouts with no record ----
  const sinceSeconds = Math.floor((nowMs - hours * HOUR) / 1000)
  const sessions = await reading('Stripe', () => listAll(p => stripe.checkout.sessions.list(p), { status: 'complete', created: { gte: sinceSeconds } }))
  for (const s of sessions) {
    if (s?.status !== 'complete' || (present(s?.mode) && s.mode !== 'setup')) continue
    if (Number.isFinite(s.created) && s.created < sinceSeconds) continue
    const sid = String(s.id)
    if (records.has(sid)) continue
    const pid = s.metadata?.provision_id
    const marker = present(pid) ? await reading('Redis', () => redis.hgetall(`dedupe:${pid}`)) : null
    const detail = {}
    if (marker && present(marker.subscriptionId)) detail.subscriptionId = String(marker.subscriptionId)
    if (present(marker?.checkoutSession)) detail.checkoutSession = String(marker.checkoutSession)
    const hasMarker = marker && Object.keys(marker).length > 0
    add(hasMarker ? 'record expired' : 'no provision record', sid, { subdomain: s.metadata?.subdomain }, {
      ageMs: Number.isFinite(s.created) ? nowMs - s.created * 1000 : null,
      provisionId: str(pid),
      detail
    })
  }

  // ---- Stripe: running subscriptions (B-2 date, and subscriptions whose site is gone) ----
  const byProvisionId = new Map()
  for (const rec of records.values()) if (present(rec.provisionId)) byProvisionId.set(String(rec.provisionId), rec)
  let earliest = null
  for (const status of ['active', 'trialing']) {
    const subs = await reading('Stripe', () => listAll(p => stripe.subscriptions.list(p), { status, expand: ['data.discounts'] }))
    for (const sub of subs) {
      const pid = sub?.metadata?.provision_id
      if (!present(pid)) continue
      for (const d of sub.discounts ?? []) {
        if (d && typeof d === 'object' && typeof d.end === 'number' && (!earliest || d.end < earliest.end)) earliest = { end: d.end, subscriptionId: String(sub.id) }
      }
      // The free pilot (pilot-end.ts): a pilot must end by itself at its frozen end,
      // and a 100% discount with no pilot mark was never given an end.
      const meta = sub.metadata ?? {}
      const fullOff = (sub.discounts ?? []).some(d => d && typeof d === 'object' && (d.coupon?.percent_off ?? d.source?.coupon?.percent_off) === 100)
      const endsWrong = meta.pilot === 'ends' && (typeof sub.cancel_at !== 'number' || String(sub.cancel_at) !== String(meta.pilot_ends_at))
      if (endsWrong || (fullOff && meta.pilot !== 'ends' && meta.pilot !== 'continued')) {
        add('pilot without end', '-', byProvisionId.get(String(pid)) ?? null, {
          provisionId: String(pid),
          needsPerson: true,
          detail: { subscriptionId: String(sub.id), pilot: present(meta.pilot) ? String(meta.pilot) : 'unmarked', cancelAt: typeof sub.cancel_at === 'number' ? iso(sub.cancel_at * 1000).slice(0, 10) : 'none' }
        })
      }
      // The end notice (pilot-end.ts): overdue when the sweep could not send or confirm it.
      // A person checks Resend, writes to the organizer if no mail went out, and sets
      // pilot_notice_sent on the subscription.
      if (meta.pilot === 'ends' && !present(meta.pilot_notice_sent) && typeof sub.cancel_at === 'number'
        && sub.cancel_at * 1000 > nowMs && sub.cancel_at * 1000 - nowMs < PILOT_NOTICE_OVERDUE_DAYS * DAY) {
        add('pilot notice not sent', '-', byProvisionId.get(String(pid)) ?? null, {
          provisionId: String(pid),
          needsPerson: true,
          detail: { subscriptionId: String(sub.id), endsAt: iso(sub.cancel_at * 1000).slice(0, 10) }
        })
      }
      const rec = byProvisionId.get(String(pid))
      if (rec && ['torn_down', 'refunded', 'declined'].includes(String(rec.status))) {
        add('subscription without a record', '-', rec, { provisionId: String(pid), detail: { subscriptionId: String(sub.id), subscription: String(sub.status) } })
      }
    }
  }
  // ---- Stripe: pilots that ended by themselves (the site stays up until a person removes it) ----
  const ended = await reading('Stripe', () => listAll(p => stripe.subscriptions.list(p), { status: 'canceled' }))
  for (const sub of ended) {
    if (sub?.metadata?.pilot !== 'ends' || !present(sub?.metadata?.provision_id)) continue
    const endedSec = Number.isFinite(sub.ended_at) ? sub.ended_at : null
    // A late yes (server/utils/pilot-late.ts): paid on Stripe's page, the site stays;
    // an open page must be closed with scripts/pilot-removal.mjs before removing.
    const late = await reading('Redis', () => redis.get(`pilot:late:${sub.id}`))
    let lateState = 'none'
    try {
      const rec = typeof late === 'string' ? JSON.parse(late) : late
      if (rec && typeof rec === 'object' && typeof rec.state === 'string') lateState = rec.state
    } catch {
      lateState = 'unreadable'
    }
    const kept = lateState === 'continued'
    add('pilot ended', '-', byProvisionId.get(String(sub.metadata.provision_id)) ?? null, {
      provisionId: String(sub.metadata.provision_id),
      ageMs: endedSec === null ? null : nowMs - endedSec * 1000,
      // Recent ends need a person: write before removing the site (the end mail's promise).
      needsPerson: endedSec === null || nowMs - endedSec * 1000 <= PILOT_ENDED_ATTENTION_DAYS * DAY,
      detail: {
        subscriptionId: String(sub.id),
        endedAt: endedSec === null ? 'unknown' : iso(endedSec * 1000).slice(0, 10),
        noticeFrom: endedSec === null ? 'unknown' : iso(endedSec * 1000 + (PILOT_LAPSE_DAYS - PILOT_REMOVAL_NOTICE_DAYS) * DAY).slice(0, 10),
        removeFrom: kept ? 'kept (paid after the end)' : endedSec === null ? 'unknown' : iso(endedSec * 1000 + PILOT_LAPSE_DAYS * DAY).slice(0, 10),
        removalDue: !kept && endedSec !== null && nowMs - endedSec * 1000 >= PILOT_LAPSE_DAYS * DAY,
        lateYes: { none: 'none', open: 'payment page open', continued: 'kept', removing: 'removal marked' }[lateState] ?? lateState
      }
    })
  }

  if (earliest) {
    const daysAway = Math.floor((earliest.end * 1000 - nowMs) / DAY)
    add('B-2 date', '-', null, {
      detail: { date: iso(earliest.end * 1000).slice(0, 10), subscriptionId: earliest.subscriptionId, daysAway, warning: daysAway <= B2_WARN_DAYS }
    })
  }

  return { rows: rows.map(scrub) }
}

// ---------------------------------------------------------------------------
// printing

function line(r) {
  const parts = [`${r.row}:`, `sid=${r.sid}`]
  if (r.provisionId) parts.push(`provision=${r.provisionId}`)
  if (r.subdomain !== '-') parts.push(`site=${r.subdomain}`)
  if (r.status !== '-') parts.push(`status=${r.status}`)
  if (r.billing !== '-') parts.push(`billing=${r.billing}`)
  if (r.ageMs !== null && r.ageMs !== undefined) parts.push(`age=${formatAge(r.ageMs)}`)
  if (r.raisedAt) parts.push(`raised=${r.raisedAt}`)
  for (const [k, v] of Object.entries(r.detail ?? {})) if (present(v)) parts.push(`${k}=${v}`)
  if (r.needsPerson) parts.push('[needs attention]')
  return parts.join(' ')
}

/** Command-line entry. Returns the exit code; prints through io.out and io.err. */
export async function main(argv, env, io, makeDeps = defaultDeps) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    io.err(err instanceof UsageError ? err.message : 'Could not read the arguments.')
    io.err(USAGE)
    return 2
  }
  const have = readEnv(env)
  const missing = Object.entries(ENV_NAMES).filter(([k]) => !have[k]).map(([, names]) => names.join(' or '))
  if (missing.length) {
    io.err(`Missing environment variables: ${missing.join(', ')}`)
    io.err(USAGE)
    return 2
  }
  let result
  try {
    const deps = await makeDeps(env)
    result = await reconcile({ hours: args.hours, now: deps.now ?? Date.now }, deps)
  } catch (err) {
    io.err(`Reconciliation stopped: ${err instanceof ReadError ? err.message : 'could not set up the read-only connections'}.`)
    return 1
  }
  if (args.json) {
    io.out(JSON.stringify({ hours: args.hours, rows: result.rows }, null, 2))
    return 0
  }
  if (result.rows.length === 0) {
    io.out(`Nothing to report (last ${args.hours} hours of Stripe sessions, all sign-up records, all flags).`)
    return 0
  }
  for (const r of result.rows) io.out(line(r))
  io.out(`${result.rows.length} ${result.rows.length === 1 ? 'item' : 'items'} to look at.`)
  return 0
}

/** The real services. Reached only when the script is run, never by the tests. */
async function defaultDeps(env) {
  const [{ Redis }, { default: Stripe }, lifecycle] = await Promise.all([import('@upstash/redis'), import('stripe'), loadLifecycle()])
  const { stripeKey, redisUrl, redisToken } = readEnv(env)
  return {
    redis: new Redis({ url: redisUrl, token: redisToken }),
    stripe: new Stripe(stripeKey),
    lifecycle,
    now: Date.now
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), process.env, { out: console.log, err: console.error })
}

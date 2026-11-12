// A late yes: the organizer of a free pilot that has already ended chooses to
// keep the site. Plain module, no Nitro globals:
// Stripe and Redis are injected, so tests import it directly.
//
// Before the end, the yes clears the subscription's end (pilot-end.ts) and the
// saved card is charged later, at a price the organizer read on the page.
// After the end the pilot subscription is canceled, and charging the saved
// card from the server would take money for a total the organizer never saw.
// So a late yes never charges from here. It opens a Stripe-hosted Checkout
// page in subscription mode, which shows the total, and the organizer pays
// there or not at all. Nothing is charged without that page.
//
// The yes is open from the end until LATE_YES_SECONDS after it (the site is
// removed from then on, scripts/reconcile-signups.mjs), and only while no one
// has started removing the site (scripts/pilot-removal.mjs marks the record).
//
// What is kept: one record per pilot subscription in Redis, with no expiry,
// at pilot:late:{subscription id}. It names the open Checkout session (so a
// second click reuses it rather than opening a second one), then the new
// subscription once a session is paid. A short lock serializes the yes and the
// removal step, so a session can't be opened while the site is being removed.
//
// Privacy rule: logs hold fixed words only, never an id, an address or a URL.
import { randomUUID } from 'node:crypto'
import { formatUsDate } from './billing-mail'
import { formatMoney } from './price'
import type { ScriptTwin } from './lifecycle'

const DAY = 86400

/** A late yes is accepted for this long after the free end (the removal date). */
export const LATE_YES_SECONDS = 30 * DAY
/** A Checkout session is open at most this long. */
export const LATE_SESSION_SECONDS = DAY
/** Stripe refuses a session that expires sooner than 30 minutes; we ask for a little more. */
export const LATE_MIN_SESSION_SECONDS = 31 * 60
/** An open session this close to expiring is not handed out again; a new one is opened. */
export const LATE_REUSE_MARGIN_SECONDS = 10 * 60
/** The lock shared with the removal step. */
export const LATE_LOCK_SECONDS = 300
/**
 * A holder writes only while this much of the lock's life is left (and the lock
 * still holds its token): a slow Stripe call can't outlive the lock and then
 * write over what the next holder did.
 */
export const LATE_LOCK_WRITE_MARGIN_SECONDS = 60

/** Where Checkout sends the organizer: only this host is followed by the page. */
export const CHECKOUT_URL_PREFIX = 'https://checkout.stripe.com/'

export const lateKey = (subscriptionId: string) => `pilot:late:${subscriptionId}`
export const lateLockKey = (subscriptionId: string) => `pilot:late:${subscriptionId}:lock`

export interface LateRecord {
  state: 'open' | 'continued' | 'removing'
  /** The open (or paid) Checkout session. */
  sessionId?: string
  url?: string
  /** Seconds. */
  expiresAt?: number
  /** Set once a session is paid. */
  newSubscriptionId?: string
  /** What the organizer paid on the Checkout page, in the currency's smallest unit. */
  amountPaid?: number
  currency?: string
  /** Seconds. */
  paidAt?: number
  /** A second paid session for the same pilot: a person must refund one. */
  duplicate?: string
  /** Seconds: the last change. */
  at: number
}

export interface LateRedis {
  get: <T = unknown>(key: string) => Promise<T | null>
  set: (key: string, value: unknown, opts?: { nx?: boolean, ex?: number }) => Promise<unknown>
  del: (...keys: string[]) => Promise<unknown>
  eval: (script: string, keys: string[], args: unknown[]) => Promise<unknown>
}

/**
 * Writes the record only while the lock still holds this holder's token, in
 * one step, so a holder whose lock ran out can't write over the next one.
 * KEYS: lock, record. ARGV: token, record JSON. Answers 1 written, 0 not.
 */
export const LATE_WRITE_IF_OWNER_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[2], ARGV[2])
  return 1
end
return 0`

/** Deletes the lock only if it still holds this token. KEYS: lock. ARGV: token. */
export const LATE_RELEASE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`

/** JavaScript stand-ins for the tests' in-memory Redis. */
export const LATE_TWINS: Array<[script: string, twin: ScriptTwin]> = [
  [LATE_WRITE_IF_OWNER_SCRIPT, (r, keys, args) => {
    if (r.get(keys[0]!) !== args[0]) return 0
    r.set(keys[1]!, args[1]!, {})
    return 1
  }],
  [LATE_RELEASE_SCRIPT, (r, keys, args) => (r.get(keys[0]!) === args[0] ? r.del(keys[0]!) : 0)]
]

/** The subset of a Stripe Checkout session this module reads. */
export interface LateSession {
  id: string
  status?: string | null
  payment_status?: string | null
  url?: string | null
  expires_at?: number | null
  subscription?: string | { id?: string } | null
  amount_total?: number | null
  currency?: string | null
  created?: number | null
  metadata?: Record<string, string> | null
  /** The new subscription's first invoice (subscription mode): an id, or expanded. */
  invoice?: string | LateInvoice | null
}

/** The part of an invoice that says when Stripe took the payment. */
export interface LateInvoice {
  id?: string
  status_transitions?: { paid_at?: number | null } | null
}

/** Reads an invoice: the receipt's date is when Stripe says it was paid. */
export interface LateInvoices {
  retrieve: (id: string) => Promise<LateInvoice>
}

export interface LateStripe {
  checkout: {
    sessions: {
      create: (params: Record<string, unknown>, opts: { idempotencyKey: string, maxNetworkRetries: number }) => Promise<LateSession>
      retrieve: (id: string) => Promise<LateSession>
      expire: (id: string) => Promise<LateSession>
    }
  }
  invoices: LateInvoices
}

/** The pilot subscription as the continue route has it. */
export interface LatePilot {
  id: string
  customer?: string | { id?: string, deleted?: boolean } | null
  metadata?: Record<string, string> | null
  items?: { data?: Array<{ price?: { id?: string } | null }> } | null
}

export interface LateDeps {
  redis: LateRedis
  stripe: LateStripe
  log: (msg: string) => void
  /** Milliseconds, for the lock's own deadline. Defaults to Date.now. */
  clock?: () => number
}

/** What the late steps answer; the continue route adds the date and price. */
export type LateAnswer =
  | { state: 'lapsed' }
  | { state: 'checkout', url: string }
  | { state: 'confirming' }
  | { state: 'continued', charged: string, chargedOn: string }
  | { state: 'ended' }
  | { state: 'unavailable' }

function asRecord(raw: unknown): LateRecord | null | 'bad' {
  if (raw === null || raw === undefined) return null
  let r = raw
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r)
    } catch {
      return 'bad'
    }
  }
  const o = r as Partial<LateRecord>
  if (!o || typeof o !== 'object' || !['open', 'continued', 'removing'].includes(String(o.state))) return 'bad'
  return o as LateRecord
}

/** The late record, null when there is none. A read error or a record we can't read is thrown. */
export async function readLateRecord(redis: LateRedis, subscriptionId: string): Promise<LateRecord | null> {
  const rec = asRecord(await redis.get(lateKey(subscriptionId)))
  if (rec === 'bad') throw new Error('pilot-late: unreadable record')
  return rec
}

function subId(sub: LateSession['subscription']): string {
  if (typeof sub === 'string') return sub
  return typeof sub?.id === 'string' ? sub.id : ''
}

function receipt(rec: LateRecord): LateAnswer {
  const charged = typeof rec.amountPaid === 'number' && rec.currency ? formatMoney(rec.amountPaid, rec.currency) ?? '' : ''
  const chargedOn = typeof rec.paidAt === 'number' ? formatUsDate(rec.paidAt) : ''
  return { state: 'continued', charged, chargedOn }
}

/**
 * Records a paid late session: the webhook on checkout.session.completed, and
 * the page's read when the organizer comes back before the webhook. Idempotent
 * for the same session. A second paid session (which the lock and the expiry of
 * every older session should rule out) is kept as `duplicate` and logged, for a
 * person to refund. Only a paid session counts. Returns the record now stored.
 */
/**
 * When Stripe took the payment: the first invoice's paid_at. A read error is
 * thrown (nothing is recorded, and the webhook is sent again); a session with
 * no invoice answers undefined, and the receipt then leaves the date out.
 */
async function stripePaidAt(session: LateSession, invoices: LateInvoices): Promise<number | undefined> {
  const inv = session.invoice
  if (!inv) return undefined
  const read = typeof inv === 'string' ? await invoices.retrieve(inv) : inv
  const at = read?.status_transitions?.paid_at
  return typeof at === 'number' ? at : undefined
}

export async function recordLateContinuation(redis: LateRedis, pilotSubscriptionId: string, session: LateSession, nowSec: number, log: (msg: string) => void, invoices: LateInvoices): Promise<LateRecord | null> {
  if (session.status !== 'complete' || session.payment_status !== 'paid') return null
  const newSub = subId(session.subscription)
  const rec = await readLateRecord(redis, pilotSubscriptionId)
  if (rec?.state === 'continued') {
    if (rec.sessionId === session.id || rec.duplicate === session.id) return rec
    const flagged: LateRecord = { ...rec, duplicate: session.id, at: nowSec }
    await redis.set(lateKey(pilotSubscriptionId), JSON.stringify(flagged))
    log('pilot-late: a second paid session for one pilot, refund one by hand')
    return flagged
  }
  // A paid session wins over a removal mark: the money is taken, so the site stays
  // (the removal step refuses a complete session before it marks, so this is a race).
  if (rec?.state === 'removing') log('pilot-late: paid while marked for removal, the site stays')
  const paidAt = await stripePaidAt(session, invoices)
  const next: LateRecord = {
    state: 'continued',
    sessionId: session.id,
    newSubscriptionId: newSub,
    amountPaid: typeof session.amount_total === 'number' ? session.amount_total : undefined,
    currency: session.currency ? String(session.currency).toLowerCase() : undefined,
    paidAt,
    at: nowSec
  }
  await redis.set(lateKey(pilotSubscriptionId), JSON.stringify(next))
  log('pilot-late: continued')
  return next
}

/** The page's read (GET) for a lapsed pilot. Changes nothing except to record a session Stripe says is paid. */
export async function readLate(pilotSubscriptionId: string, nowSec: number, deps: LateDeps): Promise<LateAnswer> {
  let rec: LateRecord | null
  try {
    rec = await readLateRecord(deps.redis, pilotSubscriptionId)
  } catch {
    deps.log('pilot-late: record unavailable')
    return { state: 'unavailable' }
  }
  if (rec?.state === 'continued') return receipt(rec)
  if (rec?.state === 'removing') return { state: 'ended' }
  if (rec?.state === 'open' && rec.sessionId) {
    let session: LateSession
    try {
      session = await deps.stripe.checkout.sessions.retrieve(rec.sessionId)
    } catch {
      deps.log('pilot-late: stripe unavailable')
      return { state: 'unavailable' }
    }
    if (session.status === 'complete') {
      if (session.payment_status !== 'paid') return { state: 'confirming' }
      try {
        const done = await recordLateContinuation(deps.redis, pilotSubscriptionId, session, nowSec, deps.log, deps.stripe.invoices)
        return done ? receipt(done) : { state: 'confirming' }
      } catch {
        deps.log('pilot-late: record unavailable')
        return { state: 'confirming' }
      }
    }
  }
  return { state: 'lapsed' }
}

interface Lock {
  token: string
  /** Milliseconds: no write after this. */
  writeBy: number
}

async function takeLock(deps: LateDeps, pilotSubscriptionId: string): Promise<Lock | null> {
  const clock = deps.clock ?? Date.now
  const token = randomUUID()
  const started = clock()
  if (!(await deps.redis.set(lateLockKey(pilotSubscriptionId), token, { nx: true, ex: LATE_LOCK_SECONDS }))) return null
  return { token, writeBy: started + (LATE_LOCK_SECONDS - LATE_LOCK_WRITE_MARGIN_SECONDS) * 1000 }
}

/** True while this holder may still go on: within its deadline and the lock still its own. */
async function stillHeld(deps: LateDeps, pilotSubscriptionId: string, lock: Lock): Promise<boolean> {
  if ((deps.clock ?? Date.now)() > lock.writeBy) return false
  try {
    return String(await deps.redis.get(lateLockKey(pilotSubscriptionId))) === lock.token
  } catch {
    return false
  }
}

/** Writes the record in one step with the ownership check; false when the lock is no longer this holder's. */
async function writeIfOwner(deps: LateDeps, pilotSubscriptionId: string, lock: Lock, rec: LateRecord): Promise<boolean> {
  if ((deps.clock ?? Date.now)() > lock.writeBy) return false
  return Number(await deps.redis.eval(LATE_WRITE_IF_OWNER_SCRIPT, [lateLockKey(pilotSubscriptionId), lateKey(pilotSubscriptionId)], [lock.token, JSON.stringify(rec)])) === 1
}

async function releaseLock(deps: LateDeps, pilotSubscriptionId: string, lock: Lock): Promise<void> {
  try {
    await deps.redis.eval(LATE_RELEASE_SCRIPT, [lateLockKey(pilotSubscriptionId)], [lock.token])
  } catch {
    // It runs out on its own.
  }
}

/**
 * The late yes (POST). Never charges: it hands back the URL of a Stripe
 * Checkout page that shows the total. An open session that still has time is
 * reused; an older one is expired before a new one is opened, so one pilot has
 * at most one session that can be paid. `removeAt` is the end of the yes
 * window (seconds); `returnUrl` builds the page's own address with a flag.
 */
export async function startLate(pilot: LatePilot, removeAt: number, nowSec: number, returnUrl: (flag: 'paid' | 'back') => string, deps: LateDeps): Promise<LateAnswer> {
  const { redis, stripe, log } = deps
  let locked: Lock | null
  try {
    locked = await takeLock(deps, pilot.id)
  } catch {
    log('pilot-late: record unavailable')
    return { state: 'unavailable' }
  }
  if (!locked) {
    log('pilot-late: busy')
    return { state: 'unavailable' }
  }
  try {
    let rec: LateRecord | null
    try {
      rec = await readLateRecord(redis, pilot.id)
    } catch {
      log('pilot-late: record unavailable')
      return { state: 'unavailable' }
    }
    if (rec?.state === 'continued') return receipt(rec)
    if (rec?.state === 'removing') return { state: 'ended' }

    // An earlier session: reuse it while it has time, record it if it was paid, otherwise expire it.
    if (rec?.state === 'open' && rec.sessionId) {
      let old: LateSession
      try {
        old = await stripe.checkout.sessions.retrieve(rec.sessionId)
      } catch {
        log('pilot-late: stripe unavailable')
        return { state: 'unavailable' }
      }
      if (old.status === 'complete') {
        if (old.payment_status !== 'paid') return { state: 'confirming' }
        try {
          const done = await recordLateContinuation(redis, pilot.id, old, nowSec, log, stripe.invoices)
          return done ? receipt(done) : { state: 'confirming' }
        } catch {
          return { state: 'confirming' }
        }
      }
      if (old.status === 'open' && old.url && (old.expires_at ?? 0) - nowSec > LATE_REUSE_MARGIN_SECONDS) {
        return { state: 'checkout', url: old.url }
      }
      if (old.status === 'open') {
        try {
          await stripe.checkout.sessions.expire(old.id)
        } catch {
          // It may have been paid a moment ago: read it again before opening another.
          let again: LateSession | null = null
          try {
            again = await stripe.checkout.sessions.retrieve(old.id)
          } catch {
            again = null
          }
          if (again?.status === 'complete' && again.payment_status === 'paid') {
            try {
              const done = await recordLateContinuation(redis, pilot.id, again, nowSec, log, stripe.invoices)
              if (done) return receipt(done)
            } catch {
              // fall through
            }
            return { state: 'confirming' }
          }
          if (again?.status !== 'expired') {
            log('pilot-late: could not expire an older session')
            return { state: 'unavailable' }
          }
        }
      }
    }

    // Stripe needs at least 30 minutes, so in the window's last half hour the
    // page may outlive it a little; the removal step closes it either way.
    const expiresAt = Math.max(Math.min(nowSec + LATE_SESSION_SECONDS, removeAt), nowSec + LATE_MIN_SESSION_SECONDS)
    const customer = typeof pilot.customer === 'string' ? pilot.customer : pilot.customer && !pilot.customer.deleted ? pilot.customer.id ?? '' : ''
    const priceId = pilot.items?.data?.[0]?.price?.id ?? ''
    if (!customer || !priceId) {
      log('pilot-late: pilot has no customer or price')
      return { state: 'unavailable' }
    }
    const meta = pilot.metadata ?? {}
    const subMeta: Record<string, string> = { pilot: 'continued', pilot_continued_from: pilot.id, pilot_continued_at: String(nowSec) }
    if (meta.provision_id) subMeta.provision_id = meta.provision_id
    if (meta.subdomain) subMeta.subdomain = meta.subdomain
    if (!(await stillHeld(deps, pilot.id, locked))) {
      log('pilot-late: lock lost')
      return { state: 'unavailable' }
    }
    let session: LateSession
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer,
        line_items: [{ price: priceId, quantity: 1 }],
        payment_method_types: ['card'],
        expires_at: expiresAt,
        success_url: returnUrl('paid'),
        cancel_url: returnUrl('back'),
        metadata: { pilot_continued_from: pilot.id },
        subscription_data: { metadata: subMeta }
      }, { idempotencyKey: `pilot-late-${pilot.id}-${nowSec}`, maxNetworkRetries: 0 })
    } catch {
      log('pilot-late: could not open a payment page')
      return { state: 'unavailable' }
    }
    if (!session.url || !session.url.startsWith(CHECKOUT_URL_PREFIX)) {
      log('pilot-late: the payment page has no usable address')
      try {
        await stripe.checkout.sessions.expire(session.id)
      } catch {
        // It expires on its own.
      }
      return { state: 'unavailable' }
    }
    const next: LateRecord = { state: 'open', sessionId: session.id, url: session.url, expiresAt: session.expires_at ?? expiresAt, at: nowSec }
    try {
      if (!(await writeIfOwner(deps, pilot.id, locked, next))) throw new Error('lock lost')
    } catch {
      // A session we can't find again must not stay payable.
      log('pilot-late: record unavailable')
      try {
        await stripe.checkout.sessions.expire(session.id)
      } catch {
        log('pilot-late: could not expire an unrecorded session')
      }
      return { state: 'unavailable' }
    }
    log('pilot-late: payment page opened')
    return { state: 'checkout', url: session.url }
  } finally {
    await releaseLock(deps, pilot.id, locked)
  }
}

/**
 * Marks a lapsed pilot as being removed (scripts/pilot-removal.mjs, run by a
 * person before removing the site). Takes the lock, expires any open session,
 * and refuses when a session was paid: that site stays.
 */
export type RemovalOutcome = 'marked' | 'continued' | 'busy' | 'session-still-open'

export async function markLateRemoval(pilotSubscriptionId: string, nowSec: number, deps: LateDeps): Promise<RemovalOutcome> {
  const { redis, stripe, log } = deps
  const lock = await takeLock(deps, pilotSubscriptionId)
  if (!lock) return 'busy'
  try {
    const rec = await readLateRecord(redis, pilotSubscriptionId)
    if (rec?.state === 'continued') return 'continued'
    if (rec?.state === 'open' && rec.sessionId) {
      const session = await stripe.checkout.sessions.retrieve(rec.sessionId)
      if (session.status === 'complete') {
        if (session.payment_status === 'paid') await recordLateContinuation(redis, pilotSubscriptionId, session, nowSec, log, stripe.invoices)
        return 'continued'
      }
      if (session.status === 'open') {
        try {
          await stripe.checkout.sessions.expire(session.id)
        } catch {
          const again = await stripe.checkout.sessions.retrieve(session.id)
          if (again.status === 'complete') {
            if (again.payment_status === 'paid') await recordLateContinuation(redis, pilotSubscriptionId, again, nowSec, log, stripe.invoices)
            return 'continued'
          }
          if (again.status !== 'expired') return 'session-still-open'
        }
      }
    }
    return (await writeIfOwner(deps, pilotSubscriptionId, lock, { state: 'removing', at: nowSec })) ? 'marked' : 'busy'
  } finally {
    await releaseLock(deps, pilotSubscriptionId, lock)
  }
}

// The free pilot ends unless its organizer says yes (fresh3 Phase 23, pilot
// end; project rule: "a free pilot is never charged unless its
// organizer says yes after the free months. No yes means no charge.").
// Plain module, no Nitro globals: Stripe, Redis, fetch and the secret are
// injected, so tests import it directly.
//
// How it holds:
//   1. Checkout (checkout.ts) freezes pilotMonths and pilotEndsAt on the
//      sign-up when the code is 100% off. pilotEndsAt is the checkout time plus
//      the free months (the day clamped to the month's last day, as Stripe
//      does), less PILOT_END_MARGIN_SECONDS. The subscription starts later, at
//      ready, so its last free period ends after pilotEndsAt; the margin covers
//      the clamp keeping the time of day (the plan review's counterexample).
//   2. Billing (billing.ts) creates the subscription with cancel_at at that
//      end, so Stripe ends it by itself; a pilot it cannot give an end, or
//      whose first invoice is not already paid, is rejected, never charged.
//   3. About 14 days before the end, the notice step (sweepPilotNotices, on
//      the cron sweep) mails the organizer the date, the price and a continue
//      link. It reads Stripe, not Redis: the sign-up records are long gone by
//      then.
//   4. The link's POST (handlePilotContinue) clears cancel_at. Only that yes
//      makes a pilot a paying subscription.
//   5. For 30 days after the end, unless the site is already removed, the same link still works
//      (pilot-late.ts): the yes then opens a Stripe payment page that shows
//      the total, and nothing is charged unless the organizer pays there.
//
// Privacy rule: logs hold fixed words only, never an id, an address or a URL.
import { deriveKeyHex, openKey, sealKey } from './byo-key'
import { formatUsDate } from './billing-mail'
import { buildPilotEndMail, REPLY_TO } from './mail-copy'
import { formatPrice, type PriceLike } from './price'
import { LATE_YES_SECONDS, readLate, startLate, type LateDeps, type LateAnswer } from './pilot-late'
import { PILOT_CONTINUE_TOKEN_RE, type PilotContinueState } from '../../shared/pilot-continue'

const DAY = 86400

/** The end falls this long before the clamped date: never inside a full-price period. */
export const PILOT_END_MARGIN_SECONDS = 2 * DAY
/** The notice goes out this many days before the end. */
export const PILOT_NOTICE_DAYS = 14
/** The notice step runs at most once per this many seconds. */
export const PILOT_NOTICE_GATE_SECONDS = 6 * 3600
export const PILOT_NOTICE_GATE_KEY = 'pilot-notice:run'
/** A pilot whose end is this close (or past) when its subscription would start is rejected. */
export const PILOT_MIN_AHEAD_SECONDS = DAY
/** The HKDF label. Changing it makes every link already sent stop working. */
export const PILOT_CONTINUE_KEY_LABEL = 'localnodes-pilot-continue-v1'
/** Where the link points: the sign-up site, as the unsubscribe link. */
export const PILOT_CONTINUE_ORIGIN = 'https://localnodes.xyz'
/** The purpose field inside the token. */
const PURPOSE = 'pilot-continue'

/** Unix seconds plus calendar months in UTC, the day clamped to the target month's last day, the time of day kept. */
export function addMonthsClampedUtc(seconds: number, months: number): number {
  const d = new Date(seconds * 1000)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + months
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  const day = Math.min(d.getUTCDate(), last)
  return Math.floor(Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000)
}

/** The pilot's frozen end: checkout time plus the free months, less the margin. */
export function pilotEndsAt(checkoutSec: number, months: number): number {
  return addMonthsClampedUtc(checkoutSec, months) - PILOT_END_MARGIN_SECONDS
}

/** The coupon fields the classification reads. */
export interface CouponLike {
  id?: string
  percent_off?: number | null
  amount_off?: number | null
  duration?: string | null
  duration_in_months?: number | null
}

export type PilotClass = { pilot: true, months: number } | { pilot: false } | { refuse: true }

/**
 * What a code's coupon makes of a sign-up. Only 100% off repeating N months is
 * a pilot, of N months. 100% off once is a paid discount, never a pilot: it is
 * used up by the first invoice, so on a price billed more often than monthly a
 * second invoice would charge the card inside the free month. Anything that is
 * not 100% off is the paid path too. Refused: a coupon that is not an expanded
 * object (it can't be classified), and a 100%-off coupon that is forever or
 * has no whole month count (no end could be set).
 */
export function pilotMonthsOf(coupon: unknown): PilotClass {
  if (typeof coupon !== 'object' || coupon === null) return { refuse: true }
  const c = coupon as CouponLike
  if (c.percent_off !== 100) return { pilot: false }
  if (c.duration === 'once') return { pilot: false }
  if (c.duration === 'repeating') {
    const n = c.duration_in_months
    return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? { pilot: true, months: n } : { refuse: true }
  }
  return { refuse: true }
}

const intOf = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) ? n : null
}

/**
 * What billing reads off a sign-up record. No pilotMonths: not a pilot (the
 * paid path, unchanged). A pilot gets its frozen end as cancelAt, or null when
 * the end is missing, unreadable or not more than a day after `nowSec`.
 */
export function pilotEndOf(signup: Record<string, unknown>, nowSec: number): { pilot: false } | { pilot: true, cancelAt: number | null } {
  if (signup.pilotMonths === undefined || signup.pilotMonths === null || signup.pilotMonths === '') return { pilot: false }
  const end = intOf(signup.pilotEndsAt)
  return { pilot: true, cancelAt: end !== null && end > nowSec + PILOT_MIN_AHEAD_SECONDS ? end : null }
}

// ---------------------------------------------------------------------------
// the continue token

const keyFor = (secret: string) => deriveKeyHex(secret, PILOT_CONTINUE_KEY_LABEL)

/** Seals the subscription and the end the link was minted for. Throws when the secret is missing. */
export function sealContinueToken(subscriptionId: string, cancelAt: number, secret: string): string {
  return sealKey(keyFor(secret), JSON.stringify({ p: PURPOSE, s: subscriptionId, c: cancelAt }))
}

/** The token's subscription and end, or null when it is malformed, forged, sealed under another key or for another purpose. */
export function openContinueToken(token: string, secret: string): { subscriptionId: string, cancelAt: number } | null {
  if (typeof token !== 'string' || !PILOT_CONTINUE_TOKEN_RE.test(token) || !secret) return null
  try {
    const parsed = JSON.parse(openKey(keyFor(secret), token)) as { p?: unknown, s?: unknown, c?: unknown } | null
    if (!parsed || typeof parsed !== 'object' || parsed.p !== PURPOSE) return null
    if (typeof parsed.s !== 'string' || !parsed.s.startsWith('sub_')) return null
    if (typeof parsed.c !== 'number' || !Number.isInteger(parsed.c)) return null
    return { subscriptionId: parsed.s, cancelAt: parsed.c }
  } catch {
    return null
  }
}

/** The continue link for a subscription's end. */
export function continueUrl(subscriptionId: string, cancelAt: number, secret: string, origin = PILOT_CONTINUE_ORIGIN): string {
  return `${origin.replace(/\/+$/, '')}/pilot/continue?t=${sealContinueToken(subscriptionId, cancelAt, secret)}`
}

// ---------------------------------------------------------------------------
// the subscription as Stripe returns it

export interface PilotSubscription {
  id: string
  status: string
  cancel_at?: number | null
  ended_at?: number | null
  metadata?: Record<string, string> | null
  items?: { data?: Array<{ price?: (PriceLike & { id?: string }) | null }> } | null
  customer?: string | { id?: string, email?: string | null, deleted?: boolean } | null
}

function priceOf(sub: PilotSubscription): string {
  const price = sub.items?.data?.[0]?.price
  if (!price) return ''
  return formatPrice(price, String(price.currency ?? '').toLowerCase()) ?? ''
}

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number, status?: number } | null
  return e?.statusCode ?? e?.status
}

// ---------------------------------------------------------------------------
// the continue route

export interface PilotContinueStripe {
  subscriptions: {
    retrieve: (id: string) => Promise<PilotSubscription | Record<string, unknown>>
    update: (id: string, params: Record<string, unknown>, opts: { idempotencyKey: string, maxNetworkRetries: number }) => Promise<unknown>
  }
}

export interface PilotContinueDeps {
  stripe: PilotContinueStripe
  /** inviteHashSecret (NUXT_INVITE_HASH_SECRET). */
  secret: string
  /** Milliseconds. */
  now?: () => number
  log?: (msg: string) => void
  /** The late yes (pilot-late.ts). Without it an ended pilot answers ended, as before. */
  late?: Omit<LateDeps, 'log'>
  /** Where Stripe's payment page sends the organizer back to. */
  origin?: string
}

export interface PilotContinueBody {
  state: Exclude<PilotContinueState, 'invalid' | 'unavailable'>
  date: string
  price: string
  /** checkout: Stripe's payment page. */
  url?: string
  /** continued after a late yes: what was paid on the payment page, and when. */
  charged?: string
  chargedOn?: string
}

export type PilotContinueOutcome =
  | { status: 200, body: PilotContinueBody }
  | { status: 400, body: { state: 'invalid' } }
  | { status: 503, body: { state: 'unavailable' } }

const INVALID = { status: 400 as const, body: { state: 'invalid' as const } }
const UNAVAILABLE = { status: 503 as const, body: { state: 'unavailable' as const } }

type Judged = { state: 'ends' | 'continued' | 'ended' | 'lapsed' | 'unavailable' } | { state: 'invalid' }

/**
 * The subscription's state against the end the token was minted for. With
 * `late`, a pilot Stripe ended at that end is lapsed until LATE_YES_SECONDS
 * after it, and a pilot past its end that Stripe has not ended yet is a
 * moment's wait (unavailable). Without it both read ended, as before.
 */
function judge(sub: PilotSubscription, cancelAt: number, nowSec: number, late: boolean): Judged {
  const meta = sub.metadata ?? {}
  if (meta.pilot === 'continued') return { state: 'continued' }
  if (meta.pilot !== 'ends') return { state: 'invalid' }
  if (sub.status === 'canceled') {
    // Stripe keeps cancel_at on a subscription it ended; ended_at is the same time.
    if (sub.cancel_at !== cancelAt && sub.ended_at !== cancelAt) return { state: 'invalid' }
    if (!late || nowSec >= cancelAt + LATE_YES_SECONDS) return { state: 'ended' }
    return { state: 'lapsed' }
  }
  if (sub.cancel_at !== cancelAt) return { state: 'invalid' }
  if (cancelAt <= nowSec) return late ? { state: 'unavailable' } : { state: 'ended' }
  if (sub.status !== 'active') return { state: 'invalid' }
  return { state: 'ends' }
}

function lateOutcome(answer: LateAnswer, date: string, price: string): PilotContinueOutcome {
  switch (answer.state) {
    case 'unavailable': return UNAVAILABLE
    case 'checkout': return { status: 200, body: { state: 'checkout', date, price, url: answer.url } }
    case 'continued': return { status: 200, body: { state: 'continued', date, price, charged: answer.charged, chargedOn: answer.chargedOn } }
    default: return { status: 200, body: { state: answer.state, date, price } }
  }
}

/**
 * GET shows the date, the price and the state and changes nothing (a mail
 * scanner opening the link). POST is the yes: it re-checks that the
 * subscription is an active pilot ending at the token's end, then clears
 * cancel_at and records the yes. A repeat answers continued.
 */
export async function handlePilotContinue(method: 'GET' | 'POST', token: string, deps: PilotContinueDeps): Promise<PilotContinueOutcome> {
  const log = deps.log ?? (() => {})
  if (!deps.secret) {
    log('pilot-continue: not configured')
    return UNAVAILABLE
  }
  const opened = openContinueToken(token, deps.secret)
  if (!opened) {
    log('pilot-continue: refused')
    return INVALID
  }
  const nowSec = Math.floor((deps.now ?? Date.now)() / 1000)
  const read = async (): Promise<PilotSubscription | 'invalid' | 'unavailable'> => {
    try {
      return await deps.stripe.subscriptions.retrieve(opened.subscriptionId) as PilotSubscription
    } catch (err) {
      return statusOf(err) === 404 ? 'invalid' : 'unavailable'
    }
  }
  const sub = await read()
  if (sub === 'invalid') {
    log('pilot-continue: refused')
    return INVALID
  }
  if (sub === 'unavailable') {
    log('pilot-continue: stripe unavailable')
    return UNAVAILABLE
  }
  const date = formatUsDate(opened.cancelAt)
  const price = priceOf(sub)
  const judged = judge(sub, opened.cancelAt, nowSec, Boolean(deps.late))
  if (judged.state === 'invalid') {
    log('pilot-continue: refused')
    return INVALID
  }
  if (judged.state === 'unavailable') {
    log('pilot-continue: end not yet applied')
    return UNAVAILABLE
  }
  // Past the window: a page opened in its last half hour may have been paid
  // just after it, so a paid (or confirming) record still answers; else ended.
  if (judged.state === 'ended' && deps.late && sub.status === 'canceled') {
    const answer = await readLate(opened.subscriptionId, nowSec, { ...deps.late, log })
    if (answer.state === 'continued' || answer.state === 'confirming' || answer.state === 'unavailable') return lateOutcome(answer, date, price)
    return { status: 200, body: { state: 'ended', date, price } }
  }
  if (judged.state === 'lapsed' && deps.late) {
    const lateDeps: LateDeps = { ...deps.late, log }
    if (method === 'GET' || !price) return lateOutcome(await readLate(opened.subscriptionId, nowSec, lateDeps), date, price)
    const origin = deps.origin ?? PILOT_CONTINUE_ORIGIN
    const back = (flag: 'paid' | 'back') => `${origin}/pilot/continue?t=${encodeURIComponent(token)}&${flag}=1`
    return lateOutcome(await startLate(sub, opened.cancelAt + LATE_YES_SECONDS, nowSec, back, lateDeps), date, price)
  }
  if (method === 'GET' || judged.state !== 'ends') {
    return { status: 200, body: { state: judged.state as PilotContinueBody['state'], date, price } }
  }
  try {
    await deps.stripe.subscriptions.update(
      opened.subscriptionId,
      { cancel_at: '', metadata: { pilot: 'continued', pilot_continued_at: String(nowSec) } },
      { idempotencyKey: `pilot-continue-${opened.subscriptionId}-${opened.cancelAt}`, maxNetworkRetries: 0 }
    )
  } catch {
    // A first try may have landed (a double click, a lost reply): read again before saying no.
    const again = await read()
    if (typeof again === 'object' && again.metadata?.pilot === 'continued') {
      log('pilot-continue: continued')
      return { status: 200, body: { state: 'continued', date, price } }
    }
    log('pilot-continue: update failed')
    return UNAVAILABLE
  }
  log('pilot-continue: continued')
  return { status: 200, body: { state: 'continued', date, price } }
}

// ---------------------------------------------------------------------------
// the notice step

export interface PilotNoticeStripe {
  subscriptions: {
    list: (params: { status: 'active', expand: string[], limit: number, starting_after?: string }) => Promise<{ data: Array<PilotSubscription | Record<string, unknown>>, has_more: boolean }>
    update: (id: string, params: Record<string, unknown>, opts: { idempotencyKey: string, maxNetworkRetries: number }) => Promise<unknown>
  }
}

export interface PilotNoticeDeps {
  redis: {
    set: (key: string, value: string, opts: { nx: true, ex: number } | { ex: number }) => Promise<unknown>
    get: (key: string) => Promise<unknown>
  }
  stripe: PilotNoticeStripe
  fetch: (url: string, opts: { method: 'POST', headers: Record<string, string>, body: Record<string, unknown> }) => Promise<unknown>
  /** NUXT_RESEND_API_KEY. */
  apiKey: string
  /** NUXT_MAIL_FROM. */
  from: string
  /** inviteHashSecret, for the continue link. */
  secret: string
  /** Milliseconds. */
  now?: () => number
  log?: (msg: string) => void
}

export type PilotNoticeResult =
  | { ran: true, due: number, sent: number, errors: number }
  | { ran: false, unconfigured?: true }

/** At most this many list pages per run (100 subscriptions each). */
const MAX_PAGES = 50

/** Where a pilot's notice is kept, built once, so every retry sends the very same request. */
const noticeRecordKey = (subscriptionId: string) => `pilot-notice:mail:${subscriptionId}`
/** Longer than the 14-day notice window. */
const NOTICE_RECORD_SECONDS = 60 * DAY
/**
 * Retries stop this long after the first try: inside Resend's 24-hour
 * Idempotency-Key window, so a retry can never be delivered as a second mail.
 * After it, an unconfirmed notice waits for a person (the reconcile report's
 * "pilot notice not sent" row).
 */
export const PILOT_NOTICE_RETRY_SECONDS = 20 * 3600

interface NoticeBody {
  from: string
  to: string[]
  reply_to: string
  subject: string
  text: string
  html: string
}

interface NoticeRecord {
  /** The whole Resend request body, sent byte for byte on every try. */
  body: NoticeBody
  /** Seconds; written before the first send. */
  firstTryAt?: number
  /** Seconds; written once Resend accepted the mail. */
  sentAt?: number
}

function asNoticeRecord(raw: unknown): NoticeRecord | null {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const b = r.body as Record<string, unknown> | undefined
  if (typeof b !== 'object' || b === null) return null
  const strings = ['from', 'reply_to', 'subject', 'text', 'html'] as const
  if (strings.some(k => typeof b[k] !== 'string')) return null
  if (!Array.isArray(b.to) || b.to.length !== 1 || typeof b.to[0] !== 'string') return null
  const body: NoticeBody = { from: b.from as string, to: [b.to[0]], reply_to: b.reply_to as string, subject: b.subject as string, text: b.text as string, html: b.html as string }
  return {
    body,
    ...(typeof r.firstTryAt === 'number' ? { firstTryAt: r.firstTryAt } : {}),
    ...(typeof r.sentAt === 'number' ? { sentAt: r.sentAt } : {})
  }
}

/**
 * Mail every active pilot ending within PILOT_NOTICE_DAYS that has not had its
 * notice, then mark the subscription (metadata pilot_notice_sent). Runs at
 * most once per 6 hours.
 *
 * The whole request is built once and kept in Redis, with the time of the
 * first try, before anything is sent. A retry sends the very same request under
 * the same Idempotency-Key, so Resend delivers it once; retries stop
 * PILOT_NOTICE_RETRY_SECONDS after the first try, inside Resend's 24 hours.
 * Once a send is accepted the record says so, and later runs only write the
 * mark, with the first send's time. Nothing is sent when the record cannot be
 * written first, or when the address or the sender changed after a try: that
 * waits for a person. A notice never sent costs nobody money: no yes, no charge.
 */
export async function sweepPilotNotices(deps: PilotNoticeDeps): Promise<PilotNoticeResult> {
  const log = deps.log ?? (() => {})
  if (!deps.apiKey || !deps.from || !deps.secret) {
    log('pilot-notice: not configured')
    return { ran: false, unconfigured: true }
  }
  const nowMs = (deps.now ?? Date.now)()
  const nowSec = Math.floor(nowMs / 1000)
  const gate = await deps.redis.set(PILOT_NOTICE_GATE_KEY, String(nowSec), { nx: true, ex: PILOT_NOTICE_GATE_SECONDS })
  if (!gate) return { ran: false }

  const result = { ran: true as const, due: 0, sent: 0, errors: 0 }
  let after: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, has_more } = await deps.stripe.subscriptions.list({
      status: 'active',
      expand: ['data.customer'],
      limit: 100,
      ...(after ? { starting_after: after } : {})
    })
    for (const raw of data) {
      const sub = raw as PilotSubscription
      const meta = sub.metadata ?? {}
      const end = sub.cancel_at
      if (meta.pilot !== 'ends' || meta.pilot_notice_sent) continue
      if (typeof end !== 'number' || end <= nowSec || end - nowSec > PILOT_NOTICE_DAYS * DAY) continue
      result.due++
      const customer = sub.customer
      const to = typeof customer === 'object' && customer !== null && !customer.deleted && typeof customer.email === 'string' ? customer.email.trim() : ''
      const price = priceOf(sub)
      if (!to || !price) {
        log('pilot-notice: pilot without an address or a price, nothing sent')
        result.errors++
        continue
      }
      const key = noticeRecordKey(sub.id)
      let record: NoticeRecord | null
      try {
        record = asNoticeRecord(await deps.redis.get(key))
      } catch {
        log('pilot-notice: mail not recorded, nothing sent, next run retries')
        result.errors++
        continue
      }
      if (record?.sentAt === undefined) {
        if (record?.firstTryAt !== undefined) {
          if (record.body.to[0] !== to || record.body.from !== deps.from || record.body.reply_to !== REPLY_TO) {
            log('pilot-notice: address or sender changed after a try, needs a person')
            result.errors++
            continue
          }
          if (nowSec - record.firstTryAt >= PILOT_NOTICE_RETRY_SECONDS) {
            log('pilot-notice: not confirmed within a day, needs a person')
            result.errors++
            continue
          }
        } else {
          // No try yet: build (or rebuild) the request, and record it with this try's time before sending.
          const mail = buildPilotEndMail({ date: formatUsDate(end), lateUntil: formatUsDate(end + LATE_YES_SECONDS), price, link: continueUrl(sub.id, end, deps.secret) })
          record = {
            body: { from: deps.from, to: [to], reply_to: REPLY_TO, subject: mail.subject, text: mail.text, html: mail.html },
            firstTryAt: nowSec
          }
          try {
            await deps.redis.set(key, JSON.stringify(record), { ex: NOTICE_RECORD_SECONDS })
          } catch {
            log('pilot-notice: mail not recorded, nothing sent, next run retries')
            result.errors++
            continue
          }
        }
        try {
          await deps.fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${deps.apiKey}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': `pilot-notice-${sub.id}`
            },
            // The recorded request, field for field (reply_to was checked equal above or just built).
            body: { from: record.body.from, to: record.body.to, reply_to: REPLY_TO, subject: record.body.subject, text: record.body.text, html: record.body.html }
          })
        } catch {
          log('pilot-notice: mail not sent, next run retries')
          result.errors++
          continue
        }
        record = { ...record, sentAt: nowSec }
        try {
          await deps.redis.set(key, JSON.stringify(record), { ex: NOTICE_RECORD_SECONDS })
        } catch {
          log('pilot-notice: mail sent, record not updated')
        }
      }
      try {
        // A fresh key each run: the params never change, and Stripe would replay a stored failure.
        await deps.stripe.subscriptions.update(
          sub.id,
          { metadata: { pilot_notice_sent: String(record.sentAt) } },
          { idempotencyKey: `pilot-notice-mark-${sub.id}-${nowSec}`, maxNetworkRetries: 0 }
        )
        result.sent++
      } catch {
        log('pilot-notice: mail sent, mark not written')
        result.errors++
      }
    }
    if (!has_more || data.length === 0) break
    after = String((data[data.length - 1] as { id: string }).id)
  }
  return result
}

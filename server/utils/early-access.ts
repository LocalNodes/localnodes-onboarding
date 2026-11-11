// Early-access list (Tom, 2026-11-06, PR #9). Plain module, no Nitro globals,
// so tests import it directly; server/api/early-access.post.ts wires it up.
//
// Protection: server-side validation; a honeypot field; a per-IP rate limit
// that fails closed (Redis down or not configured: a generic 503, nothing
// sent); no CAPTCHA. Every accepted request gets the same reply, whether the email is
// new, already on the list, caught by the honeypot or refused by Resend, so
// the reply never reveals who is on the list. The email address is never
// logged, never put in an error message and never used as a key.
import * as v from 'valibot'
import { createHash } from 'node:crypto'
import { SERVER_ERROR_MESSAGE } from '../../shared/ai-choice'

export const earlyAccessSchema = v.object({
  email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.maxLength(254), v.email()),
  community: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(80)), ''),
  groupKind: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(80)), ''),
  // Honeypot: hidden from people, left empty by them; bots fill it.
  hpField: v.optional(v.string(), '')
})

export type EarlyAccessInput = v.InferOutput<typeof earlyAccessSchema>

/** The one reply every accepted request gets. */
export const ACCEPTED = { ok: true, message: 'Thanks. We\'ll email you when LocalNodes launches.' } as const

export const RATE_LIMIT = { max: 5, windowSeconds: 3600 }

/**
 * Every accepted request replies at this point after it arrived, whatever the
 * Resend work is doing: the work starts, the reply waits for the floor and
 * not for the work, and the work finishes in the background (kept alive with
 * waitUntil). So the reply time doesn't show whether Resend added a contact,
 * refused a duplicate, retried without properties, took longer than the
 * floor, or was skipped for the honeypot (Codex P2, twice).
 */
export const RESPONSE_FLOOR_MS = 1000

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** The subset of the Upstash client the rate limit uses. */
export interface LimiterRedis {
  incr: (key: string) => Promise<number>
  ttl: (key: string) => Promise<number>
  expire: (key: string, seconds: number) => Promise<unknown>
}

/**
 * Per-IP rate limit. INCR, then (re)apply the window's EXPIRE whenever the key
 * has no TTL (-1), not only on the first request: if an EXPIRE ever fails, the
 * next request repairs it, so an IP is never blocked forever (Codex P2).
 */
export async function allowRequest(redis: LimiterRedis, ipHash: string, limit = RATE_LIMIT): Promise<boolean> {
  const key = `rl:early-access:${ipHash}`
  const count = await redis.incr(key)
  try {
    if (count === 1 || (await redis.ttl(key)) === -1) await redis.expire(key, limit.windowSeconds)
  } catch {
    // Repaired on the next request (TTL -1 again).
  }
  return count <= limit.max
}

/**
 * The early-access limiter, failing closed (security follow-up, 2026-11-09).
 * getRedis is useRedis() in the route; it throws when Redis isn't configured,
 * and the client throws when Redis can't be reached. Either way the returned
 * promise rejects and handleEarlyAccess refuses: the limit never fails open.
 */
export function earlyAccessLimiter(getRedis: () => LimiterRedis, limit = RATE_LIMIT): (ipHash: string) => Promise<boolean> {
  return async ipHash => allowRequest(getRedis(), ipHash, limit)
}

export type Outcome =
  | { status: 200, body: typeof ACCEPTED }
  | { status: 400, body: { ok: false, message: string } }
  | { status: 429, body: { ok: false, message: string } }
  | { status: 503, body: { ok: false, message: string } }

export interface Contact {
  email: string
  community: string
  groupKind: string
  /** More contact properties, as strings: Resend properties are String or Number only (TA-8). */
  properties?: Record<string, string>
}

export interface Deps {
  /** Count this request for the IP; returns false when over the limit. If it throws, the request is refused. */
  allow: (ipHash: string) => Promise<boolean>
  /** Add the contact to the list. May throw; the error is swallowed. */
  addContact: (contact: Contact) => Promise<void>
  /** Whether the list is configured (API key and segment id set). */
  configured: boolean
  /** Logs without the email address. */
  log?: (msg: string) => void
  /** Response-time floor for accepted requests (tests may shorten it). */
  floorMs?: number
  /** Keeps background work alive after the reply (event.waitUntil, Vercel's waitUntil). */
  keepAlive?: (work: Promise<void>) => void
}

export function hashIp(ip: string | undefined): string {
  return createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 32)
}

export async function handleEarlyAccess(raw: unknown, ip: string | undefined, deps: Deps): Promise<Outcome> {
  const started = Date.now()
  const accepted = async (): Promise<Outcome> => {
    const wait = (deps.floorMs ?? RESPONSE_FLOOR_MS) - (Date.now() - started)
    if (wait > 0) await sleep(wait)
    return { status: 200, body: ACCEPTED }
  }
  if (!deps.configured) {
    return { status: 503, body: { ok: false, message: 'Early access sign-up isn\'t open yet. Please try again later.' } }
  }
  const parsed = v.safeParse(earlyAccessSchema, raw)
  if (!parsed.success) {
    return { status: 400, body: { ok: false, message: 'Please enter a valid email address.' } }
  }
  // Count this request for the IP before anything else. If the limiter can't
  // answer (Redis down or not configured), refuse and send nothing: unbounded
  // sends cost money and reputation, a refused sign-up only costs a retry.
  let allowed: boolean
  try {
    allowed = await deps.allow(hashIp(ip))
  } catch {
    deps.log?.('early-access: rate limit unavailable, nothing sent')
    return { status: 503, body: { ok: false, message: SERVER_ERROR_MESSAGE } }
  }
  if (!allowed) {
    return { status: 429, body: { ok: false, message: 'Too many tries. Please wait a while and try again.' } }
  }
  const input = parsed.output
  if (input.hpField) {
    // Honeypot filled: answer as if accepted, add nothing.
    return accepted()
  }
  // Start the Resend work, reply at the floor whatever its state, and let it
  // finish after the reply. Errors after the reply are logged without the email.
  const work = (async () => {
    try {
      await deps.addContact({ email: input.email, community: input.community, groupKind: input.groupKind })
    } catch (err) {
      // Never the address, never the error body: only a status code if any.
      const status = (err as { statusCode?: number, status?: number })?.statusCode ?? (err as { status?: number })?.status
      deps.log?.(`early-access: contact not added (status ${status ?? 'unknown'})`)
    }
  })()
  deps.keepAlive?.(work)
  return accepted()
}

type Fetcher = (url: string, opts: { method: 'POST', headers: Record<string, string>, body: unknown }) => Promise<unknown>

/**
 * Add a contact through the Resend Contacts API (POST /contacts, with the
 * segment by id; Resend docs, checked 2026-11-06 via ctx7). The optional
 * fields go in the same create call, as contact properties. Resend stores
 * properties only when they already exist and fails the call on an unknown
 * one, so a failed call with properties is retried once without them: the
 * address is kept even if the properties aren't set up yet. The response-time
 * floor hides the retry's extra time.
 */
export async function addResendContact(contact: Contact, apiKey: string, segmentId: string, fetcher: Fetcher): Promise<void> {
  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  const base = { email: contact.email, unsubscribed: false, segments: [{ id: segmentId }] }
  const properties: Record<string, string> = {}
  if (contact.community) properties.community_name = contact.community
  if (contact.groupKind) properties.group_kind = contact.groupKind
  Object.assign(properties, contact.properties)
  if (Object.keys(properties).length) {
    try {
      await fetcher('https://api.resend.com/contacts', { method: 'POST', headers, body: { ...base, properties } })
      return
    } catch {
      // Fall through: retry without properties.
    }
  }
  await fetcher('https://api.resend.com/contacts', { method: 'POST', headers, body: base })
}

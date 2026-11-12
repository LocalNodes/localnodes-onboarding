// Invited sign-up (Phase 23, plan 23-02; Tom's decisions D-01 to D-05). Plain
// module, no Nitro globals, Redis and mail injected, so tests import it
// directly; server/api/invite/*.post.ts and server/middleware/launch-gate.ts
// wire it up.
//
// The flow: an address is put on the invite list. The person asks for a
// sign-in link; if (and only if) the address is invited and open, a one-time
// link goes to it. Opening the link and pressing the button POSTs the token,
// which is consumed once and turns into a 2-hour invited session cookie. The
// closed gate trusts that server-side session and nothing the browser says.
//
// Privacy rule, same as early-access.ts: the email address is never logged,
// never put in an error message and never used as a Redis key. Keys use an
// HMAC of the address (a plain hash could be reversed from a list of
// addresses). The plain address lives only as a value in a token record (15
// minutes) and a session record (2 hours), where checkout needs it (D-02).
import * as v from 'valibot'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { allowRequest, hashIp, RESPONSE_FLOOR_MS, type LimiterRedis } from './early-access'
import { buildInviteMail, REPLY_TO } from './mail-copy'
import { unsubscribeHeaders, unsubscribeUrl } from './unsubscribe'

/** Name of the invited-session cookie: HttpOnly, so only the server reads it. */
export const INVITE_COOKIE = 'ln_invite'
export const TOKEN_TTL_SECONDS = 900
export const SESSION_TTL_SECONDS = 7200
export const SIGN_IN_URL = 'https://localnodes.xyz/invite/verify'

/**
 * Sign-in link requests per IP hash: 5 per 15 minutes. Sending mail costs
 * money, so the limit is tight, and it fails closed (no mail) if it can't count.
 */
export const INVITE_RATE_LIMIT = { max: 5, windowSeconds: 900 }

/** One refusal for a forged, reused or expired link (and a malformed one): it reveals nothing. */
export const REFUSAL_MESSAGE = 'This link has expired or was already used. Ask for a new one.'
export const REFUSAL = { ok: false, message: REFUSAL_MESSAGE } as const

/** One reply for every valid sign-in link request, whoever is asking. */
export const UNIFORM_MESSAGE = 'If this address is invited, we\'ve sent a sign-in link. It works once, for 15 minutes.'

const ID_RE = /^[A-Za-z0-9_-]{43}$/

/** The subset of the Upstash client the invite code uses. */
export interface InviteRedis extends LimiterRedis {
  get: <T = unknown>(key: string) => Promise<T | null>
  set: (key: string, value: unknown, opts?: { nx?: boolean, ex?: number }) => Promise<unknown>
  getdel: <T = unknown>(key: string) => Promise<T | null>
  hset: (key: string, fields: Record<string, unknown>) => Promise<unknown>
  hgetall: <T = Record<string, unknown>>(key: string) => Promise<T | null>
}

export type InviteKind = 'pilot' | 'wave'

export interface InviteInput {
  email: string
  kind: InviteKind
  wave: string
  promoCodeId?: string
  promoCode?: string
  /** The community kind the new site is built from; one of COMMUNITY_TEMPLATES. */
  communityTemplate?: string
}

/**
 * The community kinds a site can be built from. The sign-up form has no field
 * for the kind, so it travels on the invite. add-pilot.mjs keeps a copy that a
 * test pins to this list.
 */
export const COMMUNITY_TEMPLATES: readonly string[] = ['housing_coop', 'single_house', 'market', 'neighbourhood_association']

/** The value when it is a string on COMMUNITY_TEMPLATES, otherwise ''. */
export function keptCommunityTemplate(value: unknown): string {
  return typeof value === 'string' && COMMUNITY_TEMPLATES.includes(value) ? value : ''
}

/** What the token and session records carry. The email is a value only, never a key. */
export interface InviteRecord {
  inviteId: string
  emailHmac: string
  email: string
  promoCode?: string
}

export interface InviteMail {
  to: string
  link: string
  inviteId: string
  promoCode?: string
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/**
 * Is this request's session hash the one that made the sign-up (23-37, the
 * owner-only "Confirm my payment")? Both are sha256 hex of an ln_invite
 * cookie; compared in constant time. An empty or missing value on either side
 * never matches.
 */
export function sameSessionHash(stored: unknown, given: unknown): boolean {
  if (typeof stored !== 'string' || typeof given !== 'string' || !stored || !given) return false
  const a = Buffer.from(stored)
  const b = Buffer.from(given)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Key for an address: HMAC-SHA256 of the trimmed, lower-cased email, hex. */
export function emailKey(secret: string, email: string): string {
  if (!secret) throw new Error('invite hash secret not configured')
  return createHmac('sha256', secret).update(email.trim().toLowerCase()).digest('hex')
}

/** 32 random bytes, base64url: 43 characters. */
export const newToken = (): string => randomBytes(32).toString('base64url')

/** Redis key of an invite, by the HMAC of its address. */
export const inviteKey = (emailHmac: string) => `invite:e:${emailHmac}`

/** The Redis calls reopenInvite makes (a subset of retry-stop.ts RetryStopRedis). */
export interface ReopenRedis {
  get: (key: string) => Promise<unknown>
  del: (...keys: string[]) => Promise<unknown>
  hset: (key: string, fields: Record<string, unknown>) => Promise<unknown>
  hgetall: (key: string) => Promise<Record<string, unknown> | null>
}

/**
 * Give an invite back after a failed first payment (23-37, B-1 step 4), so
 * "Try again" leads to a working /invite. Only for this sign-up: the invite
 * hash must still carry the sign-up's invite id, and the claim
 * invite:u:{inviteId} (the checkout session id that used it, stripe-webhook.ts
 * claimInvitedCheckout) is deleted only while it holds this sign-up's session
 * id. A claim held by another session is left alone, and so is the invite.
 * A missing invite or address logs a fixed line and changes nothing. It lives
 * here, not in teardown.ts (which re-exports it), so retry-stop.ts can import
 * it without an import cycle. Log lines never carry the address or an id.
 */
export async function reopenInvite(
  redis: ReopenRedis,
  secret: string,
  signup: Record<string, unknown>,
  sessionId: string,
  log?: (msg: string) => void
): Promise<void> {
  const inviteId = signup.inviteId ? String(signup.inviteId) : ''
  const email = signup.email ? String(signup.email) : ''
  if (!inviteId || !email) {
    log?.('teardown: no invite to reopen')
    return
  }
  const key = inviteKey(emailKey(secret, email))
  const invite = await redis.hgetall(key)
  if (!invite || Object.keys(invite).length === 0) {
    log?.('teardown: invite not found, nothing reopened')
    return
  }
  if (String(invite.inviteId) !== inviteId) {
    log?.('teardown: invite changed, nothing reopened')
    return
  }
  const claimKey = `invite:u:${inviteId}`
  const holder = await redis.get(claimKey)
  if (holder !== null && holder !== undefined && String(holder) !== sessionId) {
    log?.('teardown: invite claimed by another sign-up, left alone')
    return
  }
  if (holder !== null && holder !== undefined) await redis.del(claimKey)
  await redis.hset(key, { status: 'open', usedAt: '' })
}

/** Put an address on the invite list (open). Returns the invite id. */
export async function addInvite(redis: InviteRedis, secret: string, input: InviteInput): Promise<{ inviteId: string }> {
  const inviteId = randomBytes(16).toString('base64url')
  const fields: Record<string, unknown> = {
    inviteId,
    kind: input.kind,
    wave: input.wave,
    status: 'open',
    // Always written, '' when none: a re-made invite never keeps an old kind.
    communityTemplate: keptCommunityTemplate(input.communityTemplate),
    createdAt: new Date().toISOString()
  }
  if (input.promoCodeId) fields.promoCodeId = input.promoCodeId
  if (input.promoCode) fields.promoCode = input.promoCode
  await redis.hset(inviteKey(emailKey(secret, input.email)), fields)
  return { inviteId }
}

/** Make a one-time token for an invite; only its hash is stored (15 minutes). */
export async function issueToken(redis: InviteRedis, rec: InviteRecord): Promise<string> {
  const token = newToken()
  await redis.set(`invite:t:${sha256(token)}`, rec, { ex: TOKEN_TTL_SECONDS })
  return token
}

/** Read and delete the token in one step (GETDEL): one caller wins. Null when forged, reused or expired. */
export async function consumeToken(redis: InviteRedis, token: string): Promise<InviteRecord | null> {
  const rec = await redis.getdel<InviteRecord>(`invite:t:${sha256(token)}`)
  return rec && typeof rec === 'object' ? rec : null
}

/** Start a 2-hour invited session. Returns the session id (the cookie value); only its hash is stored. */
export async function createInvitedSession(redis: InviteRedis, rec: InviteRecord): Promise<string> {
  const sid = newToken()
  await redis.set(`invite:s:${sha256(sid)}`, rec, { ex: SESSION_TTL_SECONDS })
  return sid
}

/** What the sign-up page may show of an invited session: the address and the invite's code. */
export interface InvitedDetails {
  email: string
  promoCode?: string
}

/** The two fields of a session the page shows (23-19). Never the invite id or the address hash. */
export function invitedDetails(rec: InviteRecord): InvitedDetails {
  const details: InvitedDetails = { email: String(rec.email ?? '') }
  if (typeof rec.promoCode === 'string' && rec.promoCode) details.promoCode = rec.promoCode
  return details
}

/** The invited session for a cookie value, or null (missing, malformed or expired). */
export async function getInvitedSession(redis: Pick<InviteRedis, 'get'>, sid: string | undefined | null): Promise<InviteRecord | null> {
  if (!sid || !ID_RE.test(sid)) return null
  const rec = await redis.get<InviteRecord>(`invite:s:${sha256(sid)}`)
  return rec && typeof rec === 'object' ? rec : null
}

// --- sign-in link request ---------------------------------------------------

export const inviteRequestSchema = v.object({
  email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.maxLength(254), v.email()),
  // Honeypot: hidden from people, left empty by them; bots fill it.
  hpField: v.optional(v.string(), '')
})

export interface RequestDeps {
  redis: InviteRedis
  secret: string
  /** Sends the sign-in mail. May throw; the error is swallowed. */
  sendMail: (mail: InviteMail) => Promise<void>
  /** Logs without the email address. */
  log?: (msg: string) => void
  /** Keeps background work alive after the reply (event.waitUntil, Vercel's waitUntil). */
  keepAlive?: (work: Promise<void>) => void
  /** Response-time floor for valid requests (tests may shorten it). */
  floorMs?: number
}

export interface RequestOutcome {
  status: number
  body: { ok: boolean, message: string }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Every valid request, whoever asks and whatever happens next, gets this one
 * reply (status and body) once the response-time floor has passed: an invited
 * address, an unknown one, a used one, a filled honeypot, an IP over its limit
 * and a limiter that is down all look the same from outside (T-23-04). Only a
 * malformed address gets a 400, and that says nothing about the list.
 */
export async function handleInviteRequest(raw: unknown, ip: string | undefined, deps: RequestDeps): Promise<RequestOutcome> {
  const started = Date.now()
  const uniform = async (): Promise<RequestOutcome> => {
    const wait = (deps.floorMs ?? RESPONSE_FLOOR_MS) - (Date.now() - started)
    if (wait > 0) await sleep(wait)
    return { status: 200, body: { ok: true, message: UNIFORM_MESSAGE } }
  }
  const parsed = v.safeParse(inviteRequestSchema, raw)
  if (!parsed.success) {
    return { status: 400, body: { ok: false, message: 'Please enter a valid email address.' } }
  }
  // Count this request for the IP before anything else. If the limiter can't
  // answer, refuse to send: a mail costs money, a missed link only costs a retry.
  let allowed = false
  try {
    allowed = await allowRequest(deps.redis, `invite:${hashIp(ip)}`, INVITE_RATE_LIMIT)
  } catch {
    deps.log?.('invite: rate limit unavailable, no link sent')
  }
  if (!allowed) return uniform()
  const { email, hpField } = parsed.output
  // Honeypot filled: answer as if accepted, send nothing.
  if (hpField) return uniform()
  // The list lookup, the token and the mail all happen after the reply is
  // decided, so nothing about who is on the list shows in the reply or its timing.
  const work = (async () => {
    try {
      const emailHmac = emailKey(deps.secret, email)
      const invite = await deps.redis.hgetall<Record<string, unknown>>(inviteKey(emailHmac))
      if (!invite || invite.status !== 'open') return
      const inviteId = String(invite.inviteId)
      const token = await issueToken(deps.redis, { inviteId, emailHmac, email })
      await deps.sendMail({
        to: email,
        link: `${SIGN_IN_URL}#t=${token}`,
        inviteId,
        promoCode: invite.promoCode ? String(invite.promoCode) : undefined
      })
    } catch (err) {
      // Never the address, never the error body: only a status code if any.
      const status = (err as { statusCode?: number, status?: number })?.statusCode ?? (err as { status?: number })?.status
      deps.log?.(`invite: sign-in link not sent (status ${status ?? 'unknown'})`)
    }
  })()
  // The route always passes keepAlive. Without it (a test), wait for the work.
  if (deps.keepAlive) deps.keepAlive(work)
  else await work
  return uniform()
}

type Fetcher = (url: string, opts: { method: 'POST', headers: Record<string, string>, body: unknown }) => Promise<unknown>

export interface MailConfig {
  /** Resend API key (NUXT_RESEND_API_KEY). */
  apiKey: string
  /** Verified sender, for example LocalNodes <hello@localnodes.xyz> (NUXT_MAIL_FROM). */
  from: string
  /** The secret the unsubscribe link is sealed under: inviteHashSecret (unsubscribe.ts). */
  unsubscribeSecret: string
}

/**
 * Send the sign-in mail through Resend (POST /emails). The Idempotency-Key
 * is per invite and per minute, so a retry inside the minute can't send a
 * second mail. The mail goes to the early-access list, so it carries the
 * address's own unsubscribe link (LANDING.md rule, ruling R5): the RFC 8058
 * List-Unsubscribe and List-Unsubscribe-Post headers, and the same URL as the
 * footer's Unsubscribe link. Throws on a missing key, sender or unsubscribe
 * secret, and on a Resend error: the caller logs only a status code.
 */
export async function sendInviteMail(mail: InviteMail, cfg: MailConfig, fetcher: Fetcher): Promise<void> {
  if (!cfg.apiKey) throw new Error('mail not configured: no API key')
  if (!cfg.from) throw new Error('mail not configured: no sender')
  if (!cfg.unsubscribeSecret) throw new Error('mail not configured: no unsubscribe secret')
  const unsubscribe = unsubscribeUrl(mail.to, { secret: cfg.unsubscribeSecret })
  const content = buildInviteMail({ link: mail.link, unsubscribeUrl: unsubscribe })
  await fetcher('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `invite-${mail.inviteId}-${Math.floor(Date.now() / 60000)}`
    },
    body: {
      from: cfg.from,
      to: [mail.to],
      reply_to: REPLY_TO,
      subject: content.subject,
      text: content.text,
      html: content.html,
      headers: unsubscribeHeaders(unsubscribe)
    }
  })
}

// --- link landing: consume the token ----------------------------------------

export const inviteVerifySchema = v.object({
  token: v.pipe(v.string(), v.regex(ID_RE))
})

export interface VerifyDeps {
  redis: InviteRedis
  secret: string
}

export interface VerifyOutcome {
  status: number
  body: { ok: boolean, message?: string }
  /** The new session id, for the route to set as the cookie. Never in the body. */
  sessionId?: string
}

const refused = (): VerifyOutcome => ({ status: 400, body: { ...REFUSAL } })

export async function handleInviteVerify(raw: unknown, deps: VerifyDeps): Promise<VerifyOutcome> {
  const parsed = v.safeParse(inviteVerifySchema, raw)
  if (!parsed.success) return refused()
  const rec = await consumeToken(deps.redis, parsed.output.token)
  if (!rec || !rec.emailHmac || !rec.inviteId) return refused()
  // The invite must still be open (it may have been used since the link was sent).
  const invite = await deps.redis.hgetall<Record<string, unknown>>(inviteKey(rec.emailHmac))
  if (!invite || invite.status !== 'open' || String(invite.inviteId) !== rec.inviteId) return refused()
  const session: InviteRecord = { inviteId: rec.inviteId, emailHmac: rec.emailHmac, email: rec.email }
  if (invite.promoCode) session.promoCode = String(invite.promoCode)
  const sessionId = await createInvitedSession(deps.redis, session)
  return { status: 200, body: { ok: true }, sessionId }
}

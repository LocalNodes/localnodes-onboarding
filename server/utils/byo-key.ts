// Bring your own AI key (Phase 23, plan 23-18; ONB-07, D-21, T-23-56 to
// T-23-58). Plain module, no Nitro globals: Redis, fetch and the secret are
// injected, so tests import it directly and server/api/ai-key.post.ts only
// wires it up. node:crypto only (T-23-SC).
//
// The life of an organizer's key:
//   1. POST /api/ai-key checks it with one cheap provider call, seals it with
//      AES-256-GCM (NUXT_BYO_KEY_SECRET) and keeps it for the invited session at
//      byok:pending:{sha256(sid)} for 2 hours.
//   2. create-checkout (checkout.ts) moves it to byok:{provisionId} for 24 hours.
//   3. The manifest (provision-manifest.ts) opens it only for the workflow's
//      bearer token.
//   4. It is deleted on the manifest ack, on the complete callback and on the
//      final stop (retry-stop.ts), whichever comes first.
//
// Secret rule: the key is never logged, never put in an error message or a
// reply, never stored unsealed and never sent back to the browser. Replies are
// {ok: true} or one of the fixed messages in shared/ai-choice.ts; logs carry
// the kind and a status word only.
import * as v from 'valibot'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { InviteRecord } from './invites'
import {
  GEMINI_BILLING_MESSAGE,
  KEY_FAILED_MESSAGE,
  OWN_KEY_KINDS,
  SERVER_ERROR_MESSAGE,
  TOO_MANY_KEY_CHECKS_MESSAGE,
  type OwnKeyKind
} from '../../shared/ai-choice'
import { PROVISION_ID_PATTERN } from '../../shared/provisioning'

/** A checked key waits for checkout this long: the invited session's own life. */
export const PENDING_TTL_SECONDS = 7200
/** A key attached to a sign-up lives at most a day; ack, complete or the final stop delete it sooner. */
export const PROVISION_KEY_TTL_SECONDS = 86400
/** Key checks per invite: 10 an hour. Each one is a call to the organizer's provider. */
export const AI_KEY_RATE_LIMIT = { max: 10, windowSeconds: 3600 }
/** The provider check gives up after 5 seconds. */
export const CHECK_TIMEOUT_MS = 5000

export const GEMINI_CHECK_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
export const OPENROUTER_CHECK_URL = 'https://openrouter.ai/api/v1/key'

export const pendingKeyName = (sessionHash: string) => `byok:pending:${sessionHash}`
export const provisionKeyName = (provisionId: string) => `byok:${provisionId}`

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

/** The 32-byte secret, from 64 hex characters. Throws (with no key in the message) otherwise. */
function secretBytes(secretHex: string): Buffer {
  if (typeof secretHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(secretHex)) {
    throw new Error('byo-key: the seal secret must be 64 hex characters')
  }
  return Buffer.from(secretHex, 'hex')
}

/** True when the secret can seal a key. */
export function hasSealSecret(secretHex: string): boolean {
  return typeof secretHex === 'string' && /^[0-9a-fA-F]{64}$/.test(secretHex)
}

/**
 * A 32-byte key for another use, derived from an existing server secret with
 * HKDF-SHA256 and a fixed label (no salt), as 64 hex characters for sealKey and
 * openKey. A different label gives an unrelated key. Used by unsubscribe.ts
 * (23-19, ruling R5) so the unsubscribe link needs no new config key.
 */
export function deriveKeyHex(secret: string, label: string): string {
  if (typeof secret !== 'string' || !secret) throw new Error('derive: no secret configured')
  return Buffer.from(hkdfSync('sha256', secret, '', label, 32)).toString('hex')
}

/** AES-256-GCM with a random 12-byte IV. Output: base64url of iv, tag and ciphertext. */
export function sealKey(secretHex: string, plain: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, secretBytes(secretHex), iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}

/** Reverses sealKey. Throws when the tag check fails (a changed byte, the wrong secret) or the text is too short. */
export function openKey(secretHex: string, sealed: string): string {
  const key = secretBytes(secretHex)
  const raw = Buffer.from(String(sealed), 'base64url')
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('byo-key: sealed key is malformed')
  const decipher = createDecipheriv(ALGORITHM, key, raw.subarray(0, IV_BYTES))
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
  try {
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('byo-key: sealed key failed its check')
  }
}

/** The one provider call. Native fetch fits it; tests pass a mock. */
export type ProviderFetch = (
  url: string,
  init: { method: 'GET', headers: Record<string, string>, signal?: AbortSignal, redirect?: 'manual' }
) => Promise<{ status: number }>

/**
 * One cheap call with the key: Gemini lists models (key in the x-goog-api-key
 * header, never in the URL), OpenRouter reads the key's own record (bearer).
 * True only on 200. Any error, redirect or timeout is false, never a throw, so
 * nothing the provider or the network says can carry the key further.
 */
export async function checkProviderKey(kind: OwnKeyKind, key: string, fetch: ProviderFetch, timeoutMs = CHECK_TIMEOUT_MS): Promise<boolean> {
  const url = kind === 'gemini' ? GEMINI_CHECK_URL : OPENROUTER_CHECK_URL
  const headers: Record<string, string> = kind === 'gemini' ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` }
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    return res?.status === 200
  } catch {
    return false
  }
}

/** The subset of the Upstash client the key helpers use. */
export interface ByoKeyRedis {
  hset: (key: string, fields: Record<string, unknown>) => Promise<unknown>
  // Not generic, so the Upstash client (whose hgetall is constrained) fits it.
  hgetall: (key: string) => Promise<Record<string, unknown> | null>
  expire: (key: string, seconds: number) => Promise<unknown>
  del: (...keys: string[]) => Promise<unknown>
  rename: (from: string, to: string) => Promise<unknown>
}

/** Keep a sealed key for the invited session, replacing any earlier one. */
export async function storePendingKey(redis: Pick<ByoKeyRedis, 'hset' | 'expire' | 'del'>, sessionHash: string, kind: OwnKeyKind, sealed: string): Promise<void> {
  const name = pendingKeyName(sessionHash)
  await redis.del(name)
  await redis.hset(name, { kind, sealed })
  await redis.expire(name, PENDING_TTL_SECONDS)
}

/** The kind of the key kept for this session, or null when there is none. */
export async function pendingKeyKind(redis: Pick<ByoKeyRedis, 'hgetall'>, sessionHash: string): Promise<OwnKeyKind | null> {
  const slot = await redis.hgetall(pendingKeyName(sessionHash))
  const kind = slot?.kind
  return typeof kind === 'string' && (OWN_KEY_KINDS as readonly string[]).includes(kind) && slot?.sealed ? kind as OwnKeyKind : null
}

/** Move the session's key to the sign-up (RENAME, then EXPIRE a day). False when there was none. */
export async function attachKeyToProvision(redis: ByoKeyRedis, sessionHash: string, provisionId: string): Promise<boolean> {
  const from = pendingKeyName(sessionHash)
  const slot = await redis.hgetall(from)
  if (!slot || Object.keys(slot).length === 0) return false
  await redis.rename(from, provisionKeyName(provisionId))
  await redis.expire(provisionKeyName(provisionId), PROVISION_KEY_TTL_SECONDS)
  return true
}

/** Give the key back to the session when checkout could not start, so the organizer need not check it again. */
export async function returnKeyToSession(redis: ByoKeyRedis, provisionId: string, sessionHash: string): Promise<void> {
  const from = provisionKeyName(provisionId)
  const slot = await redis.hgetall(from)
  if (!slot || Object.keys(slot).length === 0) return
  await redis.rename(from, pendingKeyName(sessionHash))
  await redis.expire(pendingKeyName(sessionHash), PENDING_TTL_SECONDS)
}

/** Forget a sign-up's key. Deleting a slot that is not there is fine. */
export async function deleteProvisionKey(redis: Pick<ByoKeyRedis, 'del'>, provisionId: string): Promise<void> {
  await redis.del(provisionKeyName(provisionId))
}

/**
 * checkout.session.expired: the sign-up never started, so its key is
 * forgotten now rather than at the end of its 24 hours. Only a well-formed
 * provision id from the session's metadata is used.
 */
export async function releaseSessionKey(redis: Pick<ByoKeyRedis, 'del'>, session: { metadata?: Record<string, string> | null }): Promise<void> {
  const id = session.metadata?.provision_id
  if (typeof id === 'string' && PROVISION_ID_PATTERN.test(id)) await deleteProvisionKey(redis, id)
}

// --- POST /api/ai-key -----------------------------------------------------------

/** What the key route needs beyond the helpers: a rate limit counter. */
export interface AiKeyRedis extends ByoKeyRedis {
  incr: (key: string) => Promise<number>
  ttl: (key: string) => Promise<number>
}

export interface AiKeyDeps {
  /** The invited session behind the cookie, or null. */
  session: InviteRecord | null
  /** sha256 of the session cookie value, or null with no session. */
  sessionHash: string | null | undefined
  /** NUXT_BYO_KEY_SECRET: 64 hex characters. */
  secret: string
  redis: AiKeyRedis
  fetch: ProviderFetch
  /** Kind and status words only, never the key. */
  log?: (msg: string) => void
  timeoutMs?: number
  /**
   * The OpenRouter choice (23-18 follow-up): false refuses kind openrouter as
   * a malformed body. Required, so no caller forgets it; the route reads
   * NUXT_OPENROUTER_CHOICE_ENABLED through isOpenRouterChoiceEnabled.
   */
  openRouterChoiceEnabled: boolean
}

export type AiKeyOutcome =
  | { status: 200, body: { ok: true } }
  | { status: 400 | 404 | 429 | 503, body: { ok: false, message: string } }

// 20 to 300 printable characters with no spaces, after trimming: a line break
// or a control character could split a header. The schema's own messages are
// never used: an issue carries the input, so every failure becomes one fixed reply.
const aiKeyBodySchema = v.object({
  kind: v.picklist([...OWN_KEY_KINDS]),
  key: v.pipe(v.string(), v.trim(), v.minLength(20), v.maxLength(300), v.regex(/^[\x21-\x7e]+$/)),
  billingConfirmed: v.optional(v.boolean())
})

/** The same body with only Gemini allowed: the schema while the OpenRouter choice is hidden. */
const geminiOnlyBodySchema = v.object({
  ...aiKeyBodySchema.entries,
  kind: v.picklist(['gemini'])
})

const refuse = (status: 400 | 404 | 429 | 503, message: string): AiKeyOutcome => ({ status, body: { ok: false, message } })

/** INCR then (re)apply the window, as early-access.ts allowRequest does, under rl:aikey:inv:{inviteId}. */
async function allowCheck(redis: AiKeyRedis, inviteId: string): Promise<boolean> {
  const key = `rl:aikey:inv:${inviteId}`
  const count = await redis.incr(key)
  try {
    if (count === 1 || (await redis.ttl(key)) === -1) await redis.expire(key, AI_KEY_RATE_LIMIT.windowSeconds)
  } catch {
    // Repaired on the next request (TTL -1 again).
  }
  return count <= AI_KEY_RATE_LIMIT.max
}

/**
 * POST /api/ai-key {kind, key, billingConfirmed?}. Invited session required.
 * Order: session, body, the Gemini billing tick, the old key forgotten, the
 * rate limit (fails closed), the seal secret, the provider check, then the seal.
 */
export async function handleAiKey(raw: unknown, deps: AiKeyDeps): Promise<AiKeyOutcome> {
  const session = deps.session && deps.session.inviteId ? deps.session : null
  if (!session || !deps.sessionHash) return refuse(404, 'Not Found')

  // While the OpenRouter choice is hidden, openrouter is a malformed body:
  // refused before the old key is forgotten, the count or any provider call.
  const parsed = v.safeParse(deps.openRouterChoiceEnabled === true ? aiKeyBodySchema : geminiOnlyBodySchema, raw)
  if (!parsed.success) {
    deps.log?.('ai-key: refused, malformed body')
    return refuse(400, KEY_FAILED_MESSAGE)
  }
  const { kind, key, billingConfirmed } = parsed.output
  if (kind === 'gemini' && billingConfirmed !== true) return refuse(400, GEMINI_BILLING_MESSAGE)

  // A new check replaces the key kept before it: whatever happens next, the
  // old one is not used by mistake.
  const redis = deps.redis
  try {
    await redis.del(pendingKeyName(deps.sessionHash))
    if (!(await allowCheck(redis, session.inviteId))) {
      deps.log?.('ai-key: refused, too many checks')
      return refuse(429, TOO_MANY_KEY_CHECKS_MESSAGE)
    }
  } catch {
    deps.log?.('ai-key: rate limit unavailable, no check made')
    return refuse(503, SERVER_ERROR_MESSAGE)
  }
  if (!hasSealSecret(deps.secret)) {
    deps.log?.('ai-key: seal secret not configured, no check made')
    return refuse(503, SERVER_ERROR_MESSAGE)
  }

  if (!(await checkProviderKey(kind, key, deps.fetch, deps.timeoutMs))) {
    deps.log?.(`ai-key: ${kind} key did not pass the check`)
    return refuse(400, KEY_FAILED_MESSAGE)
  }

  try {
    await storePendingKey(redis, deps.sessionHash, kind, sealKey(deps.secret, key))
  } catch {
    deps.log?.('ai-key: key not stored')
    return refuse(503, SERVER_ERROR_MESSAGE)
  }
  deps.log?.(`ai-key: ${kind} key checked and kept`)
  return { status: 200, body: { ok: true } }
}

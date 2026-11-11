// The unsubscribe link in mails to the early-access list (fresh3 23-19; ruling
// R5 (a), 2026-11-08; RFC 8058; LANDING.md standing rule). Plain module, no
// Nitro globals: the secret and Resend are injected, so tests import
// it directly. server/routes/unsubscribe.post.ts wires it up.
//
// A link is https://localnodes.xyz/unsubscribe?t=<token>. The token is the
// address and the list it leaves (UNSUBSCRIBE_LIST), sealed with AES-256-GCM
// (byo-key.ts sealKey/openKey, base64url) under a key derived with HKDF-SHA256
// from inviteHashSecret, the server secret the invite list already uses, with
// the fixed label below. So the link needs no new config key, and the address
// is never in plain text in the URL. A link never expires (orchestrator,
// 2026-11-08: CAN-SPAM wants 30 days at least). Tokens built before that carry
// an expiry field `x`; they still open, and the expiry is ignored.
//
// Only a POST removes anything: the mail client's one-click POST (header
// List-Unsubscribe-Post) or the page's button. A GET (a mail scanner opening the
// link) never does. The removal takes the address out of the early-access
// segment in Resend (DELETE /contacts/{email}/segments/{segment_id}); a repeat
// finds nothing to remove and answers the same. Logs carry the outcome word
// only, never the address.
import { UNSUBSCRIBE_TOKEN_RE } from '../../shared/unsubscribe'
import { deriveKeyHex, openKey, sealKey } from './byo-key'

/** The HKDF label. Changing it makes every link already sent stop working. */
export const UNSUBSCRIBE_KEY_LABEL = 'localnodes-unsubscribe-v1'
/**
 * The list a token takes the address off. A name, not the Resend segment id:
 * the removal goes to the segment configured now (NUXT_RESEND_SEGMENT_ID), so a
 * link still works if the segment is ever replaced.
 */
export const UNSUBSCRIBE_LIST = 'early-access'
/** Where the link points. The same host as the sign-in link (invites.ts SIGN_IN_URL). */
export const UNSUBSCRIBE_ORIGIN = 'https://localnodes.xyz'
/** The one refusal for a missing, forged or foreign token: an HTTP reason phrase, it says nothing. */
export const BAD_TOKEN_MESSAGE = 'Bad Request'
/** Resend or the list setting is missing or down. */
const UNAVAILABLE_MESSAGE = 'Service Unavailable'

const keyFor = (secret: string) => deriveKeyHex(secret, UNSUBSCRIBE_KEY_LABEL)

/** Seals the address and the list, with no time limit. Throws when the secret is missing. */
export function sealUnsubscribeToken(email: string, secret: string): string {
  const payload = JSON.stringify({ e: email.trim().toLowerCase(), s: UNSUBSCRIBE_LIST })
  return sealKey(keyFor(secret), payload)
}

/**
 * The address in a token, or null when it is malformed, forged, sealed under
 * another key or for another list. A first-format token ({e, x}, no list) is
 * for the early-access list; its expiry x is ignored.
 */
export function openUnsubscribeToken(token: string, secret: string): string | null {
  if (typeof token !== 'string' || !UNSUBSCRIBE_TOKEN_RE.test(token)) return null
  try {
    const parsed = JSON.parse(openKey(keyFor(secret), token)) as { e?: unknown, s?: unknown } | null
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.e !== 'string' || !parsed.e) return null
    if (parsed.s !== undefined && parsed.s !== UNSUBSCRIBE_LIST) return null
    return parsed.e
  } catch {
    return null
  }
}

export interface UnsubscribeLinkConfig {
  secret: string
  origin?: string
}

/** The address's own unsubscribe link. */
export function unsubscribeUrl(email: string, cfg: UnsubscribeLinkConfig): string {
  const origin = (cfg.origin ?? UNSUBSCRIBE_ORIGIN).replace(/\/+$/, '')
  return `${origin}/unsubscribe?t=${sealUnsubscribeToken(email, cfg.secret)}`
}

/** The two RFC 8058 headers for a link: List-Unsubscribe with the https URL, and the one-click POST. */
export function unsubscribeHeaders(url: string): Record<'List-Unsubscribe' | 'List-Unsubscribe-Post', string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
  }
}

/** The Resend call. $fetch fits it (it throws with statusCode on a non-2xx reply). */
export type UnsubscribeFetch = (url: string, opts: { method: 'DELETE', headers: Record<string, string> }) => Promise<unknown>

export interface UnsubscribeDeps {
  /** inviteHashSecret (NUXT_INVITE_HASH_SECRET). */
  secret: string
  /** NUXT_RESEND_API_KEY. */
  apiKey: string
  /** The early-access segment (NUXT_RESEND_SEGMENT_ID). */
  segmentId: string
  fetch: UnsubscribeFetch
  /** Gets the outcome word only. */
  log?: (msg: string) => void
}

export type UnsubscribeOutcome =
  | { status: 200, body: { ok: true } }
  | { status: 400 | 503, body: { ok: false, message: string } }

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number, status?: number, response?: { status?: number } } | null
  return e?.statusCode ?? e?.status ?? e?.response?.status
}

/**
 * The one-click unsubscribe. A bad token is 400 with one fixed message and no
 * call. A good one removes the address from the early-access segment; Resend's
 * 404 (not in the segment any more) counts as done, so a repeat is also 200.
 */
export async function handleUnsubscribe(token: string, deps: UnsubscribeDeps): Promise<UnsubscribeOutcome> {
  const email = openUnsubscribeToken(token, deps.secret)
  if (!email) {
    deps.log?.('unsubscribe: refused')
    return { status: 400, body: { ok: false, message: BAD_TOKEN_MESSAGE } }
  }
  if (!deps.apiKey || !deps.segmentId) {
    deps.log?.('unsubscribe: not configured')
    return { status: 503, body: { ok: false, message: UNAVAILABLE_MESSAGE } }
  }
  try {
    await deps.fetch(`https://api.resend.com/contacts/${encodeURIComponent(email)}/segments/${encodeURIComponent(deps.segmentId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${deps.apiKey}` }
    })
    deps.log?.('unsubscribe: removed')
  } catch (err) {
    const status = statusOf(err)
    if (status !== 404) {
      deps.log?.(`unsubscribe: failed (status ${status ?? 'unknown'})`)
      return { status: 503, body: { ok: false, message: UNAVAILABLE_MESSAGE } }
    }
    deps.log?.('unsubscribe: already removed')
  }
  return { status: 200, body: { ok: true } }
}

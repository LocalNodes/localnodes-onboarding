// Early-access list (Tom, 2026-11-06, PR #9). Plain module, no Nitro globals,
// so tests import it directly; server/api/early-access.post.ts wires it up.
//
// Protection: server-side validation; a honeypot field; a per-IP rate limit;
// no CAPTCHA. Every accepted request gets the same reply, whether the email is
// new, already on the list, caught by the honeypot or refused by Resend, so
// the reply never reveals who is on the list. The email address is never
// logged, never put in an error message and never used as a key.
import * as v from 'valibot'
import { createHash } from 'node:crypto'

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

export type Outcome =
  | { status: 200, body: typeof ACCEPTED }
  | { status: 400, body: { ok: false, message: string } }
  | { status: 429, body: { ok: false, message: string } }
  | { status: 503, body: { ok: false, message: string } }

export interface Contact {
  email: string
  community: string
  groupKind: string
}

export interface Deps {
  /** Count this request for the IP; returns false when over the limit. */
  allow: (ipHash: string) => Promise<boolean>
  /** Add the contact to the list. May throw; the error is swallowed. */
  addContact: (contact: Contact) => Promise<void>
  /** Whether the list is configured (API key and segment id set). */
  configured: boolean
  /** Logs without the email address. */
  log?: (msg: string) => void
}

export function hashIp(ip: string | undefined): string {
  return createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 32)
}

export async function handleEarlyAccess(raw: unknown, ip: string | undefined, deps: Deps): Promise<Outcome> {
  if (!deps.configured) {
    return { status: 503, body: { ok: false, message: 'Early access sign-up isn\'t open yet. Please try again later.' } }
  }
  const parsed = v.safeParse(earlyAccessSchema, raw)
  if (!parsed.success) {
    return { status: 400, body: { ok: false, message: 'Please enter a valid email address.' } }
  }
  if (!(await deps.allow(hashIp(ip)))) {
    return { status: 429, body: { ok: false, message: 'Too many tries. Please wait a while and try again.' } }
  }
  const input = parsed.output
  if (input.hpField) {
    // Honeypot filled: answer as if accepted, add nothing.
    return { status: 200, body: ACCEPTED }
  }
  try {
    await deps.addContact({ email: input.email, community: input.community, groupKind: input.groupKind })
  } catch (err) {
    // Never the address, never the error body: only a status code if any.
    const status = (err as { statusCode?: number, status?: number })?.statusCode ?? (err as { status?: number })?.status
    deps.log?.(`early-access: contact not added (status ${status ?? 'unknown'})`)
  }
  return { status: 200, body: ACCEPTED }
}

type Fetcher = (url: string, opts: { method: 'POST', headers: Record<string, string>, body: unknown }) => Promise<unknown>

/**
 * Add a contact through the Resend Contacts API (POST /contacts, with the
 * segment by id; Resend docs, checked 2026-11-06 via ctx7). Custom properties
 * are only stored when they already exist in Resend, and an unknown property
 * fails the call, so a failed call with properties is retried once without
 * them: the address is kept even if the properties aren't set up yet.
 */
export async function addResendContact(contact: Contact, apiKey: string, segmentId: string, fetcher: Fetcher): Promise<void> {
  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  const base = { email: contact.email, unsubscribed: false, segments: [{ id: segmentId }] }
  const properties: Record<string, string> = {}
  if (contact.community) properties.community_name = contact.community
  if (contact.groupKind) properties.group_kind = contact.groupKind
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

// Logic and words for the /unsubscribe page (fresh3 23-19 follow-up; ruling
// R5, RFC 8058). Plain module with no Nuxt globals: the page passes in $fetch,
// and the tests pass a fake. Every string is a row of 23-UI-SPEC.md "Unsubscribe
// page" (orchestrator, rule C, 2026-11-08), word for word. npm run check:claims
// scans this file with the sign-up rules (signupSources).
//
// Opening the page removes nothing: mail scanners prefetch links. Only the
// button's POST (postUnsubscribe) or the mail client's RFC 8058 one-click POST
// reaches server/routes/unsubscribe.post.ts. The page never shows the address.
import { UNSUBSCRIBE_TOKEN_RE } from '#shared/unsubscribe'

export const UNSUBSCRIBE_COPY = {
  title: 'Unsubscribe',
  intro: 'Stop getting LocalNodes early-access emails at this address.',
  button: 'Unsubscribe',
  buttonWorking: 'Unsubscribing…',
  done: 'You\'re unsubscribed. We won\'t send you early-access emails anymore.',
  refused: 'This unsubscribe link doesn\'t work. Reply to any of our emails, or write to hello@localnodes.xyz, and we\'ll take you off the list.',
  serverError: 'Something went wrong on our side. Try again in a minute.'
} as const

/** ready: the button; working: the POST is out; then one of the three results. */
export type UnsubscribePhase = 'ready' | 'working' | 'done' | 'refused' | 'server-error'

/** What a call to $fetch looks like to this module (ofetch throws with statusCode and status). */
export type UnsubscribeFetcher = (url: string, opts: { method: 'POST', query: { t: string } }) => Promise<unknown>

/** The token in the link's `t`, when it has a token's shape; anything else gives null. */
export function tokenFromQuery(value: unknown): string | null {
  return typeof value === 'string' && UNSUBSCRIBE_TOKEN_RE.test(value) ? value : null
}

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number, status?: number } | null
  return e?.statusCode ?? e?.status
}

/**
 * The button's POST. 200 is done. 400 is the server's one refusal for a
 * forged or foreign token. Anything else (503 when Resend or the list setting
 * is missing or down, or no answer) is a server problem, and the button stays.
 */
export async function postUnsubscribe(fetcher: UnsubscribeFetcher, token: string): Promise<'done' | 'refused' | 'server-error'> {
  try {
    await fetcher('/unsubscribe', { method: 'POST', query: { t: token } })
    return 'done'
  } catch (err) {
    return statusOf(err) === 400 ? 'refused' : 'server-error'
  }
}

// Logic and words for the two invite pages (fresh3 23-28, D-01, D-24):
// /invite (ask for a sign-in link) and /invite/verify (spend it).
// Plain module with no Nuxt globals: the pages pass in $fetch, and the tests
// pass a fake. Every string is the approved copy in 23-UI-SPEC.md sections 1
// and 2 (Title Case for the page titles, sentence case for the rest, R4).

/** Seconds before "Send it again" shows. The page says "a minute", with no ticking numbers. */
export const RESEND_WAIT_SECONDS = 60

export const INVITE_COPY = {
  entry: {
    title: 'Use Your Invite',
    intro: 'Enter the email your invite went to. We\'ll send you a link to start setting up your community\'s site.',
    fieldLabel: 'Email',
    button: 'Send my sign-in link',
    buttonWorking: 'Sending…',
    sentHeading: 'Check your email',
    // The same for every address (T-23-02): the page never says whether one is invited.
    sentReply: 'If this address is invited, we\'ve sent a sign-in link. It works once, for 15 minutes.',
    waitSentence: 'You can send it again in a minute.',
    resendButton: 'Send it again',
    resendAnnouncement: 'You can send the link again.',
    invalidEmail: 'This isn\'t an email address. Check it has an @ and a domain, like name@example.org.',
    summaryHeading: 'Fix these to continue',
    tooManyTries: 'Too many tries from this connection. Wait a few minutes, then try again.',
    serverError: 'Something went wrong on our side. Try again in a minute.',
    helpLink: 'How we handle your details'
  },
  verify: {
    title: 'Your Invite Link',
    intro: 'Your link is ready. Continue to start setting up your community\'s site.',
    button: 'Continue to sign-up',
    buttonWorking: 'Checking…',
    // One message for a forged, used and expired link, so it reveals nothing.
    refused: 'This link has expired or was already used. Ask for a new one.',
    newLink: 'Get a new sign-in link',
    serverError: 'Something went wrong on our side. Try again in a minute.',
    goingOn: 'Taking you to sign-up.'
  }
} as const

/** What a call to $fetch looks like to this module (ofetch throws with statusCode and status). */
export type Fetcher = (url: string, opts: { method: 'POST', body: Record<string, string> }) => Promise<unknown>

/**
 * The token in a sign-in link's fragment. The mail link is
 * https://localnodes.xyz/invite/verify#t=<token> (server/utils/invites.ts), so
 * the token never reaches a server log or a Referer header. 32 random bytes in
 * base64url are 43 characters. Anything else gives null, and a query string
 * (`?t=`) is never read.
 */
export function tokenFromHash(hash: string): string | null {
  const m = /^#t=([A-Za-z0-9_-]{43})$/.exec(hash)
  return m ? m[1]! : null
}

/** A cheap check for the submit: something, an @, a domain with a dot, no spaces. The server decides for real. */
export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value.trim())
}

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number, status?: number } | null
  return e?.statusCode ?? e?.status
}

export type RequestResult =
  | { kind: 'sent' }
  | { kind: 'invalid' }
  | { kind: 'too-many' }
  | { kind: 'server-error' }

/**
 * Asks for a sign-in link. The server answers 200 and one body for every
 * valid address (T-23-04), so a success carries nothing back: the page shows
 * its own fixed sentence. A 400 is a malformed address.
 */
export async function requestSignInLink(fetcher: Fetcher, email: string, hpField: string): Promise<RequestResult> {
  try {
    await fetcher('/api/invite/request', { method: 'POST', body: { email, hpField } })
    return { kind: 'sent' }
  } catch (err) {
    const status = statusOf(err)
    if (status === 400) return { kind: 'invalid' }
    if (status === 429) return { kind: 'too-many' }
    return { kind: 'server-error' }
  }
}

export type VerifyResult = 'ok' | 'refused' | 'server-error'

/**
 * Spends the one-time token. Called only from the button press on
 * /invite/verify, never on page load: a mail scanner that opens the link
 * must not use it up (research Pitfall 2).
 */
export async function consumeSignInLink(fetcher: Fetcher, token: string): Promise<VerifyResult> {
  try {
    const res = await fetcher('/api/invite/verify', { method: 'POST', body: { token } }) as { ok?: boolean } | null
    return res?.ok === true ? 'ok' : 'refused'
  } catch (err) {
    return statusOf(err) === 400 ? 'refused' : 'server-error'
  }
}

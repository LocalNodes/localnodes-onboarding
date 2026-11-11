// Logic and words for the /pilot/continue page (fresh3 23, pilot end). The
// free pilot's end mail links here (continueUrl in the server's pilot-end module).
// Plain module with no Nuxt globals: the page passes in $fetch, and the tests
// pass a fake. The words are draft wording, to be confirmed.
// npm run check:claims scans this file with the sign-up rules (signupSources).
//
// Opening the page changes nothing: mail scanners prefetch links. The page's
// GET only reads the date, the price and the state; only the button's POST
// (the organizer's yes) clears the pilot's end, and from then on the saved card
// is charged at the first bill after the free months, whether or not paid
// sign-ups are open. The yes works only before the free end.
import { PILOT_CONTINUE_TOKEN_RE, type PilotContinueState } from '#shared/pilot-continue'

export const PILOT_CONTINUE_COPY = {
  title: 'Keep your LocalNodes site',
  loading: 'Checking your pilot…',
  ends: (date: string) => `Your free pilot ends on ${date}. If you do nothing, we won't charge you anything.`,
  // With no price the page names no cost and has no Keep button (priceMissing is shown instead).
  cost: (date: string, price: string) => price
    ? `Continuing costs ${price} for one community site, including all its groups and members, after your free period and only if you choose it. We charge the card you saved when you signed up. To continue, choose "Keep my site" before ${date}.`
    : '',
  priceMissing: 'We cannot confirm the continuation price right now; please try again before choosing to continue.',
  button: 'Keep my site',
  buttonWorking: 'Keeping your site…',
  retry: 'Try again',
  // No date: the first charge is the first renewal after the free months, which
  // for a yearly price can be well after the pilot's end. The price is a rate.
  continued: (price: string) => price
    ? `Done. Your site stays open. It costs ${price}, charged to the card you saved, starting with the first bill after your free months. Questions? Write to hello@localnodes.xyz.`
    : 'Done. Your site stays open. Questions? Write to hello@localnodes.xyz.',
  ended: 'Your free pilot has already ended, so we can\'t keep the site from this link. Write to hello@localnodes.xyz and we\'ll help.',
  invalid: 'This link doesn\'t work. Write to hello@localnodes.xyz and we\'ll sort it out.',
  serverError: 'Something went wrong on our side. Try again in a minute.'
} as const

/** loading: the first read; ready: the button; price-missing: the end is known but the price is not, so no button; working: the POST is out; then a result. */
export type PilotContinuePhase = 'loading' | 'ready' | 'price-missing' | 'working' | 'continued' | 'ended' | 'invalid' | 'server-error'

export interface PilotContinueView {
  phase: PilotContinuePhase
  date: string
  price: string
}

/** What a call to $fetch looks like to this module (ofetch throws with statusCode and status). */
export type PilotContinueFetcher = (url: string, opts: { method: 'GET' | 'POST', query: { t: string } }) => Promise<unknown>

/** The token in the link's `t`, when it has a token's shape; anything else gives null. */
export function pilotTokenFromQuery(value: unknown): string | null {
  return typeof value === 'string' && PILOT_CONTINUE_TOKEN_RE.test(value) ? value : null
}

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number, status?: number } | null
  return e?.statusCode ?? e?.status
}

const PHASE_OF: Record<Exclude<PilotContinueState, 'invalid' | 'unavailable'>, PilotContinuePhase> = {
  ends: 'ready',
  continued: 'continued',
  ended: 'ended'
}

function viewOf(body: unknown, fallback: PilotContinuePhase): PilotContinueView {
  const b = (body ?? {}) as { state?: unknown, date?: unknown, price?: unknown }
  let phase = typeof b.state === 'string' && Object.hasOwn(PHASE_OF, b.state) ? PHASE_OF[b.state as keyof typeof PHASE_OF] : fallback
  const price = typeof b.price === 'string' ? b.price : ''
  // The yes is offered only next to a price the server could read.
  if (phase === 'ready' && !price) phase = 'price-missing'
  return { phase, date: typeof b.date === 'string' ? b.date : '', price }
}

/**
 * The page's read (GET) or the button's yes (POST). 200 gives the state the
 * server reports. 400 is the server's one refusal. Anything else (503, no
 * answer, a body with no state) is a server problem: the page offers a retry
 * and never says the site was kept.
 */
export async function callPilotContinue(fetcher: PilotContinueFetcher, method: 'GET' | 'POST', token: string): Promise<PilotContinueView> {
  try {
    const body = await fetcher('/api/pilot-continue', { method, query: { t: token } })
    return viewOf(body, 'server-error')
  } catch (err) {
    return { phase: statusOf(err) === 400 ? 'invalid' : 'server-error', date: '', price: '' }
  }
}

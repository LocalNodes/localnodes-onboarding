// Logic and words for the /pilot/continue page (fresh3 23, pilot end). The
// free pilot's end mail links here (continueUrl in the server's pilot-end module).
// Plain module with no Nuxt globals: the page passes in $fetch, and the tests
// pass a fake. The words are draft wording, to be confirmed.
// npm run check:claims scans this file with the sign-up rules (signupSources).
//
// Opening the page changes nothing: mail scanners prefetch links. The page's
// GET only reads the date, the price and the state; only the button's POST
// (the organizer's yes) clears the pilot's end, and from then on the saved card
// is charged the full price, whether or not paid sign-ups are open.
import { PILOT_CONTINUE_TOKEN_RE, type PilotContinueState } from '#shared/pilot-continue'

export const PILOT_CONTINUE_COPY = {
  title: 'Keep your LocalNodes site',
  loading: 'Checking your pilot…',
  ends: (date: string) => `Your free pilot ends on ${date}. If you do nothing, we won't charge you anything.`,
  cost: (date: string, price: string) => price
    ? `To keep your site after that, choose "Keep my site". From about ${date} it costs ${price}, charged to the card you saved when you signed up.`
    : `To keep your site after that, choose "Keep my site". From about ${date} it costs the full price, charged to the card you saved when you signed up.`,
  button: 'Keep my site',
  buttonWorking: 'Keeping your site…',
  continued: (date: string, price: string) => price
    ? `Done. Your site stays open, and from about ${date} it costs ${price}, charged to the card you saved. Questions? Write to hello@localnodes.xyz.`
    : `Done. Your site stays open, and from about ${date} it costs the full price, charged to the card you saved. Questions? Write to hello@localnodes.xyz.`,
  ended: 'Your free pilot has already ended, so we can\'t keep the site from this link. Write to hello@localnodes.xyz and we\'ll help.',
  invalid: 'This link doesn\'t work. Write to hello@localnodes.xyz and we\'ll sort it out.',
  serverError: 'Something went wrong on our side. Try again in a minute.'
} as const

/** loading: the first read; ready: the button; working: the POST is out; then a result. */
export type PilotContinuePhase = 'loading' | 'ready' | 'working' | 'continued' | 'ended' | 'invalid' | 'server-error'

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
  const phase = typeof b.state === 'string' && Object.hasOwn(PHASE_OF, b.state) ? PHASE_OF[b.state as keyof typeof PHASE_OF] : fallback
  return {
    phase,
    date: typeof b.date === 'string' ? b.date : '',
    price: typeof b.price === 'string' ? b.price : ''
  }
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

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
// sign-ups are open.
//
// For 30 days after the free end, unless the site is already removed, the same link still works,
// but the yes charges nothing by itself: the server opens a Stripe payment
// page that shows the total, and the page sends the organizer there. Only an
// address on Stripe's checkout host is followed.
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
  // After the free end (late): the yes goes to Stripe's payment page.
  lapsed: (date: string) => `Your free pilot ended on ${date}. Your site is still here for now, and you can still keep it.`,
  lateCost: (price: string) => price
    ? `Keeping it costs ${price} for one community site, including all its groups and members. When you choose "Keep my site", we take you to a secure Stripe payment page that shows the total. Nothing is charged until you confirm there. The card you saved may be shown there; you can use it or enter another.`
    : '',
  lateButtonWorking: 'Opening the payment page…',
  back: 'You haven\'t been charged. You can still keep your site from this page.',
  confirming: 'We\'re confirming your payment with Stripe. Reload this page in a minute. Questions? Write to hello@localnodes.xyz.',
  lateContinued: (charged: string, chargedOn: string, price: string) => charged && chargedOn
    ? `Done. Your site stays open. We charged ${charged} on ${chargedOn}${price ? `, and it renews at ${price}` : ''}. Questions? Write to hello@localnodes.xyz.`
    : 'Done. Your site stays open. Questions? Write to hello@localnodes.xyz.',
  ended: 'Your free pilot has already ended, so we can\'t keep the site from this link. Write to hello@localnodes.xyz and we\'ll help.',
  invalid: 'This link doesn\'t work. Write to hello@localnodes.xyz and we\'ll sort it out.',
  serverError: 'Something went wrong on our side. Try again in a minute.'
} as const

/**
 * loading: the first read; ready: the button; price-missing: the end is known
 * but the price is not, so no button; working: the POST is out; checkout: the
 * server opened Stripe's payment page and the page goes there; confirming:
 * that page was paid and Stripe is confirming it; then a result.
 */
export type PilotContinuePhase = 'loading' | 'ready' | 'price-missing' | 'working' | 'checkout' | 'confirming' | 'continued' | 'ended' | 'invalid' | 'server-error'

export interface PilotContinueView {
  phase: PilotContinuePhase
  date: string
  price: string
  /** The free end has passed: the yes goes through Stripe's payment page. */
  late?: boolean
  /** checkout: the payment page, always on CHECKOUT_HOST. */
  url?: string
  /** continued after a late yes. */
  charged?: string
  chargedOn?: string
}

/** The only address the page sends the organizer to. */
export const CHECKOUT_HOST = 'https://checkout.stripe.com/'

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
  lapsed: 'ready',
  checkout: 'checkout',
  confirming: 'confirming',
  continued: 'continued',
  ended: 'ended'
}

const str = (v: unknown) => typeof v === 'string' ? v : ''

function viewOf(body: unknown, fallback: PilotContinuePhase): PilotContinueView {
  const b = (body ?? {}) as Record<string, unknown>
  let phase = typeof b.state === 'string' && Object.hasOwn(PHASE_OF, b.state) ? PHASE_OF[b.state as keyof typeof PHASE_OF] : fallback
  const price = str(b.price)
  // The yes is offered only next to a price the server could read.
  if (phase === 'ready' && !price) phase = 'price-missing'
  const url = str(b.url)
  // A payment page anywhere but Stripe's checkout host is never followed.
  if (phase === 'checkout' && !url.startsWith(CHECKOUT_HOST)) phase = 'server-error'
  const view: PilotContinueView = { phase, date: str(b.date), price }
  if (b.state === 'lapsed' || b.state === 'checkout' || b.state === 'confirming') view.late = true
  if (phase === 'checkout') view.url = url
  if (phase === 'continued' && (str(b.charged) || str(b.chargedOn))) {
    view.late = true
    view.charged = str(b.charged)
    view.chargedOn = str(b.chargedOn)
  }
  return view
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

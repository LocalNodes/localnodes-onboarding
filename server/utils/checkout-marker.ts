// The checkout marker (fresh3 23-20 follow-up, 2026-11-08). Plain module, no
// Nitro globals: Redis is injected, so tests import it directly.
//
// Stripe sends the organizer to /success?session_id=… as soon as the card is
// saved, often before checkout.session.completed has written provision:{id}.
// The status read used to answer "unknown" both then and for an id that is not
// ours (a typo, an old link, an expired session), so /success showed the build
// steps for any id. Checkout now marks every Stripe session it creates with
// checkout:{sessionId}. With no state and no marker the status read says
// notFound, and the page shows its empty state.
//
// The marker holds only the time it was written: no address, no ids. It lasts
// a day, no longer than the state it stands in for (PROVISION_TTL, refreshed
// on every write after the marker), so an expired sign-up reads as not found.
// checkout.session.expired deletes it sooner.

/** A day: the provisioning state's own TTL, which is always refreshed after the marker is written. */
export const CHECKOUT_MARKER_TTL_SECONDS = 86400

export const checkoutMarkerKey = (sessionId: string) => `checkout:${sessionId}`

/** The subset of the Upstash client the marker uses. */
export interface CheckoutMarkerRedis {
  hset: (key: string, fields: Record<string, unknown>) => Promise<unknown>
  expire: (key: string, seconds: number) => Promise<unknown>
}

/** Marks a Stripe session checkout created, for a day. */
export async function markCheckout(redis: CheckoutMarkerRedis, sessionId: string, now: () => number = Date.now): Promise<void> {
  const key = checkoutMarkerKey(sessionId)
  await redis.hset(key, { createdAt: new Date(now()).toISOString() })
  await redis.expire(key, CHECKOUT_MARKER_TTL_SECONDS)
}

/** True when checkout created this session and its marker has not expired. */
export async function hasCheckoutMarker(redis: { hgetall: (key: string) => Promise<Record<string, unknown> | null> }, sessionId: string): Promise<boolean> {
  const marker = await redis.hgetall(checkoutMarkerKey(sessionId))
  return Boolean(marker && Object.keys(marker).length > 0)
}

/** checkout.session.expired: the session never completes, so its id now reads as not found. */
export async function forgetCheckout(redis: { del: (...keys: string[]) => Promise<unknown> }, session: { id?: string | null }): Promise<void> {
  if (typeof session.id === 'string' && session.id) await redis.del(checkoutMarkerKey(session.id))
}

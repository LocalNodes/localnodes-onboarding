import { defineEventHandler, getCookie, setResponseStatus } from 'h3'
import { getInvitedSession, INVITE_COOKIE, type InviteRecord } from '../utils/invites'
import { isLaunchOpen } from '../utils/launch'
import { handlePrice } from '../utils/price'

// Logic in server/utils/price.ts. Gated while the launch is closed
// (shared/launch.ts): only a live invited session (the ln_invite cookie, looked
// up server-side) gets the price line, for example "$20 a month". The form shows
// it above the button because a setup-mode checkout page shows no price.
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  let session: InviteRecord | null = null
  const sid = getCookie(event, INVITE_COOKIE)
  if (sid) {
    try {
      session = await getInvitedSession(useRedis(), sid)
    } catch {
      session = null
    }
  }
  const outcome = await handlePrice({
    open: isLaunchOpen(config.launchOpen),
    session,
    // Lazy, so a missing Stripe key is a 503 with the same sentence, not a 500.
    stripe: { prices: { retrieve: id => useStripe().prices.retrieve(id) } },
    priceId: config.stripePriceId,
    currency: String(config.stripeCurrency ?? '').toLowerCase(),
    log: msg => console.warn(msg)
  })
  setResponseStatus(event, outcome.status)
  return outcome.body
})

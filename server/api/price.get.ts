import { defineEventHandler, getCookie, setResponseStatus } from 'h3'
import { isPaidSignupsEnabled } from '../utils/checkout'
import { getInvitedSession, INVITE_COOKIE, type InviteRecord } from '../utils/invites'
import { isLaunchOpen } from '../utils/launch'
import { handlePrice } from '../utils/price'
import type { PromoStripe } from '../utils/promo'

// Logic in server/utils/price.ts. Gated while the launch is closed
// (shared/launch.ts): only a live invited session (the ln_invite cookie, looked
// up server-side) gets the price line, for example "$20 a month". The form shows
// it above the button because a setup-mode checkout page shows no price. An
// invited session whose invite carries a code also gets what that code offers
// (inviteCode), so the form words the page before the code is applied. Any live
// invited session, launch open or not, is flagged invited: checkout honours its
// code either way, so the form decides from this whether a typed code is used.
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
    stripe: {
      prices: { retrieve: id => useStripe().prices.retrieve(id) },
      // For the invite's code (the form words the page by what it offers).
      promotionCodes: { list: params => useStripe().promotionCodes.list(params) as unknown as ReturnType<PromoStripe['promotionCodes']['list']> }
    },
    // Lazy too: the invite hash is read only for an invited session with a code.
    redis: { hgetall: (key: string) => useRedis().hgetall(key) },
    priceId: config.stripePriceId,
    currency: String(config.stripeCurrency ?? '').toLowerCase(),
    paidSignupsEnabled: isPaidSignupsEnabled(config.paidSignupsEnabled),
    log: msg => console.warn(msg)
  })
  setResponseStatus(event, outcome.status)
  return outcome.body
})

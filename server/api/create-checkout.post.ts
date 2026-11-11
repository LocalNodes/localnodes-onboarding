import { defineEventHandler, createError, getCookie, getRequestURL, readBody } from 'h3'
import { handleCreateCheckout, isPaidSignupsEnabled, type StripeCheckoutLike } from '../utils/checkout'
import { getInvitedSession, INVITE_COOKIE, sha256, type InviteRecord } from '../utils/invites'
import { isLaunchOpen } from '../utils/launch'
import { capacityWiring } from '../utils/capacity'
import { isOpenRouterChoiceEnabled } from '../../shared/ai-choice'

// Logic in server/utils/checkout.ts. While the launch is closed this needs a
// live invited session (the ln_invite cookie, looked up server-side); the
// checkout email comes from that session, never from the body. Before any
// hold, record or Stripe call it asks whether the server has room (23-17, D-08);
// when full it answers 409 with the full reply and keeps the address. Until
// B-2 ships, a sign-up that is not 100% off is refused (23-32,
// NUXT_PAID_SIGNUPS_ENABLED). Stripe is built only when it is first used, so a
// refusal never needs the Stripe settings.
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const log = (msg: string) => console.log(msg)
  const raw = await readBody(event).catch(() => null)
  let session: InviteRecord | null = null
  const sid = getCookie(event, INVITE_COOKIE)
  if (sid) {
    try {
      session = await getInvitedSession(useRedis(), sid)
    } catch {
      session = null
    }
  }
  // Lazy: the gate, the invite checks and the room check run before any Stripe call.
  const stripe: StripeCheckoutLike = {
    checkout: { sessions: { create: params => useStripe().checkout.sessions.create(params) } },
    promotionCodes: { list: params => useStripe().promotionCodes.list(params) }
  }
  const outcome = await handleCreateCheckout(raw, {
    open: isLaunchOpen(config.launchOpen),
    session,
    // Where POST /api/ai-key kept a checked key for this session (23-18).
    sessionHash: session && sid ? sha256(sid) : null,
    stripe,
    redis: session ? useRedis() : undefined,
    priceId: config.stripePriceId,
    paidSignupsEnabled: isPaidSignupsEnabled(config.paidSignupsEnabled),
    // Hidden unless NUXT_OPENROUTER_CHOICE_ENABLED is true (23-18 follow-up).
    openRouterChoiceEnabled: isOpenRouterChoiceEnabled(config.openRouterChoiceEnabled),
    currency: String(config.stripeCurrency ?? '').toLowerCase(),
    origin: getRequestURL(event).origin,
    log,
    capacity: capacityWiring(config, () => useRedis(), {
      coolify: (url, opts) => $fetch(url, opts),
      resend: (url, opts) => $fetch(url, opts as Parameters<typeof $fetch>[1])
    }, log)
  })
  if (outcome.status !== 200) {
    throw createError({ status: outcome.status, statusText: (outcome.body as { message: string }).message })
  }
  return outcome.body
})

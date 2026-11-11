// POST /api/check-code logic (Phase 23, plan 23-15; D-06, ONB-04). Plain
// module: Stripe, Redis and the invited session are injected, so tests import it
// directly and server/api/check-code.post.ts only wires it up.
//
// The sign-up form asks "is this code good?" before the organizer pays. Only an
// invited session may ask (the code is checked for that invite and held for
// it); everyone else gets 404. A good code answers { ok: true } and nothing
// else, a refused one always the same words (T-23-48). Nothing is logged that
// names the code, the invite or the address.
import * as v from 'valibot'
import { INVITE_USED_MESSAGE } from './checkout'
import { inviteKey, type InviteRecord } from './invites'
import { checkCode, PROMO_REFUSED_MESSAGE, type PromoRedis, type PromoStripe } from './promo'

export const CHECK_CODE_UNAVAILABLE_MESSAGE = 'We couldn\'t check that code just now. Please try again.'

const bodySchema = v.object({
  code: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64))
})

export interface CheckCodeRouteRedis extends PromoRedis {
  get: <T = unknown>(key: string) => Promise<T | null>
  hgetall: <T = Record<string, unknown>>(key: string) => Promise<T | null>
}

export interface CheckCodeRouteDeps {
  /** The invited session behind the cookie (getInvitedSession), or null. */
  session: InviteRecord | null
  stripe: PromoStripe
  redis: CheckCodeRouteRedis
  /** Milliseconds. Tests inject it. */
  now?: () => number
  /** Logs without the code, the invite id or the address. */
  log?: (msg: string) => void
}

export type CheckCodeOutcome =
  | { status: 200, body: { ok: true } }
  | { status: 404, body: { message: string } }
  | { status: 400 | 409 | 503, body: { ok: false, message: string } }

export async function handleCheckCode(raw: unknown, deps: CheckCodeRouteDeps): Promise<CheckCodeOutcome> {
  const session = deps.session && deps.session.email && deps.session.emailHmac && deps.session.inviteId ? deps.session : null
  if (!session) {
    deps.log?.('check-code: refused, no invited session')
    return { status: 404, body: { message: 'Not Found' } }
  }
  const parsed = v.safeParse(bodySchema, raw)
  if (!parsed.success) return { status: 400, body: { ok: false, message: 'Please enter your code.' } }
  try {
    // The invite must still exist, belong to this session and be unused.
    const invite = await deps.redis.hgetall<Record<string, unknown>>(inviteKey(session.emailHmac))
    if (!invite || String(invite.inviteId) !== session.inviteId) {
      deps.log?.('check-code: refused, invite not found')
      return { status: 404, body: { message: 'Not Found' } }
    }
    if (invite.status !== 'open' || await deps.redis.get(`invite:u:${session.inviteId}`)) {
      deps.log?.('check-code: refused, invite already used')
      return { status: 409, body: { ok: false, message: INVITE_USED_MESSAGE } }
    }
    const checked = await checkCode(
      { code: parsed.output.code, holder: session.inviteId, invite },
      { stripe: deps.stripe, redis: deps.redis, now: deps.now }
    )
    if (!checked.ok) {
      deps.log?.('check-code: refused, code not usable')
      return { status: 409, body: { ok: false, message: PROMO_REFUSED_MESSAGE } }
    }
    return { status: 200, body: { ok: true } }
  } catch (err) {
    // An outage is not "this code is used". Never the error body: it can carry the code.
    const status = (err as { statusCode?: number, status?: number })?.statusCode ?? (err as { status?: number })?.status
    deps.log?.(`check-code: could not check (status ${status ?? 'unknown'})`)
    return { status: 503, body: { ok: false, message: CHECK_CODE_UNAVAILABLE_MESSAGE } }
  }
}

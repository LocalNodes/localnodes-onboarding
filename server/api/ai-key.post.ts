import { defineEventHandler, getCookie, readBody, setResponseHeader, setResponseStatus } from 'h3'
import { handleAiKey } from '../utils/byo-key'
import { isOpenRouterChoiceEnabled } from '../../shared/ai-choice'
import { getInvitedSession, INVITE_COOKIE, sha256, type InviteRecord } from '../utils/invites'

// Logic in server/utils/byo-key.ts. Gated while the launch is closed
// (shared/launch.ts), and it answers only for a live invited session (the
// ln_invite cookie, looked up server-side): the checked key is kept for that
// session until checkout moves it to the sign-up. The reply is {ok: true} or a
// fixed message: the key is never echoed, logged or cached (D-21).
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const raw = await readBody(event).catch(() => null)
  const redis = useRedis()
  const sid = getCookie(event, INVITE_COOKIE)
  let session: InviteRecord | null = null
  if (sid) {
    try {
      session = await getInvitedSession(redis, sid)
    } catch {
      session = null
    }
  }
  const outcome = await handleAiKey(raw, {
    session,
    sessionHash: session && sid ? sha256(sid) : null,
    secret: String(config.byoKeySecret ?? ''),
    redis,
    fetch: (url, init) => fetch(url, init),
    log: msg => console.warn(msg),
    // Hidden unless NUXT_OPENROUTER_CHOICE_ENABLED is true (23-18 follow-up).
    openRouterChoiceEnabled: isOpenRouterChoiceEnabled(config.openRouterChoiceEnabled)
  })
  setResponseStatus(event, outcome.status)
  return outcome.body
})

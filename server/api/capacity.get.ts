import { defineEventHandler, getCookie } from 'h3'
import { capacityWiring, handleCapacityRead } from '../utils/capacity'
import { getInvitedSession, INVITE_COOKIE, type InviteRecord } from '../utils/invites'

// Logic in server/utils/capacity.ts (23-17, D-08). Gated (shared/launch.ts
// GATED_API): while the launch is closed only an invited session gets here.
// Answers {room} and nothing else. An invited session that finds no room is put
// on the waiting list with waiting_for_room "true", so there is a list to write
// to when room opens, though the full screen offers no checkout button. The session is
// read here from the cookie, as create-checkout does: the gate only sets
// event.context.invited when it would otherwise refuse.
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const log = (msg: string) => console.warn(msg)
  let session: InviteRecord | null = null
  const sid = getCookie(event, INVITE_COOKIE)
  if (sid) {
    try {
      session = await getInvitedSession(useRedis(), sid)
    } catch {
      session = null
    }
  }
  const capacity = capacityWiring(config, () => useRedis(), {
    coolify: (url, opts) => $fetch(url, opts),
    resend: (url, opts) => $fetch(url, opts as Parameters<typeof $fetch>[1])
  }, log)
  let redis: ReturnType<typeof useRedis>
  try {
    redis = useRedis()
  } catch {
    return { room: false }
  }
  return handleCapacityRead({ redis, session, hasRoom: capacity.hasRoom, waitlist: capacity.waitlist, log })
})

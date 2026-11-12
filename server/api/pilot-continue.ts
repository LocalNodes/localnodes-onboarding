import { defineEventHandler, getMethod, getQuery, setResponseHeader, setResponseStatus } from 'h3'
import { handlePilotContinue, type PilotContinueStripe } from '../utils/pilot-end'
import type { LateStripe } from '../utils/pilot-late'

// GET or POST /api/pilot-continue?t=<token> (fresh3 23, pilot end). The free
// pilot's end mail links to /pilot/continue, whose page calls this. GET reads
// the date, the price and the state and changes nothing (mail scanners open
// links). POST is the organizer's yes: it clears the subscription's end, so
// the saved card is charged the full price from the end on. After the end the
// yes opens a Stripe payment page that shows the total instead, and nothing is
// charged unless the organizer pays there (server/utils/pilot-late.ts). Not gated: a pilot
// must be able to answer while the launch is closed and paid sign-ups are off.
// The token alone decides. Logic in server/utils/pilot-end.ts.
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  const method = getMethod(event)
  if (method !== 'GET' && method !== 'POST') {
    setResponseHeader(event, 'Allow', 'GET, POST')
    setResponseStatus(event, 405)
    return { message: 'Method Not Allowed' }
  }
  const config = useRuntimeConfig(event)
  const t = getQuery(event).t
  const outcome = await handlePilotContinue(method, typeof t === 'string' ? t : '', {
    // Built on first use: a bad token is refused with no Stripe client at all.
    stripe: {
      subscriptions: {
        retrieve: id => (useStripe() as unknown as PilotContinueStripe).subscriptions.retrieve(id),
        update: (id, params, opts) => (useStripe() as unknown as PilotContinueStripe).subscriptions.update(id, params, opts)
      }
    },
    late: {
      redis: { get: key => useRedis().get(key), set: (key, value, opts) => useRedis().set(key, value, opts as never), del: (...keys) => useRedis().del(...keys), eval: (script, keys, args) => useRedis().eval(script, keys, args as never) },
      stripe: {
        checkout: {
          sessions: {
            create: (params, opts) => (useStripe() as unknown as LateStripe).checkout.sessions.create(params, opts),
            retrieve: id => (useStripe() as unknown as LateStripe).checkout.sessions.retrieve(id),
            expire: id => (useStripe() as unknown as LateStripe).checkout.sessions.expire(id)
          }
        }
      }
    },
    secret: String(config.inviteHashSecret ?? ''),
    now: Date.now,
    log: msg => console.warn(msg)
  })
  setResponseStatus(event, outcome.status)
  return outcome.body
})

import { defineEventHandler, getHeader, readBody, setResponseStatus } from 'h3'
import { recordReport } from '../utils/capacity'

// The VPS's metric push (fresh3 scripts/ops/capacity-push.sh, 23-17, D-08).
// Not behind the launch gate: the server reports whether or not sign-up is
// open. It proves itself with the bearer NUXT_CAPACITY_REPORT_SECRET, checked in
// constant time before the body is read (server/utils/capacity.ts); an empty
// secret lets nothing in. The reading lives 15 minutes.
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const raw = await readBody(event).catch(() => null)
  const outcome = await recordReport(raw, getHeader(event, 'authorization'), {
    redis: { set: (key, value, opts) => useRedis().set(key, value, opts) },
    secret: String(config.capacityReportSecret ?? '')
  })
  setResponseStatus(event, outcome.status)
  return outcome.body
})

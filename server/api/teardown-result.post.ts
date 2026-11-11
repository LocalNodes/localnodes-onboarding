import { handleTeardownResult } from '../utils/teardown'

// POST /api/teardown-result (23-37; 23-36's contract). teardown-instance.yml
// reports deleted, gone, refused or failed, once per run, with the
// per-provision bearer. Logic in server/utils/teardown.ts: the result and its
// time are kept on the sign-up for 23-21's reconciliation. Not gated: the
// workflow calls it while the launch is closed (shared/launch.ts).
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const body = await readBody(event).catch(() => null)
  const result = await handleTeardownResult(
    getHeader(event, 'authorization'),
    body,
    { redis: useRedis(), secret: String(config.provisionCallbackSecret ?? ''), log: msg => console.warn(msg) }
  )
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseStatus(event, result.status)
  return result.body
})

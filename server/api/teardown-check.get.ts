import { handleTeardownCheck } from '../utils/teardown'

// GET /api/teardown-check?provision_id (23-37; 23-36's contract). Called by
// teardown-instance.yml before it deletes anything: 200 {"teardown": true} is
// its only go-ahead. Logic in server/utils/teardown.ts: the per-provision
// bearer is checked before any Redis read, and the answer is yes only for an
// unpaid first payment whose invoice is void or a build that failed twice (the
// D-18 note), never for a paying or complete sign-up. Not gated: the workflow
// calls it while the launch is closed (shared/launch.ts).
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const result = await handleTeardownCheck(
    getHeader(event, 'authorization'),
    getQuery(event).provision_id,
    { redis: useRedis(), secret: String(config.provisionCallbackSecret ?? '') }
  )
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseStatus(event, result.status)
  return result.body
})

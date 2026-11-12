import { handleFundingCheck } from '../utils/relayer-funding'

// GET /api/relayer-funding?provision_id. Called by LocalNodes/os-knowledge-garden's
// fund-practice-relayer.yml before it sends test ETH to a practice
// site's gas-sponsor wallet. Logic in server/utils/relayer-funding.ts: its own
// bearer (not the site's callback token) is checked before any Redis read; the
// answer carries the relayer address this app stored from the site's ready and
// the funding record. Not gated: the workflow calls it while the launch is
// closed (shared/launch.ts).
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const result = await handleFundingCheck(
    getHeader(event, 'authorization'),
    getQuery(event).provision_id,
    { redis: useRedis(), secret: String(config.provisionCallbackSecret ?? '') }
  )
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseStatus(event, result.status)
  return result.body
})

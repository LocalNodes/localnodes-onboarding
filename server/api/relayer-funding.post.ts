import { handleFundingWrite } from '../utils/relayer-funding'

// POST /api/relayer-funding. fund-practice-relayer.yml
// records pending (the signed transaction, before it is broadcast), then sent
// or stopped. Logic in server/utils/relayer-funding.ts: one record per
// provision, written once, finished once, for a fixed amount. Not gated: the
// workflow calls it while the launch is closed (shared/launch.ts).
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const body = await readBody(event).catch(() => null)
  const result = await handleFundingWrite(
    getHeader(event, 'authorization'),
    body,
    { redis: useRedis(), secret: String(config.provisionCallbackSecret ?? ''), log: msg => console.warn(msg) }
  )
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseStatus(event, result.status)
  return result.body
})

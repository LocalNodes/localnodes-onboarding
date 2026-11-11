import { defineEventHandler, getHeader, getQuery, setResponseHeaders, setResponseStatus } from 'h3'
import { handleManifest } from '../utils/provision-manifest'

// Logic in server/utils/provision-manifest.ts. Called by the provisioning
// workflow with its per-provision bearer token, so it is not behind the
// pre-launch gate (shared/launch.ts): the token check is its own gate.
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const out = await handleManifest(getQuery(event), getHeader(event, 'authorization'), {
    config: { provisionCallbackSecret: config.provisionCallbackSecret, byoKeySecret: String(config.byoKeySecret ?? '') },
    redis: useRedis()
  })
  setResponseStatus(event, out.status)
  setResponseHeaders(event, out.headers)
  return out.body
})

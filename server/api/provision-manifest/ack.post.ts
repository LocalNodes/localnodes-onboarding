import { defineEventHandler, getHeader, readBody, setResponseHeaders, setResponseStatus } from 'h3'
import { handleManifestAck } from '../../utils/provision-manifest'

// Logic in server/utils/provision-manifest.ts. The workflow posts here after it
// has copied a site's details, with the same per-provision bearer token as the
// manifest; the sealed organizer key is deleted. Not behind the pre-launch gate
// (shared/launch.ts): the token check is its own gate.
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const body = await readBody(event).catch(() => null)
  const out = await handleManifestAck(body, getHeader(event, 'authorization'), {
    config: { provisionCallbackSecret: config.provisionCallbackSecret },
    redis: useRedis()
  })
  setResponseStatus(event, out.status)
  setResponseHeaders(event, out.headers)
  return out.body
})

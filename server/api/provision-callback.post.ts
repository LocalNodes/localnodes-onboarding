import { handleProvisionCallback } from '../utils/provision-handlers'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const authHeader = getHeader(event, 'authorization')
  const body = await readBody(event)
  const redis = useRedis()
  return handleProvisionCallback(authHeader, body, config, redis)
})

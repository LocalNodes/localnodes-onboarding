import { handleProvisionStatus } from '../utils/provision-handlers'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const sessionId = query.session_id as string | undefined
  const redis = useRedis()
  return handleProvisionStatus(sessionId, redis)
})

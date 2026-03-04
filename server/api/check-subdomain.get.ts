import * as v from 'valibot'

const querySchema = v.object({
  slug: v.pipe(
    v.string(),
    v.minLength(3, 'Subdomain must be at least 3 characters'),
    v.maxLength(63, 'Subdomain must be at most 63 characters'),
    v.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Invalid subdomain format')
  )
})

const RESERVED_SUBDOMAINS = [
  'www', 'api', 'coolify', 'mail', 'smtp', 'admin', 'app',
  'dashboard', 'status', 'billing', 'support', 'help', 'docs'
]

export default defineEventHandler(async (event) => {
  const query = await getValidatedQuery(event, input => v.parse(querySchema, input))
  const { slug } = query

  // Check reserved subdomains
  if (RESERVED_SUBDOMAINS.includes(slug)) {
    return { available: false, reason: 'This name is reserved' }
  }

  // Check Coolify API for existing applications
  const config = useRuntimeConfig(event)
  const fqdn = `${slug}.localnodes.xyz`

  try {
    const apps = await $fetch<any[]>(`${config.coolifyApiUrl}/applications`, {
      headers: {
        Authorization: `Bearer ${config.coolifyApiToken}`,
        Accept: 'application/json'
      }
    })

    const taken = apps.some(app => {
      if (!app.docker_compose_domains) return false
      const domains = typeof app.docker_compose_domains === 'string'
        ? app.docker_compose_domains
        : JSON.stringify(app.docker_compose_domains)
      return domains.includes(fqdn)
    })

    return { available: !taken, reason: taken ? 'This subdomain is already in use' : null }
  } catch (error) {
    console.error('Coolify API error:', error)
    throw createError({
      status: 502,
      statusText: 'Could not verify subdomain availability'
    })
  }
})

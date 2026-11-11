// The private page the provisioning workflow reads (Phase 23, plan 23-25; D-05,
// D-21; provision contract v1, 23-03's interfaces block, "Manifest" and "Ack").
//
// The workflow's run page is public, so the organizer's address, the community
// name and any AI key cannot travel as workflow inputs. The workflow fetches
// them here instead, with a token that opens only that one site, and later says
// "copied" so the app deletes the sealed key.
//
// Plain module, no Nitro globals: Redis and the callback secret are injected,
// so the tests import it directly and the two routes only wire it up. Each
// handler answers with { status, headers, body } rather than throwing, so that
// the 401 and the 404 carry Cache-Control: no-store exactly as the 200 does.
//
// Order matters (T-23-36): the shape of the id and the token are checked before
// Redis is touched at all. A refusal says nothing about the site: it is the
// same short body whether the id is unknown or the token is wrong.
import { PROVISION_ID_PATTERN } from '../../shared/provisioning'
import { cleanTopicTypes } from '../../shared/signup'
import { hasValidProvisionToken } from './provision-handlers'
import { seedForManifest } from './community-seed'
import { deleteProvisionKey, openKey, provisionKeyName } from './byo-key'

/** The subset of the Upstash client the manifest and the ack use. */
export interface ManifestRedis {
  // Not generic, so the Upstash client (whose hgetall is constrained) fits it.
  hgetall: (key: string) => Promise<Record<string, unknown> | null>
  del: (...keys: string[]) => Promise<unknown>
}

export interface ManifestDeps {
  /** byoKeySecret (NUXT_BYO_KEY_SECRET) opens an organizer's sealed key (23-18); the ack does not need it. */
  /** hostReportEmail (NUXT_HOST_REPORT_EMAIL): the host's address for page reports, the same for every site. */
  config: { provisionCallbackSecret: string, byoKeySecret?: string, hostReportEmail?: string }
  redis: ManifestRedis
}

export interface ManifestReply {
  status: number
  headers: { 'Cache-Control': 'no-store' }
  body: Record<string, unknown>
}

/** Every manifest and ack reply, success or refusal, is never cached (D-21). */
const NO_STORE = { 'Cache-Control': 'no-store' } as const

const reply = (status: number, body: Record<string, unknown>): ManifestReply => ({ status, headers: NO_STORE, body })
const unauthorized = () => reply(401, { message: 'Unauthorized' })
const notFound = () => reply(404, { message: 'Unknown provision' })
/** A sealed key that cannot be opened (changed, wrong provider, no secret): no detail, never a guess (T-23-58). */
const unavailable = () => reply(500, { message: 'Manifest unavailable' })

/** An id the shape check passes and the token check will then look at. */
function claimedProvisionId(value: unknown): string | null {
  return typeof value === 'string' && PROVISION_ID_PATTERN.test(value) ? value : null
}

// Upstash parses a stored "2024" back as the number 2024, so a community name
// or subdomain made of digits arrives as a number.
const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')

/** One line: the workflow masks a single line and refuses a value with a line break. */
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()

/** The page types come back as a list from Upstash; a text value is tried as JSON; anything else is no list. */
function storedList(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return []
  }
}

/** base64url, no padding, of the JSON list: what localnodes:topic-types decodes (23-12). */
const encodeTopicTypes = (list: string[]): string => Buffer.from(JSON.stringify(list), 'utf8').toString('base64url')

// A record says gemini and platform (the default) or the organizer's own
// gemini or openrouter key (23-18). A value outside these lists is a record
// this code does not understand: it gets no manifest rather than a guessed one.
const AI_PROVIDERS = ['gemini', 'openrouter']
const AI_KEY_SOURCES = ['platform', 'organizer']

/**
 * Handle GET /api/provision-manifest?provision_id=…
 * Pure function for testability.
 *
 * The reply holds exactly eight fields, written out one by one: nothing is
 * copied across from the stored record, so a field added to the record later
 * (an invite id) cannot reach the workflow's public runner by accident.
 * community_seed is the four first texts (23-33); it never waits on Gemini and
 * is always there, with the fixed templates when no seed was stored.
 *
 * A ninth, ai_key (23-18, D-21), is added only when the record says the
 * organizer brought a key and the sealed slot byok:{provisionId} is still
 * there. The slot is read only after the token check and only for such a
 * record. After the ack the slot is gone: a retry gets ai_key_source organizer
 * and no ai_key, and the workflow keeps the key already on the reused app.
 */
export async function handleManifest(
  query: unknown,
  authHeader: string | undefined,
  deps: ManifestDeps
): Promise<ManifestReply> {
  const provisionId = claimedProvisionId((query as { provision_id?: unknown } | null)?.provision_id)
  if (!provisionId || !hasValidProvisionToken(authHeader, provisionId, deps.config.provisionCallbackSecret)) {
    return unauthorized()
  }

  const record = await deps.redis.hgetall(`signup:${provisionId}`)
  if (!record || Object.keys(record).length === 0) return notFound()

  const subdomain = text(record.subdomain)
  const siteName = oneLine(text(record.communityName))
  const email = text(record.email)
  const aiProvider = record.aiProvider == null ? 'gemini' : text(record.aiProvider)
  const aiKeySource = record.aiKeySource == null ? 'platform' : text(record.aiKeySource)

  const usable = subdomain !== ''
    && siteName !== ''
    && email !== ''
    && !/[\s\x00-\x1f\x7f]/.test(email)
    && AI_PROVIDERS.includes(aiProvider)
    && AI_KEY_SOURCES.includes(aiKeySource)
  if (!usable) return notFound()

  let aiKey: string | undefined
  if (aiKeySource === 'organizer') {
    const slot = await deps.redis.hgetall(provisionKeyName(provisionId))
    if (slot && Object.keys(slot).length > 0) {
      if (slot.kind !== aiProvider) return unavailable()
      try {
        aiKey = openKey(deps.config.byoKeySecret ?? '', String(slot.sealed ?? ''))
      } catch {
        return unavailable()
      }
    }
  }

  return reply(200, {
    provision_id: provisionId,
    subdomain,
    site_name: siteName,
    organizer_email: email,
    topic_types_b64: encodeTopicTypes(cleanTopicTypes(storedList(record.topicTypes))),
    ai_provider: aiProvider,
    ai_key_source: aiKeySource,
    community_seed: seedForManifest({ communitySeed: record.communitySeed, communityName: siteName }),
    ...(aiKey !== undefined ? { ai_key: aiKey } : {}),
    // The host's address for a member's page report (fresh3 23-05: the site
    // reads HOST_REPORT_EMAIL). One plain address or nothing: anything else is
    // left out, and the site logs that no host address is set.
    ...(hostAddress(deps.config.hostReportEmail) ? { host_report_email: hostAddress(deps.config.hostReportEmail) } : {})
  })
}

/** One plain address (something@domain.tld, no spaces, commas or controls), or ''. */
function hostAddress(value: unknown): string {
  const v = typeof value === 'string' ? value.trim() : ''
  return /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(v) ? v : ''
}

/**
 * Handle POST /api/provision-manifest/ack, body {provision_id}.
 * Pure function for testability.
 *
 * The workflow says "copied" once it has written a site's details into the new
 * site's environment, and the sealed organizer key (byok:{provisionId}, written
 * by 23-18) is deleted at once (D-21, T-23-73). The same token check as the
 * manifest runs first; the id that is deleted is the one the token was made
 * for. The answer is 200 whether or not a slot existed, and it is the same
 * body either way, so it never says whether the site brought a key.
 */
export async function handleManifestAck(
  body: unknown,
  authHeader: string | undefined,
  deps: ManifestDeps
): Promise<ManifestReply> {
  const provisionId = claimedProvisionId((body as { provision_id?: unknown } | null)?.provision_id)
  if (!provisionId || !hasValidProvisionToken(authHeader, provisionId, deps.config.provisionCallbackSecret)) {
    return unauthorized()
  }
  await deleteProvisionKey(deps.redis, provisionId)
  return reply(200, { acked: true })
}

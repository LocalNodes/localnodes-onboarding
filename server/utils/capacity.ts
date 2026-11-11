// Server room (Phase 23, plan 23-17, D-08, TA-8). Plain module, no Nitro
// globals: Redis, fetch and the settings are injected, so the tests import it
// directly and the routes (capacity.get.ts, capacity-report.post.ts and
// create-checkout.post.ts) only wire it up.
//
// A small script on the VPS (fresh3 scripts/ops/capacity-push.sh) reports free
// memory, free Docker disk, the 1-minute load and the CPU count every 5 minutes
// to POST /api/capacity-report, with a bearer secret. The reading lives in
// capacity:vps for 15 minutes. Before anyone pays, hasRoom decides whether one
// more site fits:
//   - the reading is fresher than 15 minutes;
//   - memAvailableMb - perSiteMb x in-flight >= perSiteMb + headroomMb;
//   - dockerFreeGb >= minDockerFreeGb;
//   - load1 < nproc;
//   - running apps (Coolify) + in-flight sign-ups < maxSites.
// Every number is runtime config (NUXT_CAPACITY_*). A missing or stale reading,
// a bad setting, or any error reading Redis or Coolify means full: no payment
// is taken (T-23-54).
//
// In-flight sign-ups are a sorted set, capacity:inflight (member: provision id,
// score: expiry in ms, 45 minutes out). A sign-up is counted from create-checkout
// until its build completes, its final stop, or its checkout expires; each of
// those calls removeInflight. A member nobody removes drops out on its own.
//
// When full, the address goes on the Resend early-access segment with the
// contact property waiting_for_room set to the string "true". Resend properties
// are String or Number only (TA-8); a boolean would be refused.
//
// Privacy rule, as early-access.ts: the email address is never logged, never
// put in an error message and never used as a Redis key.
import * as v from 'valibot'
import type Stripe from 'stripe'
import { PROVISION_ID_PATTERN } from '../../shared/provisioning'
import { addResendContact } from './early-access'
import type { InviteRecord } from './invites'

export const CAPACITY_KEY = 'capacity:vps'
export const INFLIGHT_KEY = 'capacity:inflight'
export const APPS_KEY = 'capacity:apps'
/** A reading is good for 15 minutes; the VPS pushes every 5. */
export const REPORT_TTL_SECONDS = 900
/** How long a sign-up counts as in flight unless something removes it first. */
export const INFLIGHT_SECONDS = 2700
/** How long the running-app count from Coolify is reused. */
export const APPS_CACHE_SECONDS = 60
/** An invite's address is put on the waiting list at most once in this window by the capacity read. */
export const WAITING_MARK_SECONDS = 21600

/** The full-server reply (23-UI-SPEC section 3, "Full server"), word for word. */
export const FULL_MESSAGE = 'We are full right now; you have not been charged.'
/** The Resend contact property for people waiting for room (created 2026-11-08, TA-8). A String property. */
export const WAITING_PROPERTY = 'waiting_for_room'

/** The subset of the Upstash client this file uses, typed as Upstash types it. */
export interface CapacityRedis {
  get: <T = unknown>(key: string) => Promise<T | null>
  set: (key: string, value: unknown, opts: { ex: number }) => Promise<unknown>
  zcount: (key: string, min: number | string, max: number | string) => Promise<number>
}

/** The Upstash calls that add an in-flight sign-up, typed as Upstash types them. */
export interface InflightRedis {
  zadd: (key: string, scoreMember: { score: number, member: string }) => Promise<unknown>
  zremrangebyscore: (key: string, min: number | '-inf' | '+inf', max: number | '-inf' | '+inf') => Promise<unknown>
  expire: (key: string, seconds: number) => Promise<unknown>
}

/** Room settings. NUXT_ env overrides arrive as strings, so every value is read through Number(). */
export interface RoomConfig {
  perSiteMb: number | string
  headroomMb: number | string
  minDockerFreeGb: number | string
  maxSites: number | string
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/

/** What the VPS sends. Bounds keep a forged or broken reading from meaning anything (T-23-53). */
export const capacityReportSchema = v.object({
  memAvailableMb: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10_000_000)),
  dockerFreeGb: v.pipe(v.number(), v.minValue(0), v.maxValue(1_000_000)),
  load1: v.pipe(v.number(), v.minValue(0), v.maxValue(100_000)),
  nproc: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4096)),
  reportedAt: v.pipe(v.string(), v.maxLength(40), v.regex(ISO_UTC))
})

const storedSchema = v.object({
  ...capacityReportSchema.entries,
  receivedAt: v.pipe(v.number(), v.integer(), v.minValue(0))
})

export type ReportOutcome =
  | { status: 200, body: { ok: true } }
  | { status: 400 | 401, body: { ok: false, message: string } }

/** Does this Authorization header carry the report secret? Constant time; an empty secret lets nothing through. */
export function hasReportBearer(authHeader: string | undefined, secret: string): boolean {
  if (!secret || !authHeader || !authHeader.startsWith('Bearer ')) return false
  // Web APIs only, so the typecheck needs no Node types (as 23-33's seed code).
  const given = new TextEncoder().encode(authHeader.slice('Bearer '.length))
  const expected = new TextEncoder().encode(secret)
  // The length of the secret is not a secret.
  if (given.length !== expected.length) return false
  // Constant time: every byte is compared, whatever the first difference.
  let diff = 0
  for (let i = 0; i < given.length; i++) diff |= given[i]! ^ expected[i]!
  return diff === 0
}

/**
 * POST /api/capacity-report. The bearer is checked before the body is read.
 * Stores the reading with the time it arrived (server clock) for 15 minutes.
 */
export async function recordReport(
  raw: unknown,
  authHeader: string | undefined,
  deps: { redis: Pick<CapacityRedis, 'set'>, secret: string, now?: () => number }
): Promise<ReportOutcome> {
  if (!hasReportBearer(authHeader, deps.secret)) return { status: 401, body: { ok: false, message: 'Unauthorized' } }
  const parsed = v.safeParse(capacityReportSchema, raw)
  if (!parsed.success) return { status: 400, body: { ok: false, message: 'Invalid report' } }
  const receivedAt = (deps.now ?? Date.now)()
  await deps.redis.set(CAPACITY_KEY, { ...parsed.output, receivedAt }, { ex: REPORT_TTL_SECONDS })
  return { status: 200, body: { ok: true } }
}

export interface RoomDeps {
  redis: CapacityRedis
  config: RoomConfig
  /** Running apps on the server (countRunningApps). A throw means full. */
  runningApps: () => Promise<number>
  /** Milliseconds. Tests inject it. */
  now?: () => number
  log?: (msg: string) => void
}

const finite = (value: unknown): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) throw new Error('capacity: a room setting is not a number')
  return n
}

/** Sign-ups still in flight at this moment. */
export async function inflightCount(redis: Pick<CapacityRedis, 'zcount'>, now: number): Promise<number> {
  return redis.zcount(INFLIGHT_KEY, now, '+inf')
}

/** Is there room for one more site? Never throws: anything unknown means false. */
export async function hasRoom(deps: RoomDeps): Promise<boolean> {
  try {
    const now = (deps.now ?? Date.now)()
    const perSite = finite(deps.config.perSiteMb)
    const headroom = finite(deps.config.headroomMb)
    const minDocker = finite(deps.config.minDockerFreeGb)
    const maxSites = finite(deps.config.maxSites)
    if (maxSites <= 0) return false

    const stored = v.safeParse(storedSchema, await deps.redis.get(CAPACITY_KEY))
    if (!stored.success) return false
    const report = stored.output
    if (now - report.receivedAt >= REPORT_TTL_SECONDS * 1000) return false

    const inflight = await inflightCount(deps.redis, now)
    if (report.memAvailableMb - perSite * inflight < perSite + headroom) return false
    if (report.dockerFreeGb < minDocker) return false
    if (!(report.load1 < report.nproc)) return false

    const running = await deps.runningApps()
    if (!Number.isFinite(running) || running + inflight >= maxSites) return false
    return true
  } catch {
    deps.log?.('capacity: room unknown, counted as full')
    return false
  }
}

export type CoolifyFetch = (url: string, opts: { headers: Record<string, string> }) => Promise<unknown>

/**
 * Running resources on the server, from Coolify GET /servers/{uuid}/resources
 * (status "running:healthy", "running:unhealthy", ...). Every running resource
 * counts: each LocalNodes site is one compose application, and counting more is
 * the safe side. Cached in Redis for 60 seconds (serverless calls share no
 * memory). Throws when Coolify isn't configured or answers something that isn't
 * a list.
 */
export async function countRunningApps(deps: {
  redis: Pick<CapacityRedis, 'get' | 'set'>
  fetch: CoolifyFetch
  apiUrl: string
  token: string
  serverUuid: string
}): Promise<number> {
  const cached = await deps.redis.get(APPS_KEY)
  if (cached !== null && cached !== undefined && Number.isFinite(Number(cached))) return Number(cached)
  if (!deps.serverUuid) throw new Error('capacity: no Coolify server configured')
  if (!deps.token) throw new Error('capacity: no Coolify token configured')
  const list = await deps.fetch(`${deps.apiUrl}/servers/${encodeURIComponent(deps.serverUuid)}/resources`, {
    headers: { Authorization: `Bearer ${deps.token}`, Accept: 'application/json' }
  })
  if (!Array.isArray(list)) throw new Error('capacity: Coolify did not answer with a list')
  const running = list.filter(r => typeof r?.status === 'string' && r.status.startsWith('running')).length
  await deps.redis.set(APPS_KEY, running, { ex: APPS_CACHE_SECONDS })
  return running
}

export type WaitlistFetcher = (
  url: string,
  opts: { method: 'POST' | 'PATCH', headers: Record<string, string>, body: unknown }
) => Promise<unknown>

/**
 * Put an address on the early-access segment with waiting_for_room "true".
 * The create goes through addResendContact (the property, then without it).
 * An address that is already a contact (most invites came from the
 * early-access form) is refused by the create, so the property is then set on
 * the existing contact with PATCH /contacts/{email}. Throws when Resend is not
 * configured or the last call fails; the message never holds the address.
 */
export async function recordWaitingForRoom(
  email: string,
  cfg: { apiKey: string, segmentId: string, fetch: WaitlistFetcher }
): Promise<void> {
  if (!cfg.apiKey || !cfg.segmentId) throw new Error('waiting list: Resend not configured')
  const properties: Record<string, string> = { [WAITING_PROPERTY]: 'true' }
  try {
    await addResendContact({ email, community: '', groupKind: '', properties }, cfg.apiKey, cfg.segmentId, cfg.fetch)
    return
  } catch {
    // Most likely already a contact: set the property on it below.
  }
  try {
    await cfg.fetch(`https://api.resend.com/contacts/${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: { properties }
    })
  } catch (err) {
    const status = (err as { statusCode?: number, status?: number })?.statusCode ?? (err as { status?: number })?.status
    throw new Error(`waiting list: contact not updated (status ${status ?? 'unknown'})`)
  }
}

/** The status code of a thrown fetch error, for a log line that holds no address. */
export const errorStatus = (err: unknown): string => {
  const e = err as { statusCode?: number, status?: number } | null
  return String(e?.statusCode ?? e?.status ?? 'unknown')
}

export interface CapacityReadDeps {
  /** Used for the "added once" mark, keyed by invite id (never the address). */
  redis: Pick<CapacityRedis, 'get' | 'set'>
  /** The invited session behind the cookie, or null. */
  session: InviteRecord | null
  hasRoom: () => Promise<boolean>
  waitlist: (email: string) => Promise<void>
  log?: (msg: string) => void
}

/**
 * GET /api/capacity: answers {room} and nothing else. An invited session that
 * finds no room is put on the waiting list here (23-UI-SPEC section 3 build
 * note: the full screen offers no checkout; the screen itself no longer
 * promises an email, but the address is still kept for when there is room).
 * Once per invite per 6 hours,
 * and only marked after Resend accepted it, so a failed add is tried again on
 * the next read.
 */
export async function handleCapacityRead(deps: CapacityReadDeps): Promise<{ room: boolean }> {
  let room = false
  try {
    room = (await deps.hasRoom()) === true
  } catch {
    room = false
  }
  const session = deps.session
  if (!room && session?.email && session.inviteId) {
    const mark = `capacity:waiting:${session.inviteId}`
    try {
      if (!(await deps.redis.get(mark))) {
        await deps.waitlist(session.email)
        await deps.redis.set(mark, '1', { ex: WAITING_MARK_SECONDS })
      }
    } catch (err) {
      deps.log?.(`capacity: waiting list not updated (status ${errorStatus(err)})`)
    }
  }
  return { room }
}

/**
 * Count a sign-up as in flight for 45 minutes. Adding the same provision id
 * again moves its expiry and never adds a second member (a retry, or the
 * webhook re-arming it when the checkout completes). Expired members are
 * dropped on the way.
 */
export async function addInflight(redis: InflightRedis, provisionId: string, now: number = Date.now()): Promise<void> {
  await redis.zremrangebyscore(INFLIGHT_KEY, '-inf', now)
  await redis.zadd(INFLIGHT_KEY, { score: now + INFLIGHT_SECONDS * 1000, member: provisionId })
  await redis.expire(INFLIGHT_KEY, INFLIGHT_SECONDS)
}

/**
 * Stop counting a sign-up: its build completed, it was stopped, or its checkout
 * expired. Exported for the later declined-card teardown (B-1), which frees the
 * room the same way. Raises on a Redis error; callers decide whether that is
 * fatal (stopProvision's done flag) or only logged.
 */
export async function removeInflight(redis: { zrem: (key: string, ...members: string[]) => Promise<unknown> }, provisionId: string): Promise<void> {
  await redis.zrem(INFLIGHT_KEY, provisionId)
}

const sessionProvisionId = (session: Stripe.Checkout.Session): string | null => {
  const id = session.metadata?.provision_id
  return typeof id === 'string' && PROVISION_ID_PATTERN.test(id) ? id : null
}

/** checkout.session.expired: the sign-up never paid, so its room goes back. A session without a provision id is left alone. */
export async function releaseSessionCapacity(
  redis: { zrem: (key: string, ...members: string[]) => Promise<unknown> },
  session: Stripe.Checkout.Session
): Promise<void> {
  const id = sessionProvisionId(session)
  if (id) await removeInflight(redis, id)
}

/**
 * checkout.session.completed: count the build for 45 minutes from now. A
 * setup-mode checkout can stay open far longer than 45 minutes, so without this
 * a slow checkout would build without holding room.
 */
export async function rearmSessionCapacity(redis: InflightRedis, session: Stripe.Checkout.Session, now: () => number = Date.now): Promise<void> {
  const id = sessionProvisionId(session)
  if (id) await addInflight(redis, id, now())
}

/** The runtime settings the wiring reads (a subset of useRuntimeConfig()). */
export interface CapacityRuntimeConfig {
  capacityPerSiteMb: number | string
  capacityHeadroomMb: number | string
  capacityMinDockerFreeGb: number | string
  capacityMaxSites: number | string
  coolifyApiUrl: string
  coolifyApiToken: string
  coolifyServerUuid: string
  resendApiKey: string
  resendSegmentId: string
}

/**
 * The capacity calls a route needs, from the runtime config, a Redis getter and
 * fetch. The Redis getter is called inside each call, so a missing Upstash
 * setting is "full", never a crash.
 */
export function capacityWiring(
  config: CapacityRuntimeConfig,
  getRedis: () => CapacityRedis & InflightRedis,
  fetchers: { coolify: CoolifyFetch, resend: WaitlistFetcher },
  log?: (msg: string) => void
) {
  return {
    hasRoom: async () => {
      let redis: CapacityRedis
      try {
        redis = getRedis()
      } catch {
        log?.('capacity: Redis not configured, counted as full')
        return false
      }
      return hasRoom({
        redis,
        config: {
          perSiteMb: config.capacityPerSiteMb,
          headroomMb: config.capacityHeadroomMb,
          minDockerFreeGb: config.capacityMinDockerFreeGb,
          maxSites: config.capacityMaxSites
        },
        runningApps: () => countRunningApps({
          redis,
          fetch: fetchers.coolify,
          apiUrl: config.coolifyApiUrl,
          token: config.coolifyApiToken,
          serverUuid: config.coolifyServerUuid
        }),
        log
      })
    },
    waitlist: (email: string) => recordWaitingForRoom(email, { apiKey: config.resendApiKey, segmentId: config.resendSegmentId, fetch: fetchers.resend }),
    addInflight: (provisionId: string) => addInflight(getRedis(), provisionId)
  }
}

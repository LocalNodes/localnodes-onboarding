// In-memory double for the Upstash Redis client, shared by the Phase 23 tests
// (23-02 and every Nuxt plan after it). It never talks to a network.
//
// It copies the parts of Upstash behaviour that tests can trip over:
//   - values are stored as JSON text and parsed on read, as the Upstash client
//     does, so the string "1" comes back as the number 1 and an object round-trips;
//   - SET supports nx, xx, ex and px and answers 'OK' or null;
//   - TTL answers -2 for a missing key and -1 for a key with no expiry;
//   - time is a fake clock (advance(seconds)), so expiry tests don't sleep.
//
// eval has no Lua engine: register a JavaScript stand-in for a script with
// onEval(script, handler), or the call throws so a test never passes on air.
// The lifecycle scripts (server/utils/lifecycle.ts, 23-43) are registered
// from the start with their JS twins, which run synchronously over atomic(),
// a view of the same store with raw strings, as Lua sees them.
// loseReplies(script, n) applies the next n runs, then throws (a lost reply).

import { LIFECYCLE_TWINS, type AtomicView } from '../../../server/utils/lifecycle'
import { LATE_TWINS } from '../../../server/utils/pilot-late'
import { RELAYER_FUNDING_TWINS } from '../../../server/utils/relayer-funding'

type EvalHandler = (keys: string[], args: unknown[]) => unknown

const serialize = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value))

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

interface Entry {
  type: 'string' | 'hash' | 'zset'
  str?: string
  hash?: Map<string, string>
  zset?: Map<string, number>
  expiresAt?: number
}

export class FakeRedis {
  private store = new Map<string, Entry>()
  private evals = new Map<string, EvalHandler>()
  private lost = new Map<string, number>()
  private failing = new Map<string, { times: number, when?: (args: string[]) => boolean }>()
  /** Fake clock, in milliseconds. */
  private nowMs = 1_700_000_000_000

  constructor(opts: { lifecycle?: boolean } = {}) {
    if (opts.lifecycle !== false) this.registerLifecycleTwins()
  }

  /** Register every lifecycle script's twin (done by the constructor unless { lifecycle: false }). */
  registerLifecycleTwins(): void {
    LIFECYCLE_TWINS.concat(LATE_TWINS, RELAYER_FUNDING_TWINS).forEach(([script, twin]) => {
      this.onEval(script, (keys, args) => twin(this.atomic(), keys, args.map(a => String(a))))
    })
  }

  /** The next `times` runs of `script` apply, then throw as a lost reply would. */
  loseReplies(script: string, times = 1): void {
    this.lost.set(script, times)
  }

  /** The next `times` runs of `script` (matching `when`, if given) throw before they apply. */
  failEvals(script: string, times = 1, when?: (args: string[]) => boolean): void {
    this.failing.set(script, { times, when })
  }

  /** The fake clock now, in ms. */
  nowMillis(): number {
    return this.nowMs
  }

  /**
   * A synchronous view of the store with raw strings (a twin's whole world).
   * It throws WRONGTYPE as Redis does; the twins validate types first.
   */
  atomic(): AtomicView {
    const self = this
    const intRe = /^-?\d+$/
    return {
      type: key => (self.live(key) ? self.store.get(key)!.type : 'none'),
      exists: key => (self.live(key) ? 1 : 0),
      get: key => self.entry(key, 'string')?.str ?? null,
      set: (key, value, opts) => {
        if (opts.nx && self.live(key)) return false
        const e: Entry = { type: 'string', str: value }
        if (opts.ex !== undefined) e.expiresAt = self.nowMs + opts.ex * 1000
        if (opts.px !== undefined) e.expiresAt = self.nowMs + opts.px
        self.store.set(key, e)
        return true
      },
      del: key => {
        if (!self.live(key)) return 0
        self.store.delete(key)
        return 1
      },
      hget: (key, field) => self.entry(key, 'hash')?.hash!.get(field) ?? null,
      hset: (key, pairs) => {
        const e = self.ensure(key, 'hash')
        pairs.forEach(([f, v]) => e.hash!.set(f, v))
      },
      hincrby: (key, field, by) => {
        const e = self.ensure(key, 'hash')
        const cur = e.hash!.get(field) ?? '0'
        if (!intRe.test(cur) || !Number.isInteger(by)) throw new Error('ERR hash value is not an integer')
        const next = Number(cur) + by
        e.hash!.set(field, String(next))
        return next
      },
      zadd: (key, score, member) => {
        self.ensure(key, 'zset').zset!.set(member, score)
      },
      zrem: (key, member) => {
        const e = self.entry(key, 'zset')
        if (!e?.zset!.delete(member)) return 0
        // As Redis: a sorted set left empty is deleted.
        if (e.zset!.size === 0) self.store.delete(key)
        return 1
      },
      pttl: key => {
        if (!self.live(key)) return -2
        const e = self.store.get(key)!
        return e.expiresAt === undefined ? -1 : e.expiresAt - self.nowMs
      },
      pexpire: (key, ms) => {
        if (!self.live(key)) return 0
        self.store.get(key)!.expiresAt = self.nowMs + ms
        return 1
      }
    }
  }

  // --- test helpers -------------------------------------------------------

  /** Move the fake clock forward; keys past their expiry vanish on the next read. */
  advance(seconds: number): void {
    this.nowMs += seconds * 1000
  }

  /** Every live key, for tests that assert what was or wasn't stored. */
  keys(): string[] {
    return [...this.store.keys()].filter(k => this.live(k))
  }

  /** The stored text of a string key, unparsed. */
  raw(key: string): string | undefined {
    return this.live(key) ? this.store.get(key)?.str : undefined
  }

  /** Everything stored, keys and values, as one string: for "no email in Redis keys" checks. */
  dump(): string {
    return this.keys().map(k => `${k} ${this.dumpEntry(this.store.get(k)!)}`).join('\n')
  }

  onEval(script: string, handler: EvalHandler): void {
    this.evals.set(script, handler)
  }

  // --- internals ----------------------------------------------------------

  private dumpEntry(e: Entry): string {
    if (e.type === 'string') return e.str ?? ''
    if (e.type === 'hash') return JSON.stringify([...(e.hash ?? [])])
    return JSON.stringify([...(e.zset ?? [])])
  }

  private live(key: string): boolean {
    const e = this.store.get(key)
    if (!e) return false
    if (e.expiresAt !== undefined && e.expiresAt <= this.nowMs) {
      this.store.delete(key)
      return false
    }
    return true
  }

  private entry(key: string, type: Entry['type']): Entry | undefined {
    if (!this.live(key)) return undefined
    const e = this.store.get(key)!
    if (e.type !== type) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
    return e
  }

  private ensure(key: string, type: Entry['type']): Entry {
    const existing = this.entry(key, type)
    if (existing) return existing
    const e: Entry = { type, hash: type === 'hash' ? new Map() : undefined, zset: type === 'zset' ? new Map() : undefined }
    this.store.set(key, e)
    return e
  }

  // --- strings ------------------------------------------------------------

  async set(key: string, value: unknown, opts: { nx?: boolean, xx?: boolean, ex?: number, px?: number } = {}): Promise<'OK' | null> {
    const exists = this.live(key)
    if (opts.nx && exists) return null
    if (opts.xx && !exists) return null
    const e: Entry = { type: 'string', str: serialize(value) }
    if (opts.ex !== undefined) e.expiresAt = this.nowMs + opts.ex * 1000
    if (opts.px !== undefined) e.expiresAt = this.nowMs + opts.px
    this.store.set(key, e)
    return 'OK'
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const e = this.entry(key, 'string')
    return e ? (parse(e.str!) as T) : null
  }

  async getdel<T = unknown>(key: string): Promise<T | null> {
    const e = this.entry(key, 'string')
    if (!e) return null
    this.store.delete(key)
    return parse(e.str!) as T
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0
    for (const k of keys) {
      if (this.live(k)) {
        this.store.delete(k)
        n++
      }
    }
    return n
  }

  async exists(...keys: string[]): Promise<number> {
    return keys.filter(k => this.live(k)).length
  }

  async incr(key: string): Promise<number> {
    const e = this.entry(key, 'string')
    const next = (e ? Number(e.str) : 0) + 1
    if (e) e.str = String(next)
    else this.store.set(key, { type: 'string', str: String(next) })
    return next
  }

  async rename(from: string, to: string): Promise<'OK'> {
    if (!this.live(from)) throw new Error('ERR no such key')
    this.store.set(to, this.store.get(from)!)
    this.store.delete(from)
    return 'OK'
  }

  // --- expiry -------------------------------------------------------------

  async ttl(key: string): Promise<number> {
    if (!this.live(key)) return -2
    const e = this.store.get(key)!
    return e.expiresAt === undefined ? -1 : Math.ceil((e.expiresAt - this.nowMs) / 1000)
  }

  async pttl(key: string): Promise<number> {
    return this.atomic().pttl(key)
  }

  async pexpire(key: string, ms: number): Promise<0 | 1> {
    return this.atomic().pexpire(key, ms) as 0 | 1
  }

  async type(key: string): Promise<string> {
    return this.atomic().type(key)
  }

  async expire(key: string, seconds: number): Promise<0 | 1> {
    if (!this.live(key)) return 0
    this.store.get(key)!.expiresAt = this.nowMs + seconds * 1000
    return 1
  }

  // --- hashes -------------------------------------------------------------

  async hset(key: string, fields: Record<string, unknown>): Promise<number> {
    const e = this.ensure(key, 'hash')
    let added = 0
    for (const [f, v] of Object.entries(fields)) {
      if (!e.hash!.has(f)) added++
      e.hash!.set(f, serialize(v))
    }
    return added
  }

  async hgetall<T = Record<string, unknown>>(key: string): Promise<T | null> {
    const e = this.entry(key, 'hash')
    if (!e || e.hash!.size === 0) return null
    return Object.fromEntries([...e.hash!].map(([f, v]) => [f, parse(v)])) as T
  }

  async hincrby(key: string, field: string, by: number): Promise<number> {
    const e = this.ensure(key, 'hash')
    const next = Number(e.hash!.get(field) ?? 0) + by
    e.hash!.set(field, String(next))
    return next
  }

  // --- sorted sets --------------------------------------------------------

  async zadd(key: string, ...entries: Array<{ score: number, member: string }>): Promise<number> {
    const e = this.ensure(key, 'zset')
    let added = 0
    for (const { score, member } of entries) {
      if (!e.zset!.has(member)) added++
      e.zset!.set(member, score)
    }
    return added
  }

  async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
    const e = this.entry(key, 'zset')
    if (!e) return []
    const lo = min === '-inf' ? -Infinity : Number(min)
    const hi = max === '+inf' ? Infinity : Number(max)
    return [...e.zset!]
      .filter(([, s]) => s >= lo && s <= hi)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([m]) => m)
  }

  /**
   * As Upstash's zrange: by rank, or with `byScore` by score ('-inf' and
   * '+inf' allowed), ordered by score then member, then sliced by `offset` and
   * `count` when both are given (23-38's sweep reads sweep:stops this way).
   */
  async zrange(
    key: string,
    min: number | string,
    max: number | string,
    opts: { byScore?: boolean, offset?: number, count?: number } = {}
  ): Promise<string[]> {
    let members: string[]
    if (opts.byScore) {
      members = await this.zrangebyscore(key, min, max)
    } else {
      const e = this.entry(key, 'zset')
      const all = e
        ? [...e.zset!].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([m]) => m)
        : []
      const n = all.length
      const lo = Math.max(0, Number(min) < 0 ? n + Number(min) : Number(min))
      const hi = Number(max) < 0 ? n + Number(max) : Number(max)
      members = all.slice(lo, hi + 1)
    }
    if (opts.offset !== undefined && opts.count !== undefined) {
      members = members.slice(opts.offset, opts.offset + opts.count)
    }
    return members
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const e = this.entry(key, 'zset')
    if (!e) return 0
    let n = 0
    for (const m of members) if (e.zset!.delete(m)) n++
    // As Redis: a sorted set left empty is deleted.
    if (e.zset!.size === 0) this.store.delete(key)
    return n
  }

  /** As Upstash and Redis: members with min <= score <= max ('-inf' and '+inf' allowed). */
  async zcount(key: string, min: number | string, max: number | string): Promise<number> {
    return (await this.zrangebyscore(key, min, max)).length
  }

  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
    const doomed = await this.zrangebyscore(key, min, max)
    const e = this.entry(key, 'zset')
    for (const m of doomed) e?.zset!.delete(m)
    return doomed.length
  }

  async zcard(key: string): Promise<number> {
    return this.entry(key, 'zset')?.zset!.size ?? 0
  }

  async zscore(key: string, member: string): Promise<number | null> {
    return this.entry(key, 'zset')?.zset!.get(member) ?? null
  }

  // --- scripts ------------------------------------------------------------

  async eval(script: string, keys: string[], args: unknown[]): Promise<unknown> {
    const handler = this.evals.get(script)
    if (!handler) throw new Error('fake-redis: eval script not registered (use onEval)')
    const fail = this.failing.get(script)
    if (fail && fail.times > 0 && (!fail.when || fail.when(args.map(a => String(a))))) {
      fail.times--
      throw new Error('fake-redis: the eval failed before it applied')
    }
    const out = await handler(keys, args)
    const lose = this.lost.get(script) ?? 0
    if (lose > 0) {
      this.lost.set(script, lose - 1)
      throw new Error('fake-redis: the reply was lost')
    }
    return out
  }
}

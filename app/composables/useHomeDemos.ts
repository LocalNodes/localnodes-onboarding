// The home page's demo controller.
//
// One controller owns everything that moves: Pause, reduced motion (live), every timer, the
// scroll observer and the listeners. The server renders the finished states, so the page is
// complete before any script runs; the client then plays the demos on top of that.
//
// Every sleep is pause-aware: Pause stops the clock on
// the sleep in flight and Play carries on with the time that was left.
import { inject, reactive } from 'vue'
import demoData from '../data/home-demo.json'

export type HomeDemoData = typeof demoData
export type HomeAct = 'chips' | 'decide' | 'fund' | 'export'

interface QueryListLike {
  matches: boolean
  addEventListener: (type: 'change', fn: (e: { matches: boolean }) => void) => void
  removeEventListener: (type: 'change', fn: (e: { matches: boolean }) => void) => void
}

export interface HomeDemoEnv {
  matchMedia?: (query: string) => QueryListLike
  IntersectionObserver?: typeof IntersectionObserver
}

interface Sleep {
  run: Run
  left: number
  startedAt: number
  id: ReturnType<typeof setTimeout> | undefined
  resolve: (ok: boolean) => void
}

interface Run {
  dead: boolean
  sleeps: Set<Sleep>
}

export const HOME_DEMOS_KEY = 'homeDemos'

/** `$` and en-US grouping, as the fund window prints amounts. */
export function formatUsd(n: number): string {
  return '$' + n.toLocaleString('en-US')
}

export function useHomeDemos(data: HomeDemoData = demoData, env: HomeDemoEnv = {}) {
  const ex = data.hero.examples
  const wordsOf = (a: string) => a.split(' ').length

  // ---- finished and starting states -----------------------------------------------------
  function heroFinished(i: number) {
    const c = ex[i]!
    return {
      index: i,
      typing: false,
      typed: '',
      caret: false,
      status: 'read' as 'none' | 'reading' | 'read',
      rail: c.docs.map((_, j) => ({ scan: false, read: j === c.read, hit: j === c.hit })),
      near: c.docs.map(() => false),
      words: wordsOf(c.a),
      qOn: true,
      citeOn: true,
      paperOn: true,
      paperLit: true
    }
  }

  function heroStart(i: number) {
    const c = ex[i]!
    return {
      index: i,
      typing: false,
      typed: '',
      caret: true,
      status: 'none' as 'none' | 'reading' | 'read',
      rail: c.docs.map(() => ({ scan: false, read: false, hit: false })),
      near: c.docs.map(() => false),
      words: 0,
      qOn: false,
      citeOn: false,
      paperOn: false,
      paperLit: false
    }
  }

  const decideFinished = () => ({
    dots: [...data.decide.dots] as string[],
    agree: data.decide.agree,
    aside: data.decide.aside,
    block: data.decide.block,
    done: true,
    pop: -1
  })

  const decideStart = () => ({
    dots: data.decide.dots.map(() => ''),
    agree: 0,
    aside: 0,
    block: 0,
    done: false,
    pop: -1
  })

  const fundFinished = () => ({
    balance: data.fund.balanceAfter,
    approved: data.fund.approved,
    paid: true,
    note: true
  })

  const fundStart = () => ({
    balance: data.fund.balanceBefore,
    approved: 0,
    paid: false,
    note: false
  })

  const exportFinished = () => ({ rowsOk: data.export.rows.length, busy: false, done: true })
  const exportStart = () => ({ rowsOk: 0, busy: false, done: false })

  const state = reactive({
    mounted: false,
    paused: false,
    reducedMotion: false,
    chipsTidy: false,
    hero: heroFinished(0),
    decide: decideFinished(),
    fund: fundFinished(),
    exp: exportFinished()
  })

  // ---- the clock -------------------------------------------------------------------------
  const slots = new Map<string, Run>()
  let heroManual = false

  function arm(sl: Sleep) {
    sl.startedAt = Date.now()
    sl.id = setTimeout(() => {
      sl.id = undefined
      sl.run.sleeps.delete(sl)
      sl.resolve(true)
    }, sl.left)
  }

  function sleep(run: Run, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (run.dead) return resolve(false)
      const sl: Sleep = { run, left: ms, startedAt: 0, id: undefined, resolve }
      run.sleeps.add(sl)
      if (!state.paused) arm(sl)
    })
  }

  function holdAll() {
    const now = Date.now()
    for (const run of slots.values()) {
      for (const sl of run.sleeps) {
        if (sl.id === undefined) continue
        clearTimeout(sl.id)
        sl.id = undefined
        sl.left = Math.max(0, sl.left - (now - sl.startedAt))
      }
    }
  }

  function releaseAll() {
    for (const run of slots.values()) {
      for (const sl of run.sleeps) if (sl.id === undefined) arm(sl)
    }
  }

  /** Acts that scrolled into view while the page was paused: they start on Play, not before. */
  const waiting = new Set<HomeAct>()

  function setPaused(v: boolean) {
    if (state.paused === v) return
    state.paused = v
    if (v) {
      holdAll()
      return
    }
    releaseAll()
    const queued = [...waiting]
    waiting.clear()
    for (const act of queued) startAct(act)
  }

  function cancel(run: Run) {
    run.dead = true
    for (const sl of run.sleeps) {
      if (sl.id !== undefined) clearTimeout(sl.id)
      sl.id = undefined
      sl.resolve(false)
    }
    run.sleeps.clear()
  }

  function cancelSlot(key: string) {
    const run = slots.get(key)
    if (run) cancel(run)
    slots.delete(key)
  }

  function cancelAll() {
    for (const run of slots.values()) cancel(run)
    slots.clear()
    waiting.clear()
  }

  function start(key: string, body: (run: Run) => Promise<unknown>) {
    cancelSlot(key)
    const run: Run = { dead: false, sleeps: new Set() }
    slots.set(key, run)
    void body(run)
  }

  const canAnimate = () => state.mounted && !state.reducedMotion

  // ---- the hero: one question, one answer, the page it came from --------------------------
  async function runHero(run: Run, i: number): Promise<boolean> {
    const c = ex[i]!
    Object.assign(state.hero, heroStart(i))
    if (!(await sleep(run, 500))) return false
    state.hero.typing = true
    for (let k = 1; k <= c.q.length; k++) {
      state.hero.typed = c.q.slice(0, k)
      if (!(await sleep(run, 26))) return false
    }
    if (!(await sleep(run, 320))) return false
    state.hero.typing = false
    state.hero.typed = ''
    state.hero.caret = false
    state.hero.qOn = true
    if (!(await sleep(run, 350))) return false
    state.hero.status = 'reading'
    for (let j = 0; j < c.docs.length; j++) {
      state.hero.rail[j]!.scan = true
      state.hero.near[j] = true
      if (!(await sleep(run, 130))) return false
    }
    if (!(await sleep(run, 200))) return false
    for (let j = 0; j < c.docs.length; j++) {
      state.hero.rail[j]!.scan = false
      state.hero.near[j] = false
    }
    state.hero.rail[c.read]!.read = true
    if (!(await sleep(run, 220))) return false
    state.hero.rail[c.hit]!.hit = true
    if (!(await sleep(run, 380))) return false
    state.hero.status = 'read'
    for (let k = 1; k <= wordsOf(c.a); k++) {
      state.hero.words = k
      if (!(await sleep(run, 70))) return false
    }
    if (!(await sleep(run, 260))) return false
    state.hero.citeOn = true
    if (!(await sleep(run, 420))) return false
    state.hero.paperOn = true
    if (!(await sleep(run, 300))) return false
    Object.assign(state.hero, heroFinished(i))
    return true
  }

  function startAutoplay() {
    if (heroManual) return
    start('hero', async (run) => {
      if (!(await sleep(run, 4200))) return
      let i = state.hero.index
      for (;;) {
        i = (i + 1) % ex.length
        if (!(await runHero(run, i))) return
        if (!(await sleep(run, 6200))) return
      }
    })
  }

  function selectExample(i: number) {
    heroManual = true
    if (!canAnimate()) {
      cancelSlot('hero')
      Object.assign(state.hero, heroFinished(i))
      return
    }
    setPaused(false)
    start('hero', run => runHero(run, i))
  }

  // ---- the acts --------------------------------------------------------------------------
  function finishAct(act: HomeAct) {
    if (act === 'chips') state.chipsTidy = true
    else if (act === 'decide') Object.assign(state.decide, decideFinished())
    else if (act === 'fund') Object.assign(state.fund, fundFinished())
    else Object.assign(state.exp, exportFinished())
  }

  async function runDecide(run: Run) {
    Object.assign(state.decide, decideStart())
    if (!(await sleep(run, 700))) return
    const kinds = data.decide.dots
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i]!
      if (!kind) continue
      state.decide.dots[i] = kind
      state.decide.pop = i
      if (kind === 'agree') state.decide.agree++
      else if (kind === 'aside') state.decide.aside++
      else state.decide.block++
      if (!(await sleep(run, 170))) return
      state.decide.pop = -1
      if (!(await sleep(run, 110))) return
    }
    if (!(await sleep(run, 450))) return
    Object.assign(state.decide, decideFinished())
  }

  async function runFund(run: Run) {
    Object.assign(state.fund, fundStart())
    for (let a = 1; a <= data.fund.approved; a++) {
      if (!(await sleep(run, 900))) return
      state.fund.approved = a
    }
    if (!(await sleep(run, 600))) return
    state.fund.paid = true
    const each = data.fund.payment / data.fund.steps
    for (let k = 1; k <= data.fund.steps; k++) {
      state.fund.balance = data.fund.balanceBefore - each * k
      if (!(await sleep(run, 45))) return
    }
    if (!(await sleep(run, 350))) return
    Object.assign(state.fund, fundFinished())
  }

  async function runExport(run: Run) {
    Object.assign(state.exp, exportStart())
    if (!(await sleep(run, 1100))) return
    state.exp.busy = true
    for (let i = 0; i < data.export.rows.length; i++) {
      if (!(await sleep(run, 520))) return
      state.exp.rowsOk = i + 1
    }
    if (!(await sleep(run, 500))) return
    Object.assign(state.exp, exportFinished())
  }

  async function runChips(run: Run) {
    if (!(await sleep(run, 500))) return
    state.chipsTidy = true
  }

  function startAct(act: HomeAct) {
    if (!canAnimate()) return finishAct(act)
    const body = { chips: runChips, decide: runDecide, fund: runFund, export: runExport }[act]
    start(act, body)
  }

  /** The "Play again" buttons: restart one act, and take the page off Pause. */
  function play(act: HomeAct) {
    waiting.delete(act)
    if (canAnimate()) setPaused(false)
    startAct(act)
  }

  // ---- scroll observer and media query -----------------------------------------------------
  const watched = new Map<Element, HomeAct>()
  let io: IntersectionObserver | null = null
  let mql: QueryListLike | null = null

  function ensureObserver() {
    if (io || !canAnimate()) return
    const Ctor = env.IntersectionObserver ?? (typeof IntersectionObserver === 'undefined' ? undefined : IntersectionObserver)
    if (!Ctor) return
    io = new Ctor((entries) => {
      for (const e of entries) {
        // threshold 1 means fully in view; a sliver (ratio 0.1) must neither start the act nor stop
        // the watching. 0.99 allows for the browser's rounding.
        if (!e.isIntersecting || e.intersectionRatio < 0.99) continue
        io?.unobserve(e.target)
        const act = watched.get(e.target)
        if (!act) continue
        // While paused an act does not start (starting resets it to its first frame): it waits for Play.
        if (state.paused) waiting.add(act)
        else startAct(act)
      }
    }, { threshold: 1 })
    for (const el of watched.keys()) io.observe(el)
  }

  function observe(act: HomeAct, el: Element) {
    watched.set(el, act)
    io?.observe(el)
  }

  function finishAll() {
    Object.assign(state.hero, heroFinished(state.hero.index))
    Object.assign(state.decide, decideFinished())
    Object.assign(state.fund, fundFinished())
    Object.assign(state.exp, exportFinished())
    state.chipsTidy = true
  }

  function goReduced() {
    cancelAll()
    io?.disconnect()
    io = null
    state.paused = false
    state.reducedMotion = true
    finishAll()
  }

  function goMotion() {
    state.reducedMotion = false
    ensureObserver()
    startAutoplay()
  }

  function onMotionChange(e: { matches: boolean }) {
    if (e.matches) goReduced()
    else goMotion()
  }

  function mount() {
    if (state.mounted) return
    state.mounted = true
    const mm = env.matchMedia ?? ((q: string) => window.matchMedia(q))
    mql = mm('(prefers-reduced-motion: reduce)')
    mql.addEventListener('change', onMotionChange)
    if (mql.matches) goReduced()
    else goMotion()
  }

  function unmount() {
    mql?.removeEventListener('change', onMotionChange)
    mql = null
    cancelAll()
    io?.disconnect()
    io = null
    state.mounted = false
  }

  /** The cursor wakes the nearest document ring node (-1 clears). */
  function wake(j: number) {
    if (!canAnimate() || state.paused) return
    state.hero.near = state.hero.near.map((_, k) => k === j)
  }

  function heroAlt(): string {
    const c = ex[state.hero.index]!
    return `Example for ${c.name}. Question: ${c.q} Answer: ${c.a} Source: ${c.cite}. The page says: ${c.p[1]}`
  }

  return {
    data,
    state,
    mount,
    unmount,
    observe,
    selectExample,
    play,
    wake,
    togglePause: () => setPaused(!state.paused),
    pauseLabel: () => (state.paused ? 'Play' : 'Pause'),
    heroAlt,
    formatUsd
  }
}

export type HomeDemos = ReturnType<typeof useHomeDemos>

/** For the Home* components: the controller index.vue provided. */
export function injectHomeDemos(): HomeDemos {
  const d = inject<HomeDemos>(HOME_DEMOS_KEY)
  if (!d) throw new Error('useHomeDemos() must be provided by the home page')
  return d
}

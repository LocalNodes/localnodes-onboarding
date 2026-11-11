// The home page's demo controller: one controller owns Pause,
// reduced motion (live), every timer, the scroll observer and the listeners. Fake timers
// stand in for the clock; a fake media query and a fake IntersectionObserver stand in for
// the browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import demo from '~/data/home-demo.json'
import { useHomeDemos, formatUsd } from '~/composables/useHomeDemos'

function fakeMql(matches: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>()
  return {
    matches,
    addEventListener: vi.fn((_t: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn)),
    removeEventListener: vi.fn((_t: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn)),
    fire(m: boolean) {
      this.matches = m
      for (const fn of [...listeners]) fn({ matches: m })
    },
    get count() {
      return listeners.size
    }
  }
}

class FakeObserver {
  static last: FakeObserver | null = null
  seen = new Set<unknown>()
  disconnected = false
  constructor(public cb: (entries: Array<{ isIntersecting: boolean, intersectionRatio: number, target: unknown }>) => void, public opts?: { threshold?: number }) {
    FakeObserver.last = this
  }

  observe(el: unknown) {
    this.seen.add(el)
  }

  unobserve(el: unknown) {
    this.seen.delete(el)
  }

  disconnect() {
    this.seen.clear()
    this.disconnected = true
  }

  show(el: unknown, intersectionRatio = 1) {
    this.cb([{ isIntersecting: true, intersectionRatio, target: el }])
  }
}

function make(reduced = false) {
  const mql = fakeMql(reduced)
  const d = useHomeDemos(demo, {
    matchMedia: () => mql,
    IntersectionObserver: FakeObserver as unknown as typeof IntersectionObserver
  })
  const els = { chips: {}, decide: {}, fund: {}, export: {} }
  for (const [act, el] of Object.entries(els)) d.observe(act as keyof typeof els, el as Element)
  return { d, mql, els }
}

/** What a finished page looks like, as plain data. */
function snap(d: ReturnType<typeof useHomeDemos>) {
  const s = d.state
  return JSON.parse(JSON.stringify({ hero: s.hero, decide: s.decide, fund: s.fund, exp: s.exp, chipsTidy: s.chipsTidy }))
}

const ex = demo.hero.examples

beforeEach(() => {
  vi.useFakeTimers()
  FakeObserver.last = null
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the finished state (what the server renders, what reduced motion shows)', () => {
  it('shows example 1 answered with its source, the decision agreed, the payment made and the export ready', () => {
    const { d } = make()
    const s = d.state
    expect(s.hero.index).toBe(0)
    expect(s.hero.typing).toBe(false)
    expect(s.hero.qOn && s.hero.citeOn && s.hero.paperOn && s.hero.paperLit).toBe(true)
    expect(s.hero.words).toBe(ex[0]!.a.split(' ').length)
    expect(s.hero.status).toBe('read')
    expect(s.hero.rail[ex[0]!.read]!.read).toBe(true)
    expect(s.hero.rail[ex[0]!.hit]!.hit).toBe(true)
    expect([s.decide.agree, s.decide.aside, s.decide.block]).toEqual([demo.decide.agree, demo.decide.aside, demo.decide.block])
    expect(s.decide.dots).toEqual(demo.decide.dots)
    expect(s.decide.done).toBe(true)
    expect(s.fund.balance).toBe(demo.fund.balanceAfter)
    expect(s.fund.paid && s.fund.note).toBe(true)
    expect(s.fund.approved).toBe(demo.fund.approved)
    expect(s.exp.done).toBe(true)
    expect(s.exp.rowsOk).toBe(demo.export.rows.length)
  })

  it('the data agrees with itself: balance before minus the payment is the balance after, in whole steps', () => {
    const f = demo.fund
    expect(f.balanceBefore - f.payment).toBe(f.balanceAfter)
    expect(f.payment % f.steps).toBe(0)
    expect(f.approved).toBeLessThanOrEqual(f.signers.length)
    expect(demo.decide.dots.filter(Boolean)).toHaveLength(demo.decide.agree + demo.decide.aside + demo.decide.block)
  })

  it('formats amounts as a dollar sign and en-US grouping', () => {
    expect(formatUsd(10600)).toBe('$10,600')
    expect(formatUsd(1800)).toBe('$1,800')
    expect(formatUsd(150)).toBe('$150')
  })

  it('the text alternative names the community on screen and follows every change', () => {
    const { d } = make()
    expect(d.heroAlt()).toContain(ex[0]!.name)
    expect(d.heroAlt()).toContain(ex[0]!.q)
    expect(d.heroAlt()).toContain(ex[0]!.a)
    expect(d.heroAlt()).toContain(ex[0]!.cite)
    expect(d.heroAlt()).toContain(ex[0]!.p[1]!)
    d.mount()
    d.selectExample(2)
    expect(d.heroAlt()).toContain(ex[2]!.name)
    expect(d.heroAlt()).not.toContain(ex[0]!.name)
    d.unmount()
  })
})

describe('the hero', () => {
  it('stays on example 1 for 4.2 s, then plays example 2 and ends on its finished state', async () => {
    const { d } = make()
    d.mount()
    await vi.advanceTimersByTimeAsync(4199)
    expect(d.state.hero.index).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(d.state.hero.index).toBe(1)
    expect(d.state.hero.qOn).toBe(false)
    expect(d.heroAlt()).toContain(ex[1]!.name)
    // typing 26 ms a letter after 500 ms: a letter lands at 500, 526, 552, 578
    await vi.advanceTimersByTimeAsync(500 + 26 * 3)
    expect(d.state.hero.typing).toBe(true)
    expect(d.state.hero.typed).toBe(ex[1]!.q.slice(0, 4))
    await vi.advanceTimersByTimeAsync(5000)
    expect(d.state.hero.citeOn).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    const reduced = make(true)
    reduced.d.mount()
    reduced.d.selectExample(1)
    expect(snap(d).hero).toEqual(snap(reduced.d).hero)
    d.unmount()
  })

  it('goes round: after the hold it plays the next example, and after the last it returns to the first', async () => {
    const { d } = make()
    d.mount()
    const seen: number[] = []
    for (let t = 0; t < 90_000; t += 500) {
      await vi.advanceTimersByTimeAsync(500)
      if (seen[seen.length - 1] !== d.state.hero.index) seen.push(d.state.hero.index)
    }
    expect(seen.slice(0, 6)).toEqual([0, 1, 2, 3, 0, 1])
    d.unmount()
  })

  it('a picked example stops the auto-advance', async () => {
    const { d } = make()
    d.mount()
    d.selectExample(3)
    expect(d.state.hero.index).toBe(3)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(d.state.hero.index).toBe(3)
    expect(d.state.hero.paperLit).toBe(true)
    d.unmount()
  })

  it('every example ends on the same state as the reduced-motion page shows for it', async () => {
    for (let i = 0; i < ex.length; i++) {
      const played = make()
      played.d.mount()
      played.d.selectExample(i)
      await vi.advanceTimersByTimeAsync(9000)
      const reduced = make(true)
      reduced.d.mount()
      reduced.d.selectExample(i)
      expect(snap(played.d).hero, ex[i]!.name).toEqual(snap(reduced.d).hero)
      expect(reduced.d.state.hero.typing).toBe(false)
      played.d.unmount()
      reduced.d.unmount()
    }
  })

  it('Pause during typing holds the letters; Play carries on from the same letter', async () => {
    const { d } = make()
    d.mount()
    d.selectExample(0)
    await vi.advanceTimersByTimeAsync(500 + 26 * 6)
    const typed = d.state.hero.typed
    expect(typed.length).toBeGreaterThan(2)
    d.togglePause()
    expect(d.state.paused).toBe(true)
    expect(d.pauseLabel()).toBe('Play')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(d.state.hero.typed).toBe(typed)
    d.togglePause()
    expect(d.pauseLabel()).toBe('Pause')
    await vi.advanceTimersByTimeAsync(26 * 3 + 1)
    expect(d.state.hero.typed.length).toBeGreaterThan(typed.length)
    expect(ex[0]!.q.startsWith(d.state.hero.typed)).toBe(true)
    d.unmount()
  })

  it('picking an example while paused plays it', async () => {
    const { d } = make()
    d.mount()
    d.togglePause()
    d.selectExample(2)
    expect(d.state.paused).toBe(false)
    await vi.advanceTimersByTimeAsync(600)
    expect(d.state.hero.index).toBe(2)
    expect(d.state.hero.typing).toBe(true)
    d.unmount()
  })
})

describe('the three acts and the chips', () => {
  it('each act plays when it is fully in view and ends on its finished state', async () => {
    const { d, els } = make()
    const finished = snap(d)
    d.mount()
    const io = FakeObserver.last!
    expect(io.opts?.threshold).toBe(1)

    io.show(els.decide)
    expect(d.state.decide.done).toBe(false)
    expect(d.state.decide.agree).toBe(0)
    // a dot lands every 280 ms from 700 ms, and counts as it lands (the first two are agrees)
    await vi.advanceTimersByTimeAsync(700 + 280 - 1)
    expect(d.state.decide.agree).toBe(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(d.state.decide.agree).toBe(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(snap(d).decide).toEqual(finished.decide)

    io.show(els.fund)
    expect(d.state.fund.balance).toBe(demo.fund.balanceBefore)
    expect(d.state.fund.paid).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(snap(d).fund).toEqual(finished.fund)

    io.show(els.export)
    expect(d.state.exp.done).toBe(false)
    expect(d.state.exp.rowsOk).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(snap(d).exp).toEqual(finished.exp)
    d.unmount()
  })

  it('Pause during the fund count-down holds the balance; Play finishes it', async () => {
    const { d, els } = make()
    d.mount()
    FakeObserver.last!.show(els.fund)
    await vi.advanceTimersByTimeAsync(900 + 900 + 600 + 45 * 4 + 1)
    const mid = d.state.fund.balance
    expect(mid).toBeLessThan(demo.fund.balanceBefore)
    expect(mid).toBeGreaterThan(demo.fund.balanceAfter)
    d.togglePause()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(d.state.fund.balance).toBe(mid)
    d.togglePause()
    await vi.advanceTimersByTimeAsync(2000)
    expect(d.state.fund.balance).toBe(demo.fund.balanceAfter)
    expect(d.state.fund.note).toBe(true)
    d.unmount()
  })

  it('Pause during the chip tidy waits; Play tidies them', async () => {
    const { d, els } = make()
    d.mount()
    expect(d.state.chipsTidy).toBe(false)
    FakeObserver.last!.show(els.chips)
    await vi.advanceTimersByTimeAsync(200)
    d.togglePause()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(d.state.chipsTidy).toBe(false)
    d.togglePause()
    await vi.advanceTimersByTimeAsync(299)
    expect(d.state.chipsTidy).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(d.state.chipsTidy).toBe(true)
    d.unmount()
  })

  it('Play again restarts an act, and also un-pauses', async () => {
    const { d } = make()
    d.mount()
    d.togglePause()
    d.play('decide')
    expect(d.state.paused).toBe(false)
    expect(d.state.decide.done).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(d.state.decide.done).toBe(true)
    d.unmount()
  })

  it('an act that scrolls into view while paused waits, and starts when the page is played', async () => {
    const { d, els } = make()
    const finished = snap(d)
    d.mount()
    d.togglePause()
    FakeObserver.last!.show(els.fund)
    FakeObserver.last!.show(els.decide)
    // nothing has been reset: the fund still reads its finished figure, the decision its finished count
    expect(snap(d).fund).toEqual(finished.fund)
    expect(snap(d).decide).toEqual(finished.decide)
    expect(d.state.fund.balance).toBe(demo.fund.balanceAfter)
    expect(d.state.fund.paid).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(snap(d).fund).toEqual(finished.fund)
    expect(snap(d).decide).toEqual(finished.decide)
    d.togglePause()
    // now they start
    expect(d.state.fund.balance).toBe(demo.fund.balanceBefore)
    expect(d.state.fund.paid).toBe(false)
    expect(d.state.decide.done).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(snap(d).fund).toEqual(finished.fund)
    expect(snap(d).decide).toEqual(finished.decide)
    d.unmount()
  })

  it('an act that waited through a pause starts once, not twice, when Play again is pressed', async () => {
    const { d, els } = make()
    const finished = snap(d)
    d.mount()
    d.togglePause()
    FakeObserver.last!.show(els.fund)
    d.play('fund')
    expect(d.state.paused).toBe(false)
    expect(d.state.fund.paid).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(snap(d).fund).toEqual(finished.fund)
    d.unmount()
  })

  it('an act that waited through a pause is dropped by unmount and by reduced motion', async () => {
    const { d, els, mql } = make()
    const finished = snap(d)
    d.mount()
    d.togglePause()
    FakeObserver.last!.show(els.fund)
    mql.fire(true)
    expect(d.state.paused).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(snap(d).fund).toEqual(finished.fund)
    d.unmount()
  })

  it('the cursor waking a ring node does nothing while paused', () => {
    const { d } = make()
    d.mount()
    const before = [...d.state.hero.near]
    d.togglePause()
    d.wake(1)
    expect(d.state.hero.near).toEqual(before)
    d.togglePause()
    d.wake(1)
    expect(d.state.hero.near.map(Boolean)).toEqual(before.map((_, k) => k === 1))
    d.unmount()
  })

  it('an act is not started by a sliver of it: a ratio below 1 neither plays nor stops the watching', async () => {
    const { d, els } = make()
    const finished = snap(d)
    d.mount()
    const io = FakeObserver.last!
    io.show(els.fund, 0.1)
    expect(snap(d).fund).toEqual(finished.fund)
    expect(io.seen.has(els.fund)).toBe(true)
    // rounding: 0.99 counts as fully in view
    io.show(els.fund, 0.99)
    expect(d.state.fund.paid).toBe(false)
    expect(io.seen.has(els.fund)).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(snap(d).fund).toEqual(finished.fund)
    d.unmount()
  })

  it('an act queued before mount is observed once the controller is mounted', () => {
    const { d, els } = make()
    d.mount()
    expect([...FakeObserver.last!.seen]).toEqual(expect.arrayContaining([els.chips, els.decide, els.fund, els.export]))
    d.unmount()
  })
})

describe('reduced motion', () => {
  it('at mount: no timers, no observer, finished states, chips tidy', async () => {
    const { d } = make(true)
    d.mount()
    expect(vi.getTimerCount()).toBe(0)
    expect(FakeObserver.last).toBeNull()
    expect(d.state.reducedMotion).toBe(true)
    expect(d.state.chipsTidy).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(d.state.hero.index).toBe(0)
    d.selectExample(3)
    expect(d.state.hero.index).toBe(3)
    expect(d.state.hero.typing).toBe(false)
    expect(d.state.hero.paperLit).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    d.play('fund')
    expect(vi.getTimerCount()).toBe(0)
    d.unmount()
  })

  it('switched on mid-run: everything jumps to the finished states and every timer is cancelled', async () => {
    const { d, mql, els } = make()
    const finished = snap(d)
    d.mount()
    FakeObserver.last!.show(els.decide)
    FakeObserver.last!.show(els.fund)
    FakeObserver.last!.show(els.chips)
    d.selectExample(0)
    await vi.advanceTimersByTimeAsync(800)
    expect(d.state.hero.typing).toBe(true)
    expect(d.state.decide.done).toBe(false)
    mql.fire(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(d.state.reducedMotion).toBe(true)
    expect(snap(d)).toEqual({ ...finished, chipsTidy: true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(snap(d)).toEqual({ ...finished, chipsTidy: true })
    d.unmount()
  })

  it('switched on while paused clears the pause and still finishes', async () => {
    const { d, mql } = make()
    d.mount()
    d.selectExample(1)
    await vi.advanceTimersByTimeAsync(700)
    d.togglePause()
    mql.fire(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(d.state.hero.typing).toBe(false)
    expect(d.state.hero.index).toBe(1)
    d.unmount()
  })

  it('switched off again: the hero picks up its autoplay', async () => {
    const { d, mql } = make(true)
    d.mount()
    mql.fire(false)
    expect(d.state.reducedMotion).toBe(false)
    await vi.advanceTimersByTimeAsync(4300)
    expect(d.state.hero.index).toBe(1)
    d.unmount()
  })
})

describe('unmount', () => {
  it('leaves no timer, no media-query listener and a disconnected observer', async () => {
    const { d, mql, els } = make()
    d.mount()
    expect(mql.count).toBe(1)
    FakeObserver.last!.show(els.decide)
    FakeObserver.last!.show(els.fund)
    FakeObserver.last!.show(els.chips)
    d.selectExample(2)
    await vi.advanceTimersByTimeAsync(1500)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    d.unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(mql.count).toBe(0)
    expect(FakeObserver.last!.disconnected).toBe(true)
    expect(d.state.mounted).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('unmounted while paused leaves nothing waiting either', async () => {
    const { d } = make()
    d.mount()
    d.selectExample(2)
    await vi.advanceTimersByTimeAsync(700)
    d.togglePause()
    d.unmount()
    expect(vi.getTimerCount()).toBe(0)
    d.togglePause()
    expect(vi.getTimerCount()).toBe(0)
  })
})

<script setup lang="ts">
// The home page's first screen. Every demo string comes from app/data/home-demo.json through the one controller
// (useHomeDemos), which index.vue provides. The window is a picture: it is hidden from the
// accessibility tree, and a plain-text copy of its finished state sits beside it (`home-alt`).
// This section carries the page's one launching-soon statement, marked for the claims check.
import { ref } from 'vue'
import { injectHomeDemos } from '~/composables/useHomeDemos'

const d = injectHomeDemos()
const s = d.state.hero
const ex = d.data.hero.examples
const hero = d.data.hero

// Six document nodes on the rings (angle in degrees, radius in viewBox units).
const nodes = ([[-118, 250], [-64, 250], [-22, 290], [14, 290], [100, 250], [118, 250]] as const).map(([deg, r]) => {
  const t = deg * Math.PI / 180
  const round = (v: number) => Math.round(v * 100) / 100
  const x = round(300 + r * Math.cos(t))
  const y = round(300 + r * Math.sin(t))
  const right = Math.cos(t) > 0
  return {
    x,
    y,
    tx: x + (right ? 12 : -12),
    ty: y + 4,
    anchor: right ? 'start' : 'end',
    lx: round(300 + (x - 300) * 0.42),
    ly: round(300 + (y - 300) * 0.42)
  }
})

const rings = ref<SVGElement | null>(null)

/** The cursor wakes the nearest document node. */
function onMove(e: PointerEvent) {
  const el = rings.value
  if (!el) return
  const r = el.getBoundingClientRect()
  if (!r.width) return
  const k = 600 / r.width
  const x = (e.clientX - r.left) * k
  const y = (e.clientY - r.top) * k
  let best = -1
  let bd = 95 * 95
  nodes.forEach((n, j) => {
    const dist = (n.x - x) ** 2 + (n.y - y) ** 2
    if (dist < bd) {
      bd = dist
      best = j
    }
  })
  d.wake(best)
}

const statusText = () => (s.status === 'reading' ? hero.statusReading : s.status === 'read' ? hero.statusRead : '')
</script>

<template>
  <section id="think" class="home-hero home-dark dark">
    <div class="home-wrap home-hero-grid">
      <div class="home-copy">
        <p class="home-soon" data-prelaunch>
          <b>Launching soon.</b> <a href="#early-access" class="home-link">Get early access</a>.
        </p>
        <h1 class="home-h1">
          Where your community thinks, decides and funds <span class="home-grad">together.</span>
        </h1>
        <p class="home-sub">
          A shared memory with an assistant that knows your group's history, a shared fund, and a fair way to decide how it's spent. Your community owns it, not a platform.
        </p>
        <div class="home-row">
          <UButton to="#early-access" label="Get early access" size="xl" />
          <UButton to="#together" label="See how it works" size="xl" variant="outline" color="neutral" />
        </div>
        <div class="home-try">
          <p class="home-tag"><span class="home-pill">In the first pilots</span></p>
          <div class="home-who home-needs-js" role="group" aria-label="Example community">
            <span>Show me a</span>
            <button
              v-for="(c, i) in ex"
              :key="c.switcher"
              type="button"
              :aria-pressed="i === s.index"
              @click="d.selectExample(i)"
            >{{ c.switcher }}</button>
          </div>
          <p class="home-under">
            <span>Example from a demo library. Every answer shows the page it came from.</span>
            <button type="button" class="home-plain home-pause home-needs-js home-motion-only" @click="d.togglePause()">{{ d.pauseLabel() }}</button>
          </p>
        </div>
      </div>

      <div class="home-show" @pointermove="onMove">
        <div class="home-glow home-glow-t" />
        <div class="home-glow home-glow-a" />
        <p class="home-alt">{{ d.heroAlt() }}</p>
        <div class="home-hold" aria-hidden="true">
          <svg ref="rings" class="home-rings" viewBox="0 0 600 600" aria-hidden="true">
            <circle class="home-ring" cx="300" cy="300" r="170" />
            <circle class="home-ring" cx="300" cy="300" r="250" />
            <circle class="home-ring home-ring-o" cx="300" cy="300" r="290" />
            <g>
              <line
                v-for="(n, j) in nodes"
                :key="'l' + j"
                class="home-thread-line"
                :class="{ on: s.rail[j]!.read || s.rail[j]!.hit, hit: s.rail[j]!.hit }"
                :x1="n.x"
                :y1="n.y"
                :x2="n.lx"
                :y2="n.ly"
              />
            </g>
            <g>
              <g
                v-for="(n, j) in nodes"
                :key="'n' + j"
                class="home-node"
                :class="{ near: s.near[j], read: s.rail[j]!.read, hit: s.rail[j]!.hit }"
              >
                <circle :cx="n.x" :cy="n.y" r="5" />
                <text :x="n.tx" :y="n.ty" :text-anchor="n.anchor">{{ j === 2 || j === 3 ? '' : ex[s.index]!.docs[j] }}</text>
              </g>
            </g>
          </svg>

          <div class="home-stage home-light">
            <div class="home-st-head">
              <svg viewBox="0 0 48 48" width="20" height="20">
                <circle cx="24" cy="24" r="15" fill="none" stroke="currentColor" stroke-width="3" />
                <circle cx="24" cy="9" r="5" fill="currentColor" />
                <circle cx="11" cy="31.5" r="5" fill="currentColor" />
                <circle cx="37" cy="31.5" r="5" fill="currentColor" />
                <circle cx="24" cy="24" r="4.5" style="fill: var(--home-hit)" />
              </svg>
              <span class="home-stk">
                <b v-for="(c, i) in ex" :key="c.name" :class="{ 'is-cur': i === s.index }">{{ c.name }}</b>
              </span>
              <span class="home-tabs"><span>Home</span><span class="on">Library</span><span>Decisions</span><span>Fund</span></span>
            </div>
            <div class="home-st-body">
              <ul class="home-rail">
                <li
                  v-for="(doc, j) in ex[s.index]!.docs"
                  :key="j"
                  :class="{ scan: s.rail[j]!.scan, read: s.rail[j]!.read, hit: s.rail[j]!.hit }"
                ><i></i>{{ doc }}</li>
              </ul>
              <div class="home-thread">
                <div class="home-q-stk home-stk">
                  <p
                    v-for="(c, i) in ex"
                    :key="c.name"
                    class="home-q"
                    :class="{ 'is-cur': i === s.index, off: !s.qOn }"
                  >{{ c.q }}</p>
                </div>
                <div class="home-ans">
                  <span class="home-status">{{ statusText() }}</span>
                  <div class="home-ans-stk home-stk">
                    <p v-for="(c, i) in ex" :key="c.name" class="home-ans-p" :class="{ 'is-cur': i === s.index }">
                      <span v-for="(w, k) in c.a.split(' ')" :key="k" class="w" :class="{ in: k < s.words }">{{ w + ' ' }}</span>
                    </p>
                  </div>
                  <div class="home-cite-stk home-stk">
                    <span
                      v-for="(c, i) in ex"
                      :key="c.name"
                      class="home-cite"
                      :class="{ 'is-cur': i === s.index, off: !s.citeOn }"
                    >{{ c.cite }}</span>
                  </div>
                </div>
                <div class="home-composer">
                  <span class="home-typed" :class="{ ph: !s.typing }">{{ s.typing ? s.typed : hero.composerPlaceholder }}</span>
                  <span class="home-caret" :class="{ 'is-off': !s.caret }"></span>
                  <span class="home-key">Enter</span>
                </div>
              </div>
            </div>
          </div>

          <aside class="home-paper" :class="{ off: !s.paperOn, lit: s.paperLit }">
            <span class="home-paper-k">
              <span class="home-stk">
                <span v-for="(c, i) in ex" :key="c.name" :class="{ 'is-cur': i === s.index }">{{ c.k }}</span>
              </span>
              <span class="n">[1]</span>
            </span>
            <div class="home-paper-stk home-stk">
              <p v-for="(c, i) in ex" :key="c.name" class="home-paper-p" :class="{ 'is-cur': i === s.index }">{{ c.p[0] }}<mark>{{ c.p[1] }}</mark>{{ c.p[2] }}</p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  </section>
</template>

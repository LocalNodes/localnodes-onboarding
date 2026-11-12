<script setup lang="ts">
// Act one, "Decides". The server renders the finished decision; the controller
// replays it when the window scrolls into view and from "Play again". The window is a picture
// (hidden from the accessibility tree); the sentence in `home-alt` is its finished state, built
// from the same numbers, so the two cannot disagree.
import { computed, onMounted, ref } from 'vue'
import { injectHomeDemos } from '~/composables/useHomeDemos'

const d = injectHomeDemos()
const s = d.state.decide
const dec = d.data.decide
const dots = ref<HTMLElement | null>(null)

const alt = computed(() => {
  const responded = dec.agree + dec.aside + dec.block
  return `Planned example: repair the back steps. Agreed: ${dec.agree} agree, ${dec.aside} stand aside, ${dec.block} block, ${responded} of ${dec.dots.length} responded.`
})

onMounted(() => {
  if (dots.value) d.observe('decide', dots.value)
})
</script>

<template>
  <section id="decide" class="home-act home-band-tint">
    <div class="home-wrap">
      <div class="home-words">
        <span class="home-mono">Decides</span>
        <h2 class="home-h2">Decide in the open, with everyone who has a say.</h2>
        <p>Anyone can put a proposal to the group. Each member agrees, stands aside or blocks, and the result is kept with the count and the date.</p>
        <ul>
          <li>One person, one response</li>
          <li>A clear closing date on every proposal</li>
          <li>The record stays, so next year's members can ask what was decided</li>
        </ul>
        <button type="button" class="home-plain home-again home-needs-js home-motion-only" @click="d.play('decide')">Play again</button>
      </div>
      <p class="home-alt">{{ alt }}</p>
      <div class="home-hold" aria-hidden="true">
        <div class="home-stage">
          <div class="home-st-head"><b>Willow House</b><span class="home-tabs"><span>Home</span><span>Library</span><span class="on">Decisions</span><span>Fund</span></span></div>
          <div class="home-pad">
            <span class="home-pill-wrap home-stk">
              <span class="home-pill" :class="{ 'is-cur': !s.done }">{{ dec.pillOpen }}</span>
              <span class="home-pill done" :class="{ 'is-cur': s.done }">{{ dec.pillDone }}</span>
            </span>
            <h3>Repair the back steps</h3>
            <p class="home-quiet">Pay for the lowest of three quotes from the repair fund.</p>
            <div ref="dots" class="home-dots">
              <span v-for="(k, i) in s.dots" :key="i" :class="[k, { pop: s.pop === i }]"></span>
            </div>
            <dl class="home-tally">
              <div><dt>Agree</dt><dd>{{ s.agree }}</dd></div>
              <div><dt>Stand aside</dt><dd>{{ s.aside }}</dd></div>
              <div><dt>Block</dt><dd>{{ s.block }}</dd></div>
            </dl>
            <p class="home-fine">This records the decision. Paying for it is a separate step, below.</p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

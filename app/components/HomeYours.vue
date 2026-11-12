<script setup lang="ts">
// Act three, "Yours": open source and the export button. The window is a
// picture of the export screen (hidden from the accessibility tree); `home-alt` is its finished
// state in words. The server renders the finished state; the controller replays it.
import { computed, onMounted, ref } from 'vue'
import { injectHomeDemos } from '~/composables/useHomeDemos'

const d = injectHomeDemos()
const e = d.state.exp
const exp = d.data.export
const rows = ref<HTMLElement | null>(null)

const alt = computed(() => {
  const list = exp.rows.map(r => `${r.label} (${r.note})`).join(', ')
  return `Planned example of the export screen for Willow House. Status: ${exp.pillReady}. Included: ${list}. File: ${exp.file}.`
})

onMounted(() => {
  if (rows.value) d.observe('export', rows.value)
})
</script>

<template>
  <section id="yours" class="home-act home-band-tint">
    <div class="home-wrap">
      <div class="home-words">
        <span class="home-mono">Yours</span>
        <h2 class="home-h2">It's your site. Take it with you.</h2>
        <p>LocalNodes is open source (GPL and AGPL). Run it with us or on your own server. If you ever want to move, one button will give you everything your community has put here.</p>
        <ul>
          <li>Your pages, files, members and settings in one download</li>
          <li>A step-by-step guide to setting it up somewhere else</li>
          <li>The same software anyone can install for a new community</li>
        </ul>
        <button type="button" class="home-plain home-again home-needs-js home-motion-only" @click="d.play('export')">Play again</button>
      </div>
      <p class="home-alt">{{ alt }}</p>
      <div class="home-hold" aria-hidden="true">
        <div class="home-stage">
          <div class="home-st-head"><b>Willow House</b><span class="home-tabs"><span class="on">Site settings</span></span></div>
          <div class="home-pad">
            <span class="home-pill-wrap home-stk">
              <span class="home-pill" :class="{ 'is-cur': !e.done }">{{ exp.pillLocked }}</span>
              <span class="home-pill done" :class="{ 'is-cur': e.done }">{{ exp.pillReady }}</span>
            </span>
            <h3>Export this site</h3>
            <p class="home-quiet">One download with everything here, and a guide to setting it up somewhere else.</p>
            <ul ref="rows" class="home-xrows">
              <li v-for="(r, i) in exp.rows" :key="r.label" :class="{ ok: i < e.rowsOk }"><i></i>{{ r.label }}<small>{{ r.note }}</small></li>
            </ul>
            <div class="home-xfoot">
              <span class="home-xfile">{{ e.done ? exp.file : '' }}</span>
              <span class="home-xbtn">
                <span class="home-stk">
                  <span :class="{ 'is-cur': !e.busy && !e.done }">{{ exp.buttonIdle }}</span>
                  <span :class="{ 'is-cur': e.busy && !e.done }">{{ exp.buttonBusy }}</span>
                  <span :class="{ 'is-cur': e.done }">{{ exp.buttonDone }}</span>
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

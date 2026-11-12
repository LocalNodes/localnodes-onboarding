<script setup lang="ts">
// "Six places": the line, the six chips, the line about the money ("often", because not
// every group keeps its money that way) and a closing line that turns to the example windows
// below. The chips sit scattered until the closing line is in view, then tidy up, so they
// settle as the reader reaches "in one place". Nothing else on this page says this. The
// server renders them scattered; the controller tidies them when it sees the closing line.
// The strip is a dark band, so it scopes the dark colour context the way the hero does.
import { onMounted, ref } from 'vue'
import { injectHomeDemos } from '~/composables/useHomeDemos'

const d = injectHomeDemos()
const turn = ref<HTMLElement | null>(null)

onMounted(() => {
  if (turn.value) d.observe('chips', turn.value)
})
</script>

<template>
  <section class="home-scatter home-dark dark">
    <div class="home-wrap">
      <p>Right now, what your group knows lives in six places and one person's memory.</p>
      <ul class="home-chips" :class="{ tidy: d.state.chipsTidy }">
        <li>group chat</li>
        <li>shared drive</li>
        <li>email threads</li>
        <li>a paper binder</li>
        <li>a spreadsheet</li>
        <li>last year's notes</li>
      </ul>
      <p>And the money often sits in one person's bank account.</p>
      <p ref="turn">Here's what it looks like in one place.</p>
    </div>
  </section>
</template>

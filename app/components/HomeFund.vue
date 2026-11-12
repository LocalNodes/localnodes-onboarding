<script setup lang="ts">
// Act two, "Funds". The dollar figures in the window are scripted example
// data from app/data/home-demo.json, not real money: each one is a slot alone in its own box
// (data-demo-amount in data-demo-amount-box), which is the only place the claims check lets a
// price-shaped figure through, and only in this section. The finished state is what the server
// renders; a plain-text list of it sits outside the hidden window for screen readers.
import { onMounted, ref } from 'vue'
import { injectHomeDemos } from '~/composables/useHomeDemos'

const d = injectHomeDemos()
const f = d.state.fund
const fund = d.data.fund
const signers = ref<HTMLElement | null>(null)

onMounted(() => {
  if (signers.value) d.observe('fund', signers.value)
})
</script>

<template>
  <section id="fund" class="home-act flip home-band-light">
    <div class="home-wrap">
      <div class="home-words">
        <span class="home-mono">Funds</span>
        <h2 class="home-h2">A fund the group controls, and can see.</h2>
        <p class="home-tag"><span class="home-pill">Coming later. Off for the first pilots.</span></p>
        <p>The money moves only when the approvers your group chose sign off. Every payment shows who approved it and what it was for.</p>
        <ul>
          <li>No single person holds the purse</li>
          <li>Optional: turn the fund on when your group is ready</li>
        </ul>
        <button type="button" class="home-plain home-again home-needs-js home-motion-only" @click="d.play('fund')">Play again</button>
      </div>
      <dl class="home-alt">
        <div>
          <dt>Planned example: back steps repair paid to Marlow Carpentry, the lowest quote</dt>
          <dd data-demo-amount-box><span data-demo-amount="fund.payment">{{ d.formatUsd(fund.payment) }}</span></dd>
        </div>
        <div>
          <dt>Example repair fund balance after the payment</dt>
          <dd data-demo-amount-box><span data-demo-amount="fund.balanceAfter">{{ d.formatUsd(fund.balanceAfter) }}</span></dd>
        </div>
        <div>
          <dt>Approvals</dt>
          <dd>{{ fund.pillPaid }}. {{ fund.note }}.</dd>
        </div>
      </dl>
      <div class="home-hold home-holdnote home-note" aria-hidden="true">
        <div class="home-stage">
          <div class="home-st-head"><b>Willow House</b><span class="home-tabs"><span>Home</span><span>Library</span><span>Decisions</span><span class="on">Fund</span></span></div>
          <div class="home-pad">
            <div class="home-bal">
              <span class="home-quiet">Repair fund balance</span>
              <div class="home-bal-amount" data-demo-amount-box><span data-demo-amount="fund.balanceAfter">{{ d.formatUsd(f.balance) }}</span></div>
            </div>
            <div class="home-pay">
              <div><b>Back steps repair</b><small>To Marlow Carpentry, the lowest quote</small></div>
              <div class="home-amt" data-demo-amount-box><span data-demo-amount="fund.payment">{{ d.formatUsd(fund.payment) }}</span></div>
            </div>
            <div ref="signers" class="home-signers">
              <span v-for="(who, i) in fund.signers" :key="who" class="s" :class="{ ok: i < f.approved }">{{ who }}</span>
              <span class="home-need home-stk">
                <span v-for="(text, i) in fund.need" :key="text" :class="{ 'is-cur': i === f.approved }">{{ text }}</span>
              </span>
            </div>
            <span class="home-pill-wrap home-stk">
              <span class="home-pill" :class="{ 'is-cur': !f.paid }">{{ fund.pillWaiting }}</span>
              <span class="home-pill done" :class="{ 'is-cur': f.paid }">{{ fund.pillPaid }}</span>
            </span>
          </div>
        </div>
        <span class="home-sticky" :class="{ off: !f.note }">{{ fund.note }}</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
// How it works (fresh3 LANDING.md 3.7, approved by Tom 2026-11-06). No price
// (D-16; PR #5 hid it): the price shows at checkout, before payment.
const steps = [
  { title: 'Name your community', body: 'Pick a name and an address: yourname.localnodes.xyz.' },
  { title: 'Check out', body: 'Pick your plan at checkout. You see the price before you pay.' },
  { title: 'Bring in your documents', body: 'Your site is usually ready in about four minutes. Then add your group\'s files and invite your members.' }
]
</script>

<template>
  <section class="bg-default">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-20 flex flex-col gap-6">
      <h2 class="text-[28px] leading-tight font-semibold text-highlighted">
        How it works
      </h2>
      <ol class="grid gap-6 md:grid-cols-3">
        <li v-for="(step, i) in steps" :key="step.title" class="flex flex-col gap-2">
          <span class="size-10 rounded-full bg-primary text-inverted inline-flex items-center justify-center font-semibold" aria-hidden="true">{{ i + 1 }}</span>
          <h3 class="text-xl font-semibold text-highlighted">
            <span class="sr-only">Step {{ i + 1 }}: </span>{{ step.title }}
          </h3>
          <p class="text-muted">
            {{ step.body }}
          </p>
        </li>
      </ol>
    </div>
  </section>
</template>

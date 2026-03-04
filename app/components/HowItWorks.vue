<template>
  <UPageSection
    id="how-it-works"
    headline="Simple setup"
    title="Up and running in minutes"
    description="No servers to manage. No technical skills required. Just three simple steps."
  >
    <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
      <div
        v-for="step in steps"
        :key="step.number"
        class="relative text-center p-6 rounded-xl border border-zinc-800 bg-zinc-900/50"
      >
        <!-- Step number -->
        <div class="inline-flex items-center justify-center w-10 h-10 rounded-full bg-primary/10 text-primary font-bold text-lg mb-4">
          {{ step.number }}
        </div>

        <!-- Icon -->
        <div class="flex justify-center mb-3">
          <UIcon :name="step.icon" class="text-3xl text-primary" />
        </div>

        <!-- Content -->
        <h3 class="text-lg font-semibold text-zinc-100 mb-2">
          {{ step.title }}
        </h3>
        <p class="text-sm text-zinc-400 leading-relaxed">
          {{ step.description }}
        </p>
      </div>
    </div>
  </UPageSection>
</template>

<script setup lang="ts">
const steps = [
  {
    number: 1,
    icon: 'i-lucide-pen-line',
    title: 'Name your community',
    description: 'Choose a subdomain that reflects your community\'s identity. It becomes yourname.localnodes.xyz -- your own corner of the web.'
  },
  {
    number: 2,
    icon: 'i-lucide-credit-card',
    title: 'Subscribe',
    description: '$29/month. Everything included -- hosting, AI, updates, and support. No hidden costs, no surprises.'
  },
  {
    number: 3,
    icon: 'i-lucide-sprout',
    title: 'Start growing',
    description: 'Your knowledge garden is ready in minutes. Invite your community, start conversations, and watch your collective wisdom grow.'
  }
]
</script>

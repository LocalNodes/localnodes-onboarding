<template>
  <UPageSection
    id="how-it-works"
    headline="Simple setup"
    title="Up and running in minutes"
    description="No servers to manage. No technical skills required. Just three simple steps."
  >
    <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
      <div
        v-for="(step, index) in steps"
        :key="step.number"
        v-motion
        :initial="{ opacity: 0, y: 40 }"
        :visibleOnce="{ opacity: 1, y: 0, transition: { duration: 800, delay: index * 200, type: 'spring', stiffness: 50 } }"
        class="relative text-center p-8 rounded-2xl border border-zinc-800/60 bg-zinc-900/40 backdrop-blur-xl hover:border-primary/40 hover:-translate-y-1 transition-all duration-500 group shadow-lg hover:shadow-primary/10"
      >
        <!-- Step number -->
        <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 text-primary font-bold text-xl mb-6 ring-1 ring-primary/20 group-hover:scale-110 group-hover:bg-primary/20 transition-all duration-300">
          {{ step.number }}
        </div>

        <!-- Icon -->
        <div class="flex justify-center mb-5">
          <UIcon :name="step.icon" class="text-4xl text-primary/80 group-hover:text-primary transition-colors duration-300" />
        </div>

        <!-- Content -->
        <h3 class="text-xl font-semibold text-zinc-100 mb-3 group-hover:text-white transition-colors">
          {{ step.title }}
        </h3>
        <p class="text-sm text-zinc-400 leading-relaxed font-light">
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

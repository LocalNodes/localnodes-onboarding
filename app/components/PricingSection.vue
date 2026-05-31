<template>
  <UPageSection
    id="pricing"
    headline="Simple pricing"
    title="Open source. Self-host or let us handle it."
    description="LocalNodes is fully open source. Run it yourself for free, or let us handle the infrastructure."
  >
    <div class="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
      <!-- Self-Host card (left) -->
      <div 
        v-motion
        :initial="{ opacity: 0, x: -40 }"
        :visibleOnce="{ opacity: 1, x: 0, transition: { duration: 800, type: 'spring', stiffness: 45 } }"
      >
        <UPricingPlan
          title="Self-Host"
          price="Free"
          billing-cycle="forever"
          description="Run your own instance. Full source code, your infrastructure, total control."
          :features="selfHostFeatures"
          :button="{
            label: 'View on GitHub',
            to: 'https://github.com/LocalNodes/os-knowledge-garden',
            target: '_blank',
            color: 'neutral' as const,
            size: 'xl' as const,
            variant: 'outline' as const
          }"
          variant="subtle"
          class="h-full border border-zinc-800/60 bg-zinc-900/30 backdrop-blur-md hover:border-zinc-700 hover:bg-zinc-800/20 transition-all duration-300 rounded-3xl group"
        />
      </div>

      <!-- Managed card (right) -->
      <div 
        v-motion
        :initial="{ opacity: 0, x: 40 }"
        :visibleOnce="{ opacity: 1, x: 0, transition: { duration: 800, delay: 200, type: 'spring', stiffness: 45 } }"
        class="relative group"
      >
        <div class="absolute -inset-0.5 bg-gradient-to-br from-primary/30 to-amber-400/20 rounded-3xl blur opacity-40 group-hover:opacity-60 transition duration-500 pointer-events-none" />
        <UPricingPlan
          title="Managed"
          price="$29"
          billing-cycle="/month"
          description="Everything you need to grow your community's collective knowledge"
          :features="managedFeatures"
          :button="{
            label: 'Get Started',
            to: '/onboarding',
            color: 'primary' as const,
            size: 'xl' as const
          }"
          highlight
          variant="subtle"
          class="relative h-full border border-zinc-800/80 bg-zinc-900/80 backdrop-blur-xl rounded-3xl shadow-xl group-hover:shadow-primary/10 transition-shadow duration-300"
        />
      </div>
    </div>

    <p 
      v-motion
      :initial="{ opacity: 0, y: 20 }"
      :visibleOnce="{ opacity: 1, y: 0, transition: { duration: 600, delay: 600 } }"
      class="mt-10 text-center text-sm text-zinc-500 font-light"
    >
      No hidden costs. No per-query fees. No surprises.
    </p>
  </UPageSection>
</template>

<script setup lang="ts">
const selfHostFeatures = [
  { title: 'Full source code on GitHub', icon: 'i-lucide-github' },
  { title: 'Docker Compose deployment', icon: 'i-lucide-container' },
  { title: 'All features included', icon: 'i-lucide-check-circle' },
  { title: 'Community support', icon: 'i-lucide-message-circle' }
]

const managedFeatures = [
  { title: 'AI-powered knowledge assistant', icon: 'i-lucide-brain' },
  { title: 'Groups, events, topics & file library', icon: 'i-lucide-users' },
  { title: 'Hybrid search (keyword + semantic)', icon: 'i-lucide-search' },
  { title: 'Custom subdomain (yourname.localnodes.xyz)', icon: 'i-lucide-globe' },
  { title: 'Hosting, SSL & automatic updates', icon: 'i-lucide-shield-check' },
  { title: 'AI embeddings & processing included', icon: 'i-lucide-sparkles' }
]
</script>

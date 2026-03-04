<template>
  <UPageSection
    id="pricing"
    headline="Simple pricing"
    title="Open source. Self-host or let us handle it."
    description="LocalNodes is fully open source. Run it yourself for free, or let us handle the infrastructure."
  >
    <div class="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
      <!-- Self-Host card (left) -->
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
      />

      <!-- Managed card (right) -->
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
      />
    </div>

    <p class="mt-6 text-center text-sm text-zinc-500">
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

<template>
  <UPageSection
    id="pricing"
    headline="Simple pricing"
    title="One plan. Everything included."
    description="No tiers, no feature gates. Every community gets the full platform."
  >
    <div class="max-w-md mx-auto">
      <UPricingPlan
        price="$29"
        billing-cycle="/month"
        description="Everything you need to grow your community's collective knowledge"
        :features="features"
        :button="{
          label: 'Get Started',
          to: '/onboarding',
          color: 'primary' as const,
          size: 'xl' as const
        }"
        highlight
        variant="subtle"
      />
      <p class="mt-6 text-center text-sm text-zinc-500">
        No hidden costs. No per-query fees. No surprises.
      </p>
    </div>
  </UPageSection>
</template>

<script setup lang="ts">
const features = [
  { title: 'AI-powered knowledge assistant', icon: 'i-lucide-brain' },
  { title: 'Groups, events, topics & file library', icon: 'i-lucide-users' },
  { title: 'Hybrid search (keyword + semantic)', icon: 'i-lucide-search' },
  { title: 'Custom subdomain (yourname.localnodes.xyz)', icon: 'i-lucide-globe' },
  { title: 'Hosting, SSL & automatic updates', icon: 'i-lucide-shield-check' },
  { title: 'AI embeddings & processing included', icon: 'i-lucide-sparkles' }
]
</script>

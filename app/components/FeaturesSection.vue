<template>
  <UPageSection
    id="features"
    headline="Three pillars"
    title="Everything your community needs"
    description="Three foundations, working together, to help your community thrive."
  >
    <!-- Three pillars with equal weight -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-16">
      <div
        v-for="pillar in pillars"
        :key="pillar.title"
        class="relative p-8 rounded-2xl border border-zinc-800 bg-zinc-900/50 hover:border-primary/30 transition-colors"
      >
        <div class="flex items-center justify-center w-14 h-14 rounded-xl bg-primary/10 mb-6">
          <UIcon :name="pillar.icon" class="text-3xl text-primary" />
        </div>
        <h3 class="text-xl font-semibold text-zinc-100 mb-3">
          {{ pillar.title }}
        </h3>
        <p class="text-zinc-400 leading-relaxed">
          {{ pillar.description }}
        </p>
      </div>
    </div>

    <!-- Additional capabilities -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div
        v-for="cap in capabilities"
        :key="cap.title"
        class="flex gap-4 p-5 rounded-xl border border-zinc-800/50 bg-zinc-900/30"
      >
        <div class="flex-shrink-0">
          <UIcon :name="cap.icon" class="text-xl text-secondary" />
        </div>
        <div>
          <h4 class="text-sm font-semibold text-zinc-200 mb-1">
            {{ cap.title }}
          </h4>
          <p class="text-sm text-zinc-500 leading-relaxed">
            {{ cap.description }}
          </p>
        </div>
      </div>
    </div>
  </UPageSection>
</template>

<script setup lang="ts">
const pillars = [
  {
    icon: 'i-lucide-brain',
    title: 'AI-Powered Knowledge Assistant',
    description: 'An AI that actually understands your community\'s context. It reads your events, topics, and conversations -- then helps members find answers, discover connections, and surface insights that would otherwise stay hidden.'
  },
  {
    icon: 'i-lucide-users',
    title: 'Instant Community Platform',
    description: 'Groups, events, topics, file library, and member profiles -- everything a thriving community needs, ready from day one. No plugins to install, no configurations to wrestle with.'
  },
  {
    icon: 'i-lucide-globe',
    title: 'Bioregional Sovereignty',
    description: 'Your community owns its knowledge. Hosted on your subdomain, governed by your values. No platform lock-in, no algorithm deciding what your members see. Your data stays yours.'
  }
]

const capabilities = [
  {
    icon: 'i-lucide-search',
    title: 'Hybrid Search',
    description: 'Keyword and semantic search working together -- find what you mean, not just what you type.'
  },
  {
    icon: 'i-lucide-shield-check',
    title: 'Managed Hosting',
    description: 'SSL, backups, and automatic updates included. We handle the infrastructure so you can focus on your community.'
  },
  {
    icon: 'i-lucide-sparkles',
    title: 'AI Processing Included',
    description: 'Embeddings, summaries, and intelligent search -- all included in your plan. No per-query costs.'
  }
]
</script>

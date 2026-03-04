<template>
  <UPageSection
    id="communities"
    headline="Growing communities"
    title="3 communities already growing"
    description="Real communities using LocalNodes today. Visit them and see for yourself."
  >
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <UCard
        v-for="community in communities"
        :key="community.name"
        class="hover:border-primary/30 transition-colors"
      >
        <template #header>
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <UIcon name="i-lucide-trees" class="text-lg text-primary" />
            </div>
            <h3 class="text-lg font-semibold text-zinc-100">
              {{ community.name }}
            </h3>
          </div>
        </template>

        <p class="text-sm text-zinc-400 leading-relaxed">
          {{ community.description }}
        </p>

        <template #footer>
          <UButton
            :label="`Visit ${community.name}`"
            :to="community.url"
            target="_blank"
            variant="outline"
            size="sm"
            trailing-icon="i-lucide-external-link"
          />
        </template>
      </UCard>
    </div>
  </UPageSection>
</template>

<script setup lang="ts">
const communities = [
  {
    name: 'Cascadia',
    description: 'Bioregional knowledge commons for the Pacific Northwest. Connecting communities across watersheds and ecosystems.',
    url: 'https://cascadia.localnodes.xyz'
  },
  {
    name: 'Boulder',
    description: 'Community knowledge garden for Boulder, Colorado. Local events, neighborhood wisdom, and civic engagement.',
    url: 'https://boulder.localnodes.xyz'
  },
  {
    name: 'Portland',
    description: 'Local knowledge network for Portland, Oregon. Neighborhood organizing, mutual aid, and community resilience.',
    url: 'https://portland.localnodes.xyz'
  }
]
</script>

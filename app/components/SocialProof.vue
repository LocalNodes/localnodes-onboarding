<script setup lang="ts">
// See it in action (fresh3 LANDING.md 3.6 and section 4, approved by Tom
// 2026-11-06). Example groups are examples, never customers; every demo-site
// link says "demo" in its visible text (D-16). No testimonials, community
// list or numbers.
const examples = [
  {
    title: 'A housing co-op',
    today: 'Keeps its bylaws, house rules, minutes and maintenance records in its library; members ask "When was the roof last inspected?" and get the answer with the minutes it came from.',
    next: 'sees its repair fund\'s balance and who approves spending (rung 1); votes on a major repair and carries out the payment once it passes (rung 2).'
  },
  {
    title: 'An online guild',
    today: 'Keeps its handbook, past proposals and project write-ups in one place new members can ask about.',
    next: 'connects the shared account and voting it already uses, nothing redeployed (rung 2); records members\' contributions (rung 2).'
  },
  {
    title: 'A land trust',
    today: 'Holds deeds, stewardship plans, surveys and meeting notes, private to its stewards where it needs to be.',
    next: 'votes on land-use decisions with a public record (rung 2); settles disagreements through a member panel (rung 2).'
  },
  {
    title: 'A Drupal user group',
    today: 'Keeps its meetup notes, talk write-ups and organizing handbook in one place; members ask "Who\'s organizing the next contribution day?" and get the answer with the notes it came from.',
    next: 'sees its sponsorship fund\'s balance and who approves spending (rung 1); votes on how to spend it (rung 2).'
  },
  {
    title: 'A bioregional network',
    today: 'Its member groups each run a group on one site, sharing a library while keeping private pages private.',
    next: 'community-wide votes with one vote per member group (rung 2).'
  }
]

// Both returned HTTP 200 on 2026-11-06 (re-checked by 22.1-04 before shipping).
const demos = [
  { name: 'Cascadia (demo)', host: 'cascadia.localnodes.xyz', url: 'https://cascadia.localnodes.xyz' },
  { name: 'Boulder (demo)', host: 'boulder.localnodes.xyz', url: 'https://boulder.localnodes.xyz' }
]
</script>

<template>
  <section class="bg-muted">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-20 flex flex-col gap-6">
      <h2 class="text-3xl font-semibold text-highlighted">
        See it in action
      </h2>
      <p class="text-lg text-muted">
        Here's how a few kinds of groups would use it. These are examples, not customers.
      </p>
      <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="example in examples"
          :key="example.title"
          class="bg-default rounded-lg border border-default p-5 flex flex-col gap-2.5"
        >
          <span class="self-start rounded-full border border-accented px-2.5 py-0.5 text-xs text-muted">Example</span>
          <h3 class="text-lg font-semibold text-highlighted">
            {{ example.title }}
          </h3>
          <p class="leading-relaxed text-muted">
            {{ example.today }}
          </p>
          <p class="text-sm leading-relaxed">
            <span class="font-semibold text-primary">Next:</span>
            {{ ' ' }}
            <span class="text-muted">{{ example.next }}</span>
          </p>
        </div>
      </div>

      <h3 class="text-xl font-semibold text-highlighted mt-6">
        Try a demo site
      </h3>
      <p class="text-muted">
        These are demo sites with sample content, so you can see a LocalNodes
        community before you start your own.
      </p>
      <div class="grid gap-4 md:grid-cols-2">
        <a
          v-for="demo in demos"
          :key="demo.url"
          :href="demo.url"
          target="_blank"
          rel="noopener noreferrer"
          class="group bg-default rounded-lg border border-default p-5 flex flex-col gap-2 transition-colors duration-150 ease-out hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <span class="font-semibold text-highlighted">{{ demo.name }}</span>
          <span class="text-muted">Demo: a sample community site with groups, events and an AI assistant.</span>
          <span class="inline-flex items-center gap-1 text-primary underline">
            {{ demo.host }}
            <UIcon name="i-lucide-external-link" class="size-4" aria-hidden="true" />
            <span class="sr-only">(opens in a new tab)</span>
          </span>
        </a>
      </div>
    </div>
  </section>
</template>

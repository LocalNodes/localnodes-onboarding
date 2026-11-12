<script setup lang="ts">
// One kind of community on the "Who it's for" page: who it is, how its site and
// groups are set up, and two things it would do in its first week. The words come
// from app/data/who-its-for.json. A demo link shows only when the kind has a live
// demo address; an empty address or no demo shows nothing, not a placeholder.
interface Kind {
  id: string
  heading: string
  who: string
  shape: string
  firstWeek: string[]
  demo: { name: string, url: string } | null
}

defineProps<{ kind: Kind }>()
</script>

<template>
  <section :id="kind.id" class="scroll-mt-20 border-t border-default pt-8 mt-12">
    <h2 class="text-xl leading-tight font-semibold text-highlighted mb-2">
      {{ kind.heading }}
    </h2>
    <p class="text-base leading-normal text-default max-w-[72ch]">
      {{ kind.who }}
    </p>
    <dl class="mt-4 grid gap-y-2 sm:grid-cols-[10rem_1fr] sm:gap-x-6 sm:gap-y-4 max-w-[72ch]">
      <dt class="text-sm leading-normal font-semibold text-muted">
        How it's set up
      </dt>
      <dd class="text-base leading-normal text-default mb-2 sm:mb-0">
        {{ kind.shape }}
      </dd>
      <dt class="text-sm leading-normal font-semibold text-muted">
        In the first week
      </dt>
      <dd class="text-base leading-normal text-default">
        <ul class="list-disc pl-5 space-y-1">
          <li v-for="line in kind.firstWeek" :key="line">
            {{ line }}
          </li>
        </ul>
      </dd>
    </dl>
    <p v-if="kind.demo?.url" class="mt-4 text-base leading-normal">
      <a :href="kind.demo.url" target="_blank" rel="noopener noreferrer" class="text-[#115e59] underline underline-offset-2">Look around the {{ kind.demo.name }} demo site (a demo)<span class="sr-only"> (opens in a new tab)</span></a>
    </p>
  </section>
</template>

<script setup lang="ts">
// The example window at the top of the "Who it's for" page. Pick a kind of community and
// a made-up site of that kind shows, built from the home page's window parts: the site
// and its groups, a member's question, an answer that cites a page from the library, that
// page lying on top as paper, and one more tile from the kind's first week. Every word
// comes from app/data/who-its-for.json, which the claims check reads with the page, so a
// window says nothing the page text could not say.
//
// The kinds are tabs: arrow keys, Home and End move between them. Each window is a
// picture, hidden from the accessibility tree; the `home-alt` sentence beside it says what
// it shows. All the windows share one grid cell and its rows, so the frame keeps its size
// and place whichever kind is showing. The tabs need scripts: until the page is live they
// keep their space but stay hidden, and the first window shows.
import { computed, onMounted, ref } from 'vue'
import { tabAfterKey } from '~/utils/tab-keys'

interface Choice {
  label: string
  count: number
}

/** The tile under the answer: an event, a quick question with its answers, or a post. */
interface Tile {
  type: string
  who?: string
  initials?: string
  group?: string
  when?: string
  text?: string
  day?: string
  date?: string
  title?: string
  meta?: string
  going?: number
  options?: Choice[]
}

interface Example {
  chip: string
  site: string
  groups: string[]
  docs: string[]
  hit: number
  q: string
  a: string
  source: string
  p: string[]
  tile: Tile
}

interface Kind {
  id: string
  example: Example
}

const props = defineProps<{ kinds: Kind[], label: string, note: string }>()

const cur = ref(0)
const live = ref(false)

onMounted(() => {
  live.value = true
})

/** "a, b and c" */
function joined(words: string[]): string {
  if (words.length < 2) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/** How many members answered a quick question. */
function answers(t: Tile): number {
  return (t.options ?? []).reduce((n, o) => n + o.count, 0)
}

/** One answer's share of them, in whole percent: the width of its bar. */
function share(t: Tile, o: Choice): number {
  const all = answers(t)
  return all ? Math.round(o.count * 100 / all) : 0
}

/** The tile in words. */
function tileAlt(t: Tile): string {
  if (t.type === 'event') return `Coming up: ${t.title}, ${t.day} ${t.date}, ${t.meta}, ${t.going} going.`
  if (t.type === 'question') {
    const counts = (t.options ?? []).map(o => `${o.count} for ${o.label}`)
    return `${t.who} asked a quick question in ${t.group}: "${t.text}" Answers: ${joined(counts)}.`
  }
  return `${t.who} posted in ${t.group}, ${t.when}: "${t.text}"`
}

/** What a window shows, in words: the sentence a screen reader reads in its place. */
function alt(e: Example): string {
  return `Made-up example. The ${e.site} site, with the groups ${joined(e.groups)}. A member asks: "${e.q}" The answer: "${e.a}" It cites ${e.source}: "${e.p.join('')}" ${tileAlt(e.tile)}`
}

const shown = computed(() => props.kinds.map(k => ({ id: k.id, e: k.example, t: k.example.tile, alt: alt(k.example) })))

/** Arrow keys, Home and End move to another tab, and its window shows. */
function onKey(ev: KeyboardEvent) {
  const next = tabAfterKey(ev.key, cur.value, props.kinds.length)
  if (next === null) return
  ev.preventDefault()
  cur.value = next
  const tabs = (ev.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]')
  tabs[next]?.focus()
}
</script>

<template>
  <div class="kw" :class="{ 'home-live': live }">
    <div class="kw-words">
      <slot />
      <p id="kw-label" class="kw-label home-needs-js">
        {{ label }}
      </p>
      <div class="home-who kw-tabs home-needs-js" role="tablist" aria-labelledby="kw-label" @keydown="onKey">
        <button
          v-for="(k, i) in kinds"
          :id="`kw-tab-${k.id}`"
          :key="k.id"
          type="button"
          role="tab"
          :aria-selected="i === cur"
          :aria-controls="`kw-panel-${k.id}`"
          :tabindex="i === cur ? 0 : -1"
          @click="cur = i"
        >{{ k.example.chip }}</button>
      </div>
      <p class="home-under kw-note">
        {{ note }}
      </p>
    </div>

    <div class="home-stk kw-stack">
      <div
        v-for="(s, i) in shown"
        :id="`kw-panel-${s.id}`"
        :key="s.id"
        class="kw-panel"
        :class="{ 'is-cur': i === cur }"
        role="tabpanel"
        :aria-labelledby="`kw-tab-${s.id}`"
        tabindex="0"
      >
        <p class="home-alt">{{ s.alt }}</p>
        <div class="home-stage kw-stage" aria-hidden="true">
          <div class="home-st-head kw-head">
            <svg viewBox="0 0 48 48" width="20" height="20">
              <circle cx="24" cy="24" r="15" fill="none" stroke="currentColor" stroke-width="3" />
              <circle cx="24" cy="9" r="5" fill="currentColor" />
              <circle cx="11" cy="31.5" r="5" fill="currentColor" />
              <circle cx="37" cy="31.5" r="5" fill="currentColor" />
              <circle cx="24" cy="24" r="4.5" style="fill: var(--home-hit)" />
            </svg>
            <b>{{ s.e.site }}</b>
            <span class="kw-groups"><span class="home-mono kw-groups-k">Groups</span><span v-for="g in s.e.groups" :key="g">{{ g }}</span></span>
          </div>
          <div class="home-st-body kw-body">
            <ul class="home-rail">
              <li v-for="(doc, j) in s.e.docs" :key="doc" :class="{ hit: j === s.e.hit }"><i></i>{{ doc }}</li>
            </ul>
            <div class="home-thread kw-thread">
              <div class="kw-q">
                <p class="home-q">{{ s.e.q }}</p>
              </div>
              <div class="home-ans kw-ans">
                <p class="home-ans-p">{{ s.e.a }}</p>
                <span class="home-cite kw-cite">[1] {{ s.e.source }}</span>
              </div>
              <div class="kw-tile">
                <template v-if="s.t.type === 'event'">
                  <p class="home-mono kw-tile-k">Coming up</p>
                  <div class="home-ev">
                    <span class="home-ev-date"><small>{{ s.t.day }}</small>{{ s.t.date }}</span>
                    <span class="home-ev-what kw-ev-what"><b>{{ s.t.title }}</b><small>{{ s.t.meta }} · {{ s.t.going }} going</small></span>
                    <span class="home-ev-btn done">You're going</span>
                  </div>
                </template>
                <div v-else class="home-post">
                  <div class="home-post-head">
                    <span class="home-av">{{ s.t.initials }}</span>
                    <span v-if="s.t.type === 'question'"><b>{{ s.t.who }}</b> asked a quick question in {{ s.t.group }}</span>
                    <span v-else><b>{{ s.t.who }}</b> posted in {{ s.t.group }}<small>{{ s.t.when }}</small></span>
                  </div>
                  <p>{{ s.t.text }}</p>
                  <template v-if="s.t.type === 'question'">
                    <span v-for="o in s.t.options" :key="o.label" class="kw-choice">
                      <span class="kw-choice-row"><span>{{ o.label }}</span><span>{{ o.count }}</span></span>
                      <span class="kw-bar"><i :style="{ width: `${share(s.t, o)}%` }"></i></span>
                    </span>
                    <span class="kw-total">{{ answers(s.t) }} answers</span>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </div>
        <aside class="home-paper lit kw-paper" aria-hidden="true">
          <span class="home-paper-k"><span>{{ s.e.source }}</span><span class="n">[1]</span></span>
          <p class="home-paper-p">{{ s.e.p[0] }}<mark>{{ s.e.p[1] }}</mark>{{ s.e.p[2] }}</p>
        </aside>
      </div>
    </div>
  </div>
</template>

<style scoped>
.kw {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
  gap: 56px;
  align-items: start;
}

.kw-words {
  min-width: 0;
}

.kw-label {
  margin-top: 28px;
  margin-bottom: 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}

/* The selected tab looks like the home page's pressed switcher button. */
.kw-tabs button[aria-selected='true'] {
  border-color: var(--home-lit);
  color: var(--home-lit);
  background: color-mix(in srgb, var(--home-lit-deep) 70%, transparent);
}

.kw-note {
  margin-top: 14px;
}

/* Every window in one cell, with three shared rows: the site's header, its page, and the
   paper. Each row is as tall as the tallest window needs, so nothing moves on a switch. */
.kw-stack {
  grid-template-rows: auto auto auto;
}

.kw-panel {
  grid-area: 1 / 1 / 4 / 2;
  position: relative;
  display: grid;
  grid-template-rows: subgrid;
  border-radius: 12px;
}

.kw-stage {
  grid-row: 1 / 3;
  display: grid;
  grid-template-rows: subgrid;
}

.kw-head {
  align-content: center;
}

.kw-groups {
  flex: 1 0 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 14px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ui-text-muted);
}

.kw-groups-k {
  font-size: 11px;
}

.kw-thread {
  padding-bottom: 56px;
}

.kw-q {
  align-self: flex-end;
  max-width: 92%;
}

/* The answer takes its own height, so the tile follows it and any room the tallest kind
   needs is left at the foot of the window, under the paper. */
.kw-ans {
  flex: 0 0 auto;
}

.kw-cite {
  white-space: normal;
}

.kw-tile {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.kw-tile-k {
  font-size: 11px;
  color: var(--ui-text-muted);
}

.kw-ev-what {
  flex: 1 1 8rem;
}

.kw-choice {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 14px;
  line-height: 1.4;
}

.kw-choice-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-variant-numeric: tabular-nums;
}

.kw-bar {
  display: block;
  height: 6px;
  border-radius: 999px;
  background: var(--home-line);
  overflow: hidden;
}

.kw-bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--home-lit);
}

.kw-total {
  font-size: 13px;
  color: var(--ui-text-muted);
  font-variant-numeric: tabular-nums;
}

/* The paper lies over the bottom of the window, as on the home page, but in the flow. */
.kw-paper {
  position: relative;
  right: auto;
  bottom: auto;
  grid-row: 3;
  justify-self: end;
  align-self: start;
  margin-top: -44px;
  margin-right: -12px;
}

@media (max-width: 900px) {
  .kw {
    grid-template-columns: minmax(0, 1fr);
    gap: 40px;
  }

  .kw-paper {
    margin-right: -6px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .kw *,
  .kw *::before,
  .kw *::after {
    transition: none !important;
    animation: none !important;
  }
}
</style>

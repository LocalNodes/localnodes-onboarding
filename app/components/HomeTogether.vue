<script setup lang="ts">
// "Shares": the group's home page, with a post, a comment and an event. It comes before
// the three acts because it is where a question starts: the post here is the one the decision
// and the payment below are about. The server renders the finished state; the controller
// replays it when the window scrolls into view and from "Play again". The window is a picture
// (hidden from the accessibility tree); the sentence in `home-alt` is its finished state, built
// from the same data, so the two cannot disagree.
import { computed, onMounted, ref } from 'vue'
import { injectHomeDemos } from '~/composables/useHomeDemos'

const d = injectHomeDemos()
const s = d.state.talk
const t = d.data.talk
const feed = ref<HTMLElement | null>(null)

const alt = computed(() => {
  return `Example of a group's home page for Willow House. ${t.post.who} posted ${t.post.when}: "${t.post.text}" ${t.likesAfter} likes. ${t.comment.who} commented: "${t.comment.text}" Coming up: ${t.event.title}, ${t.event.day} ${t.event.date}, ${t.event.meta}, ${t.event.goingAfter} going.`
})

onMounted(() => {
  if (feed.value) d.observe('talk', feed.value)
})
</script>

<template>
  <section id="together" class="home-act flip home-band-light">
    <div class="home-wrap">
      <div class="home-words">
        <span class="home-mono">Shares</span>
        <h2 class="home-h2">Post news, plan events and keep in touch.</h2>
        <p class="home-tag"><span class="home-pill">In the first pilots</span></p>
        <p>Every group has a home page with its latest posts and what's coming up. Members write, add photos, comment, and say they're coming.</p>
        <ul>
          <li>Posts with photos, comments and likes</li>
          <li>Events with a sign-up list</li>
          <li>Longer pages for news and discussions</li>
          <li>Open groups, and groups you join by invitation or request</li>
          <li>Newest first, and no ads</li>
        </ul>
        <button type="button" class="home-plain home-again home-needs-js home-motion-only" @click="d.play('talk')">Play again</button>
      </div>
      <p class="home-alt">{{ alt }}</p>
      <div class="home-hold" aria-hidden="true">
        <div class="home-stage">
          <div class="home-st-head"><b>Willow House</b><span class="home-tabs"><span class="on">Home</span><span>Library</span><span>Decisions</span><span>Fund</span></span></div>
          <div class="home-pad">
            <div class="home-post">
              <div class="home-post-head">
                <span class="home-av">{{ t.post.initials }}</span>
                <span><b>{{ t.post.who }}</b> posted in Willow House<small>{{ t.post.when }}</small></span>
              </div>
              <p>{{ t.post.text }}</p>
              <div class="home-react">
                <span class="home-like" :class="{ on: s.liked }"><i></i>{{ s.likes }} likes</span>
                <span>{{ s.commentOn ? 1 : 0 }} {{ s.commentOn ? 'comment' : 'comments' }}</span>
              </div>
              <div class="home-reply" :class="{ off: !s.commentOn }">
                <span class="home-av">{{ t.comment.initials }}</span>
                <span><b>{{ t.comment.who }}</b> {{ t.comment.text }}</span>
              </div>
            </div>
            <div ref="feed" class="home-ev">
              <span class="home-ev-date"><small>{{ t.event.day }}</small>{{ t.event.date }}</span>
              <span class="home-ev-what"><b>{{ t.event.title }}</b><small>{{ t.event.meta }} · {{ s.going }} going</small></span>
              <span class="home-ev-btn" :class="{ done: s.joined }">
                <span class="home-stk">
                  <span :class="{ 'is-cur': !s.joined }">{{ t.event.buttonIdle }}</span>
                  <span :class="{ 'is-cur': s.joined }">{{ t.event.buttonDone }}</span>
                </span>
              </span>
            </div>
            <p class="home-fine">{{ t.fine }}</p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

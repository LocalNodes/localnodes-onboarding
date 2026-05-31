---
name: run-localnodes-onboarding
description: Run, start, serve, build, smoke-test, or screenshot the LocalNodes onboarding app (the Nuxt 4 marketing + onboarding site). Use when asked to launch the dev server, verify the landing/onboarding pages render, or confirm a frontend change works in the actual running app.
---

# Run: LocalNodes Onboarding

Nuxt 4 marketing + onboarding site. The agent path is: start the dev server with
`npm run dev`, then drive it over HTTP with the committed `smoke.mjs` (Node +
`fetch`, no browser, no secrets). For visual checks, screenshot the landing page
with whatever browser tooling is available (see [Screenshots](#screenshots)).

> Paths below are relative to the repo root (the unit). The driver lives at
> `.claude/skills/run-localnodes-onboarding/smoke.mjs`.

## Prerequisites

- Node + npm. Verified on **Node v25.8.1** (macOS/darwin). The version matters —
  see the `better-sqlite3` gotcha below.
- A C/C++ toolchain for the one native dependency (`better-sqlite3`, pulled in by
  `@nuxt/content`). Present by default on macOS with Xcode Command Line Tools.
- No env vars needed to launch and smoke-test. The landing page, `/onboarding`
  form, and reserved-subdomain check run **without secrets**. The full flow
  (Stripe checkout, live subdomain availability via Coolify, provisioning) needs
  real `NUXT_*` creds — see `.env.example`.

## Setup / Build

```bash
npm install
```

If you just changed Node versions (e.g. a Homebrew upgrade), rebuild the native
module — this is the #1 reason the dev server won't boot:

```bash
npm rebuild better-sqlite3
```

## Run (agent path)

Start the dev server in the background and wait for it to answer:

```bash
npm run dev   # serves http://localhost:3000
```

```bash
# poll until it responds (first boot compiles content + nitro)
for i in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/)" = "200" ] && { echo "up after ${i}s"; break; }
  sleep 1
done
```

Then drive it with the smoke harness (asserts the routes a landing/onboarding PR
touches; exits non-zero on any failure):

```bash
node .claude/skills/run-localnodes-onboarding/smoke.mjs
```

Verified output (7/7):

```
✓ GET / renders hero copy (SEO / SSR)
✓ @vueuse/motion is active (initial opacity:0 in SSR HTML)
✓ hero headline (LCP element) is NOT shipped hidden
✓ GET /onboarding renders the form
✓ GET /cancel renders
✓ check-subdomain rejects reserved names (no external call)
✓ check-subdomain validates too-short slugs (400)

7/7 checks passed against http://localhost:3000
```

Pass a different base URL as the first arg to smoke a preview/prod build:
`node .claude/skills/run-localnodes-onboarding/smoke.mjs http://localhost:3000`.

### Screenshots

`chromium-cli` is **not** guaranteed present (it was absent on this machine).
Use whatever browser automation is available (the `dev-browser` skill, a local
Playwright, etc.) pointed at `http://localhost:3000/`. The landing page uses
scroll-triggered `@vueuse/motion` reveals — **scroll the page through its full
height (with short pauses) before capturing**, or below-the-fold sections stay at
`opacity:0` and the screenshot looks half-blank. That blankness is the animation
not having fired, not a render failure.

## Run (human path)

```bash
npm run dev
```

Open http://localhost:3000 in a browser. Useless for headless verification — use
the smoke harness above instead.

## Test

```bash
npm run test   # vitest, verified: 111 passed (10 files)
```

## Gotchas

- **`better-sqlite3` ABI mismatch is the main footgun.** `@nuxt/content` v3 uses
  it for its local content DB, and its compiled `.node` binary is tied to the
  Node major version. After any Node bump the dev server dies at boot with
  `NODE_MODULE_VERSION ... requires NODE_MODULE_VERSION ...`. Fix: `npm rebuild
  better-sqlite3` (or a fresh `npm install`). Observed this session: binary built
  for Node 23 (ABI 131), running Node 25 (ABI 141).
- **Lucide icon warning is harmless in dev.** `WARN [Icon] Collection lucide is
  not found locally` — icons are fetched remotely in dev. For offline/CI runs
  install `@iconify-json/lucide` as a dev dep; not needed to launch.
- **`/` is prerendered and motion-initial styles are baked into the SSR HTML.**
  Above-the-fold content ships with inline `opacity:0` and animates in on
  hydration; below-the-fold uses scroll-triggered reveals. The hero `<h1>` is the
  exception (kept opaque for LCP) — the third smoke check guards that.
- **No secrets needed for the smoke targets, by design.** `check-subdomain`
  short-circuits on its reserved-name list and validation *before* calling the
  Coolify API, so the harness exercises real endpoints without credentials.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Dev server exits immediately; log shows `NODE_MODULE_VERSION ... requires ...` near `better-sqlite3`/`db0` | `npm rebuild better-sqlite3` |
| Smoke check 6/7 returns a 502 instead of the reserved-name JSON | You're hitting a code path that calls Coolify — confirm the slug is `www` (reserved); a non-reserved slug needs `NUXT_COOLIFY_API_TOKEN` |
| Port 3000 already in use | `lsof -ti :3000 | xargs kill`, then `npm run dev` |

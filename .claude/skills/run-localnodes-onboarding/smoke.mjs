#!/usr/bin/env node
// Smoke-test harness for the LocalNodes onboarding app.
//
// Drives an ALREADY-RUNNING dev/preview server over HTTP and asserts the
// routes a landing/onboarding PR actually touches. No browser, no secrets,
// no project deps -- just Node's global fetch (Node 18+).
//
//   node .claude/skills/run-localnodes-onboarding/smoke.mjs [baseUrl]
//
// Exits 0 if every check passes, 1 otherwise. Default baseUrl http://localhost:3000.

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')

/** @type {{name:string, run:(t:string,s:number)=>(true|string)}[]} */
const checks = [
  {
    name: 'GET / renders hero copy (SEO / SSR)',
    path: '/',
    expect: (body, status) =>
      status === 200 && body.includes('knowledge is scattered across')
        ? true
        : `status=${status}, hero text present=${body.includes('knowledge is scattered across')}`,
  },
  {
    name: '@vueuse/motion is active (initial opacity:0 in SSR HTML)',
    path: '/',
    expect: (body) =>
      body.includes('opacity:0')
        ? true
        : 'no motion-initial inline styles found -- did the motion module drop out?',
  },
  {
    name: 'hero headline (LCP element) is NOT shipped hidden',
    path: '/',
    // Regression guard for the LCP fix: the <h1> wrapper must not carry
    // opacity:0 in the prerendered HTML, or it paints blank until hydration.
    expect: (body) =>
      /opacity:0[^>]*>\s*Your community/.test(body)
        ? 'hero headline wrapper has opacity:0 again -- LCP regression'
        : true,
  },
  {
    name: 'GET /onboarding renders the form',
    path: '/onboarding',
    expect: (body, status) =>
      status === 200 && body.includes('Name your community')
        ? true
        : `status=${status}, form heading present=${body.includes('Name your community')}`,
  },
  {
    name: 'GET /cancel renders',
    path: '/cancel',
    expect: (_b, status) => (status === 200 ? true : `status=${status}`),
  },
  {
    name: 'check-subdomain rejects reserved names (no external call)',
    path: '/api/check-subdomain?slug=www',
    expect: (body, status) => {
      if (status !== 200) return `status=${status}`
      try {
        const j = JSON.parse(body)
        return j.available === false && /reserved/i.test(j.reason ?? '')
          ? true
          : `unexpected json: ${body}`
      } catch {
        return `non-json body: ${body.slice(0, 80)}`
      }
    },
  },
  {
    name: 'check-subdomain validates too-short slugs (400)',
    path: '/api/check-subdomain?slug=ab',
    expect: (_b, status) => (status === 400 ? true : `expected 400, got ${status}`),
  },
]

let failed = 0
for (const c of checks) {
  let body = '', status = 0
  try {
    const res = await fetch(base + c.path)
    status = res.status
    body = await res.text()
  } catch (err) {
    console.log(`✗ ${c.name}\n    request failed: ${err.message}`)
    failed++
    continue
  }
  const result = c.expect(body, status)
  if (result === true) {
    console.log(`✓ ${c.name}`)
  } else {
    console.log(`✗ ${c.name}\n    ${result}`)
    failed++
  }
}

console.log(`\n${checks.length - failed}/${checks.length} checks passed against ${base}`)
process.exit(failed === 0 ? 0 : 1)

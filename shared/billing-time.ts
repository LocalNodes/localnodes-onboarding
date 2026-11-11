// The end of a 3DS hold as people read it (Phase 23, plan 23-37; orchestrator
// answer Q-time, 2026-11-08, 23-UI-SPEC "Billing copy (B-1)"): 12-hour, lower
// case am/pm, with the time zone, for example "November 9, 2026 at 4:15pm MST".
//   - Page (/success, held): the reader's own zone, formatted in the browser
//     (no zone passed).
//   - Mails (the 3DS mail): the zone kept at checkout on signup:{provisionId}
//     (23-32), falling back to UTC.
// One formatter for both, so the shape never differs. No Node import: the
// browser loads this file.

/** Is this an IANA zone name the runtime knows? */
function knownZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/**
 * "November 9, 2026 at 4:15pm UTC". `timeZone` undefined means the runtime's
 * own zone (the browser's, on the page); an unknown zone falls back to UTC.
 */
export function formatHeldUntil(ms: number, timeZone?: string): string {
  const zone = timeZone === undefined ? undefined : (timeZone && knownZone(timeZone) ? timeZone : 'UTC')
  const parts = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
    ...(zone ? { timeZone: zone } : {})
  }).formatToParts(new Date(ms))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? ''
  return `${part('month')} ${part('day')}, ${part('year')} at ${part('hour')}:${part('minute')}${part('dayPeriod').toLowerCase()} ${part('timeZoneName')}`
}

/** The zone a mail uses: the one kept at checkout when it is a known zone, else UTC. */
export function mailTimeZone(stored: unknown): string {
  return typeof stored === 'string' && stored && knownZone(stored) ? stored : 'UTC'
}

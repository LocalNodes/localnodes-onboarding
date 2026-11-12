/**
 * Which tab a key moves to in a row of tabs: the arrow keys step to the next or
 * previous tab and wrap around at the ends, Home goes to the first and End to
 * the last. Any other key moves nothing and gives null, so the page keeps it.
 */
export function tabAfterKey(key: string, current: number, count: number): number | null {
  if (count < 1) return null
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % count
    case 'ArrowLeft':
      return (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

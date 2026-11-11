// A server with room, for checkout tests that are not about capacity (23-17).
// Every call is a vi.fn, so a test can still assert what was asked.
import { vi } from 'vitest'

export function roomyCapacity() {
  return {
    hasRoom: vi.fn(async () => true),
    waitlist: vi.fn(async (_email: string) => {}),
    addInflight: vi.fn(async (_provisionId: string) => {})
  }
}

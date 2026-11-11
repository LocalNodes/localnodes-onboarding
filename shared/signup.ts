// What the sign-up asks for, shared by the server checkout (Phase 23, plan
// 23-07) and the suggestion endpoint (23-30). Plain valibot, no Nitro globals.
//
// The organizer confirms a short list of page types (D-20). Only labels that
// pass the rules here, after cleaning, ever reach a new site: a page type the
// organizer did not confirm is never created.
import * as v from 'valibot'
import { SUBDOMAIN_PATTERN } from './provisioning'

/** The page types every community site already has. Never suggested, never created twice. */
export const DEFAULT_TOPIC_TYPES = ['Blog', 'Content', 'Dialog', 'News', 'Reference'] as const

/** One page-type label: 2 to 40 characters of letters, digits, spaces and & - ' / */
export const topicTypeLabelSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(2),
  v.maxLength(40),
  v.regex(/^[\p{L}\p{N} &'\/-]+$/u)
)

/** The community name, the subdomain and the confirmed page types. No email: checkout takes it from the invited session. */
export const signupBodySchema = v.object({
  communityName: v.pipe(v.string(), v.minLength(3), v.maxLength(50)),
  subdomain: v.pipe(v.string(), v.minLength(3), v.maxLength(63), v.regex(SUBDOMAIN_PATTERN)),
  topicTypes: v.optional(v.pipe(v.array(topicTypeLabelSchema), v.maxLength(12)))
})

export type SignupBody = v.InferOutput<typeof signupBodySchema>

/**
 * Trim, collapse runs of spaces, drop labels that fail the rules, drop
 * case-insensitive duplicates and the default types, and keep the order.
 */
export function cleanTopicTypes(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>(DEFAULT_TOPIC_TYPES.map(t => t.toLowerCase()))
  return list
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim().replace(/\s+/g, ' '))
    .filter(label => v.safeParse(topicTypeLabelSchema, label).success)
    .filter((label) => {
      const key = label.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

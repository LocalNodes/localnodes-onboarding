// The sign-up form's own checks (fresh3 23-19). They are for the person only:
// the server checks every rule again (shared/signup.ts, server/utils/checkout.ts,
// 23-15, 23-18). Messages are 23-UI-SPEC.md section 3 rows.
import * as v from 'valibot'
import { topicTypeLabelSchema } from '#shared/signup'
import { AI_CHOICES, KEY_NOT_CHECKED_MESSAGE } from '#shared/ai-choice'
import { MAX_DESCRIPTION, MAX_PAGE_TYPES, MIN_DESCRIPTION, SIGNUP_COPY } from './onboarding-flow'

const description = v.pipe(
  v.string(),
  v.trim(),
  v.check(text => text.length === 0 || text.length >= MIN_DESCRIPTION, SIGNUP_COPY.pageTypes.tooShort),
  v.maxLength(MAX_DESCRIPTION, SIGNUP_COPY.pageTypes.tooLong)
)

export const onboardingSchema = v.pipe(
  v.object({
    communityName: v.pipe(v.string(), v.trim(), v.minLength(3, SIGNUP_COPY.nameEmpty), v.maxLength(50)),
    description: v.optional(description, ''),
    topicTypes: v.optional(v.pipe(v.array(topicTypeLabelSchema), v.maxLength(MAX_PAGE_TYPES)), []),
    aiChoice: v.optional(v.picklist([...AI_CHOICES]), 'default'),
    /** True only once POST /api/ai-key has accepted a key of the chosen kind for this session. */
    keyChecked: v.optional(v.boolean(), false),
    code: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64)), '')
  }),
  v.forward(
    v.check(input => input.aiChoice === 'default' || input.keyChecked, KEY_NOT_CHECKED_MESSAGE),
    ['keyChecked']
  )
)

export type OnboardingInput = v.InferInput<typeof onboardingSchema>
export type OnboardingSchema = v.InferOutput<typeof onboardingSchema>

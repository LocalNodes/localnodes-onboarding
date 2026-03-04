import * as v from 'valibot'

export const onboardingSchema = v.object({
  communityName: v.pipe(
    v.string(),
    v.minLength(3, 'Community name must be at least 3 characters'),
    v.maxLength(50, 'Community name must be under 50 characters')
  ),
  email: v.pipe(
    v.string(),
    v.email('Please enter a valid email address')
  )
})

export type OnboardingSchema = v.InferOutput<typeof onboardingSchema>

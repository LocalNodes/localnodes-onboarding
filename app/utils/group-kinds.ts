// The early-access form's group kinds. `value` is what the form sends and what
// the Resend contact property, the invite-wave import (scripts/invites) and any
// later reader match on: never change a value. `label` is what the visitor
// sees, and may change. The online-community label drops "DAO" so it reads plainly
// to people who do not know the word; its stored value is kept for the readers above.
export const GROUP_KINDS = [
  { label: 'Co-op', value: 'Co-op' },
  { label: 'Online community or working group', value: 'Online guild or DAO' },
  { label: 'Land trust', value: 'Land trust' },
  { label: 'Neighborhood or tenant group', value: 'Neighborhood or tenant group' },
  { label: 'Mutual aid network', value: 'Mutual aid network' },
  { label: 'User group or meetup', value: 'User group or meetup' },
  { label: 'Network of groups', value: 'Network of groups' },
  { label: 'Something else', value: 'Something else' }
] as const

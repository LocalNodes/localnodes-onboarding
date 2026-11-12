// The community kind travels on the invite: add it to the invite, make an
// invited checkout, and the site's manifest names it as community_template.
// One FakeRedis carries the whole path through the real handlers. Fictional
// addresses and test secrets only.
import { describe, it, expect, vi } from 'vitest'
import { FakeRedis } from './helpers/fake-redis'
import { roomyCapacity } from './helpers/capacity'
import { addInvite, emailKey, type InviteRecord } from '../../server/utils/invites'
import { handleCreateCheckout, type CheckoutDeps } from '../../server/utils/checkout'
import { handleManifest } from '../../server/utils/provision-manifest'
import { callbackToken } from '../../server/utils/provision-handlers'
import { HOLD_SCRIPT } from '../../server/utils/promo'

const INVITE_SECRET = 'test-invite-hash-secret'
const CALLBACK_SECRET = 'feed0000feed0000feed0000feed0000feed0000feed0000feed0000feed0000'
const EMAIL = 'house.organizer@example.invalid'
const PROVISION = 'Hc0Op1Ex2Am3Pl4Ei5D6xY'

async function inviteToManifest(communityTemplate?: string) {
  const redis = new FakeRedis()
  redis.onEval(HOLD_SCRIPT, async () => 1)
  const { inviteId } = await addInvite(redis, INVITE_SECRET, {
    email: EMAIL,
    kind: 'pilot',
    wave: 'w1',
    ...(communityTemplate === undefined ? {} : { communityTemplate })
  })
  const session: InviteRecord = { inviteId, emailHmac: emailKey(INVITE_SECRET, EMAIL), email: EMAIL }
  const create = vi.fn(async (_p: unknown) => ({ url: 'https://checkout.stripe.com/c/pay_1' as string | null }))
  const deps: CheckoutDeps = {
    open: false,
    session,
    stripe: { checkout: { sessions: { create } } },
    redis,
    priceId: 'price_test_123',
    currency: 'usd',
    origin: 'https://localnodes.xyz',
    newProvisionId: () => PROVISION,
    capacity: roomyCapacity(),
    paidSignupsEnabled: true
  }
  const checkout = await handleCreateCheckout({ communityName: 'Willow House', subdomain: 'willow' }, deps)
  expect(checkout.status).toBe(200)
  return handleManifest(
    { provision_id: PROVISION },
    `Bearer ${callbackToken(CALLBACK_SECRET, PROVISION)}`,
    { config: { provisionCallbackSecret: CALLBACK_SECRET }, redis }
  )
}

describe('the community kind goes from the invite to the site manifest', () => {
  it('an invite naming housing_coop gives community_template housing_coop', async () => {
    const out = await inviteToManifest('housing_coop')
    expect(out.status).toBe(200)
    expect((out.body as { community_template?: unknown }).community_template).toBe('housing_coop')
  })

  it('an invite with no kind gives an empty community_template', async () => {
    const out = await inviteToManifest()
    expect(out.status).toBe(200)
    expect((out.body as { community_template?: unknown }).community_template).toBe('')
  })
})

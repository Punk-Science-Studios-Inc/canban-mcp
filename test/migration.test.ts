import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools'
import * as commands from '../src/domain/commands'
import { template } from '../src/domain/entities'
import { reencryptions } from '../src/domain/migration'
import { resolve } from '../src/domain/resolve'

const ownerKey = generateSecretKey()
const owner = getPublicKey(ownerKey)
const adminKey = generateSecretKey()
const admin = getPublicKey(adminKey)

let clock = 1000
const sign = (writes: commands.Write[], key: Uint8Array): NostrEvent[] =>
  writes.map(({ address, content }) => finalizeEvent(template(address, content as never, clock++), key))

describe('re-encryption', () => {
  it('leaves an admin out of the owner’s own member event, which only the owner’s version decides', () => {
    const { companyId, writes } = commands.createCompany(owner, 'Old Co')
    const events = sign(writes, ownerKey)
    events.push(...sign(commands.setMember(companyId, admin, 'admin'), ownerKey))
    const state = resolve(events).get(companyId)!
    const mine = reencryptions(state, events, admin).map((w) => w.address)
    expect(mine).toEqual([]) // The owner's member event is the owner's; the admin's own was written by the owner.
    const theirs = reencryptions(state, events, owner).map((w) => w.address.type)
    // The owner also rewrites their company event: the organization exists by it.
    expect(theirs).toEqual(['company', 'member', 'member'])
  })
})

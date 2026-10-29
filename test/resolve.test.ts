import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools'
import { template, type Address, type Content } from '../src/domain/entities'
import { resolve } from '../src/domain/resolve'

const key = () => {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}
const owner = key()
const alice = key()
const mallory = key()
const companyId = `${owner.pk}.c1`

let clock = 1000
function sign<A extends Address>(who: { sk: Uint8Array }, address: A, content: Content<A>, at = clock++): NostrEvent {
  return finalizeEvent(template(address, content, at), who.sk)
}

const company = sign(owner, { type: 'company', companyId }, { name: 'punk science' })
const project = (members: string[], who = owner) =>
  sign(who, { type: 'project', companyId, projectId: 'p1' }, { name: 'canban', members })
const lane = (who: { sk: Uint8Array }, name: string) =>
  sign(who, { type: 'lane', companyId, projectId: 'p1', laneId: 'l1' }, { name, order: 1 })
const member = (who: { sk: Uint8Array }, pubkey: string, role: 'admin' | 'member' | 'removed', name?: string) =>
  sign(who, { type: 'member', companyId, pubkey }, { role, name })

describe('resolve', () => {
  it('ignores a company whose event was not signed by the owner in its id', () => {
    const forged = sign(mallory, { type: 'company', companyId }, { name: 'stolen' })
    expect(resolve([forged]).size).toBe(0)
  })

  it('only lets admins add members', () => {
    const state = resolve([company, member(mallory, mallory.pk, 'admin'), member(owner, alice.pk, 'member')]).get(companyId)!
    expect(state.members.map((m) => m.pubkey).sort()).toEqual([owner.pk, alice.pk].sort())
  })

  it('lets an admin appointed by the owner add members', () => {
    const state = resolve([company, member(owner, alice.pk, 'admin'), member(alice, mallory.pk, 'member')]).get(companyId)!
    expect(state.members.find((m) => m.pubkey === mallory.pk)?.role).toBe('member')
  })

  it('lets assigned members edit lanes and ignores everyone else', () => {
    const events = [company, member(owner, alice.pk, 'member'), member(owner, mallory.pk, 'member'), project([alice.pk])]
    expect(resolve([...events, lane(alice, 'doing')]).get(companyId)!.lanes[0].name).toBe('doing')
    expect(resolve([...events, lane(alice, 'doing'), lane(mallory, 'pwned')]).get(companyId)!.lanes[0].name).toBe('doing')
  })

  it('takes the newest authorised version across authors', () => {
    const events = [company, member(owner, alice.pk, 'member'), project([alice.pk]), lane(owner, 'a'), lane(alice, 'b')]
    expect(resolve(events).get(companyId)!.lanes[0].name).toBe('b')
  })

  it('drops removed members from projects', () => {
    const events = [company, member(owner, alice.pk, 'member'), project([alice.pk]), member(owner, alice.pk, 'removed')]
    expect(resolve(events).get(companyId)!.projects[0].members).toEqual([])
  })

  it('carries the name an admin gave a member', () => {
    const state = resolve([company, member(owner, alice.pk, 'member', 'alice')]).get(companyId)!
    expect(state.members.find((m) => m.pubkey === alice.pk)?.name).toBe('alice')
  })
})

import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import type { EventTemplate } from 'nostr-tools'
import { orgKey } from '../src/domain/crypto'
import { addHolder, emptyKeyrings, envelope, flatten, keyring, merge, mergeKeyrings, newOrgKey, noteCurrent, openEnvelope, openKeyring, recipients, rotation, writeKey, type Cipher, type Keyrings } from '../src/domain/keys'
import type { CompanyState, Member } from '../src/domain/model'

function person() {
  const sk = generateSecretKey()
  const pubkey = getPublicKey(sk)
  const cipher: Cipher = {
    encrypt: async (peer, text) => nip44.v2.encrypt(text, nip44.v2.utils.getConversationKey(sk, peer)),
    decrypt: async (peer, text) => nip44.v2.decrypt(text, nip44.v2.utils.getConversationKey(sk, peer)),
  }
  return { pubkey, cipher, sign: (t: EventTemplate) => finalizeEvent(t, sk) }
}

const owner = person()
const admin = person()
const member = person()
const companyId = `${owner.pubkey}.abc`

function state(members: Member[], kid?: string, kidAt = 100): CompanyState {
  return { kid, kidAt: kid ? kidAt : undefined, company: { id: companyId, owner: owner.pubkey, name: 'x' }, members: [{ pubkey: owner.pubkey, role: 'owner' }, ...members], projects: [], lanes: [], tasks: [] }
}
const org = state([{ pubkey: admin.pubkey, role: 'admin' }, { pubkey: member.pubkey, role: 'member' }])

describe('envelopes', () => {
  it('carry the key history from an admin to a member', async () => {
    const old = newOrgKey()
    const current = newOrgKey()
    const history = new Map([[old.kid, old.key], [current.kid, current.key]])
    const event = admin.sign(await envelope(admin.cipher, companyId, member.pubkey, history, 1))
    expect(event.tags).toContainEqual(['p', member.pubkey])
    const opened = await openEnvelope(member.cipher, event, org, member.pubkey)
    expect([...opened.keys()].sort()).toEqual([old.kid, current.kid].sort())
    expect(opened.get(current.kid)).toEqual(current.key)
  })

  it('are ignored from anyone but an admin', async () => {
    const k = newOrgKey()
    const event = member.sign(await envelope(member.cipher, companyId, member.pubkey, new Map([[k.kid, k.key]]), 1))
    expect((await openEnvelope(member.cipher, event, org, member.pubkey)).size).toBe(0)
  })

  it('drop keys that do not hash to their kid', async () => {
    const k = newOrgKey()
    const forged = orgKey(crypto.getRandomValues(new Uint8Array(32)))
    const event = admin.sign(await envelope(admin.cipher, companyId, member.pubkey, new Map([[k.kid, forged.key]]), 1))
    expect((await openEnvelope(member.cipher, event, org, member.pubkey)).size).toBe(0)
  })

  it('only open for the member they name', async () => {
    const k = newOrgKey()
    const event = admin.sign(await envelope(admin.cipher, companyId, admin.pubkey, new Map([[k.kid, k.key]]), 1))
    expect((await openEnvelope(member.cipher, event, org, member.pubkey)).size).toBe(0)
  })
})

const ringOf = (companyId: string, ...keys: { kid: string; key: Uint8Array }[]): Keyrings => {
  const rings = emptyKeyrings()
  rings.keys.set(companyId, new Map(keys.map((k) => [k.kid, k.key])))
  return rings
}

describe('keyrings', () => {
  it('round-trip every organization’s keys and current key for their owner only', async () => {
    const a = newOrgKey()
    const b = newOrgKey()
    const rings = ringOf(companyId, a)
    merge(rings, 'other.org', new Map([[b.kid, b.key]]))
    rings.current.set(companyId, { kid: a.kid, at: 5 })
    const event = member.sign(await keyring(member.cipher, member.pubkey, rings, 1))
    const opened = await openKeyring(member.cipher, event, member.pubkey)
    expect(flatten(opened).get(b.kid)).toEqual(b.key)
    expect(opened.current.get(companyId)).toEqual({ kid: a.kid, at: 5 })
    expect((await openKeyring(admin.cipher, event, admin.pubkey)).keys.size).toBe(0)
  })

  it('merge reports new keys only, and copies never drop keys', () => {
    const k = newOrgKey()
    const other = newOrgKey()
    const rings = emptyKeyrings()
    expect(merge(rings, companyId, new Map([[k.kid, k.key]]))).toBe(true)
    expect(merge(rings, companyId, new Map([[k.kid, k.key]]))).toBe(false)
    expect(mergeKeyrings(rings, ringOf(companyId, other))).toBe(true)
    expect(flatten(rings).size).toBe(2)
  })
})

describe('writing and rotation', () => {
  it('writes with the key the company names, refuses when it is missing or locked', () => {
    const k = newOrgKey()
    expect(writeKey(org, emptyKeyrings())).toBeUndefined()
    expect(writeKey(state([], k.kid), ringOf(companyId, k))?.kid).toBe(k.kid)
    expect(() => writeKey(state([], k.kid), emptyKeyrings())).toThrow()
    expect(() => writeKey({ ...org, locked: true }, emptyKeyrings())).toThrow()
  })

  it('refuses a key older than one already seen named', () => {
    const old = newOrgKey()
    const rings = ringOf(companyId, old)
    expect(noteCurrent(rings, state([], newOrgKey().kid, 200))).toBe(true)
    expect(() => writeKey(state([], old.kid, 100), rings)).toThrow()
  })

  it('every member, owner included, receives the key', () => {
    expect(recipients(org).sort()).toEqual([owner.pubkey, admin.pubkey, member.pubkey].sort())
  })

  it('refuses to write plaintext once the organization is known to be encrypted', () => {
    const rings = emptyKeyrings()
    rings.current.set(companyId, { kid: 'x', at: 1 })
    expect(() => writeKey(org, rings)).toThrow()
  })

  it('adds new people to the holders of the current key', () => {
    const k = newOrgKey()
    const keyed = { ...org, kid: k.kid, kidAt: 1, holders: [owner.pubkey] }
    expect(addHolder(keyed, admin.pubkey, member.pubkey)?.content).toEqual({ name: 'x', holders: [owner.pubkey, member.pubkey] })
    expect(addHolder(keyed, admin.pubkey, owner.pubkey)).toBeUndefined()
    expect(addHolder(keyed, member.pubkey, admin.pubkey)).toBeUndefined()
  })

  it('builds a rotation for admins only, keeping the history', () => {
    const old = newOrgKey()
    const keyed = { ...org, kid: old.kid, kidAt: 1 }
    const r = rotation(keyed, ringOf(companyId, old), admin.pubkey)
    expect(r.history.has(old.kid) && r.history.has(r.key.kid)).toBe(true)
    expect(r.company.address).toEqual({ type: 'company', companyId })
    expect(r.company.content).toMatchObject({ holders: expect.arrayContaining([owner.pubkey, admin.pubkey, member.pubkey]) })
    expect(() => rotation(keyed, ringOf(companyId, old), member.pubkey)).toThrow()
  })
})

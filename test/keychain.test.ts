import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type NostrEvent } from 'nostr-tools'
import * as nip44 from 'nostr-tools/nip44'
import * as commands from '../src/domain/commands'
import type { Keyring } from '../src/domain/crypto'
import { template } from '../src/domain/entities'
import { Keychain } from '../src/domain/keychain'
import { emptyKeyrings, envelope, keyring, newOrgKey } from '../src/domain/keys'
import { resolve } from '../src/domain/resolve'
import { profilesOf, profileTemplate } from '../src/domain/profile'

// A relay that keeps each author's newest copy of an address, shared by every client.
class Relay {
  events: NostrEvent[] = []
  add(event: NostrEvent) {
    const d = (e: NostrEvent) => e.tags.find((t) => t[0] === 'd')?.[1]
    this.events = this.events.filter((e) => !(e.pubkey === event.pubkey && d(e) === d(event)))
    this.events.push(event)
  }
}

let clock = 1000

function client(relay: Relay, refuse?: (e: NostrEvent) => boolean, secret?: Uint8Array, refuseDecrypt?: () => boolean) {
  const sk = secret ?? generateSecretKey()
  const me = getPublicKey(sk)
  const failures: unknown[] = []
  let keys: Keyring = new Map()
  const companies = () => resolve(relay.events, keys)
  const chain = new Keychain({
    me,
    companies,
    versions: (d) => relay.events.filter((e) => e.tags.some((t) => t[0] === 'd' && t[1] === d)),
    eventsIn: (companyId) => relay.events.filter((e) => e.tags.some((t) => t[0] === 'd' && t[1].split(':')[2] === companyId)),
    cipher: () => ({
      encrypt: async (peer, text) => nip44.v2.encrypt(text, nip44.v2.utils.getConversationKey(sk, peer)),
      decrypt: async (peer, text) => {
        if (refuseDecrypt?.()) throw new Error('refused')
        return nip44.v2.decrypt(text, nip44.v2.utils.getConversationKey(sk, peer))
      },
    }),
    sign: async (t: EventTemplate) => finalizeEvent(t, sk),
    send: async (e) => {
      if (refuse?.(e)) throw new Error('refused')
      relay.add(e)
    },
    nextTimestamp: () => clock++,
    nextTimestampIn: () => clock++,
    setKeys: (all) => (keys = all),
    report: (outcome, error) => {
      failures.push(outcome === 'failed' ? error : undefined)
    },
  })
  const write = (writes: commands.Write[], companyId: string) => {
    const state = companies().get(companyId)
    for (const { address, content } of writes) relay.add(finalizeEvent(template(address, content as never, clock++, state && chain.keyFor(state)), sk))
  }
  return { me, chain, companies, write, sk, failures, keys: () => keys }
}

async function organization(relay: Relay, owner: ReturnType<typeof client>) {
  const { companyId, writes } = commands.createCompany(owner.me, 'Hidden Co')
  const key = newOrgKey()
  await owner.chain.adopt(companyId, key)
  for (const { address, content } of writes) {
    const listed = address.type === 'company' ? { ...content, holders: [owner.me] } : content
    relay.add(finalizeEvent(template(address, listed as never, clock++, key), owner.sk))
  }
  return { companyId, key }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

describe('keychain', () => {
  it('encrypts an organization made before encryption, and everything already in it', async () => {
    const relay = new Relay()
    const alice = client(relay)
    const bob = client(relay)
    const { companyId, writes } = commands.createCompany(alice.me, 'Old Co')
    alice.write(writes, companyId)
    alice.write(commands.setMember(companyId, bob.me, 'member'), companyId)
    const { projectId, writes: project } = commands.createProject(companyId, 'Board', [bob.me])
    alice.write(project, companyId)
    const state = () => alice.companies().get(companyId)!
    const p = () => state().projects.find((x) => x.id === projectId)!
    const lane = state().lanes[0].id
    alice.write(commands.createTask(p(), lane, 'Gone').writes, companyId)
    alice.write(commands.updateTask(companyId, state().tasks[0], { removed: true }), companyId)
    // Bob's own task: his version is the one that counts.
    bob.write(commands.createTask(p(), lane, 'Bob task').writes, companyId)
    relay.add(finalizeEvent(profileTemplate(alice.me, { name: 'Alice A' }, clock++), alice.sk))
    expect(relay.events.some((e) => e.content.includes('Old Co'))).toBe(true)

    // The owner's first key goes out after a random spread; no wait here.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    await alice.chain.sync()
    await settle()
    vi.restoreAllMocks()
    await alice.chain.sync()
    await bob.chain.sync()

    const after = state()
    expect(after.kid).toBeDefined()
    expect(after.holders?.sort()).toEqual([alice.me, bob.me].sort())
    expect(after.company.name).toBe('Old Co')
    expect(after.tasks.map((t) => t.title)).toEqual(['Bob task'])
    // The deleted task still holds its number.
    expect(p().nextNumber).toBe(2)
    expect(bob.companies().get(companyId)!.tasks[0].title).toBe('Bob task')
    // Alice's profile moved into the organization, encrypted, and Bob still sees her name.
    await alice.chain.sync()
    expect(relay.events.some((e) => e.content.includes('Alice A'))).toBe(false)
    expect(profilesOf(relay.events, bob.keys()).get(alice.me)?.name).toBe('Alice A')
    // Each item's newest version is encrypted; only superseded plaintext copies remain.
    const newest = new Map<string, NostrEvent>()
    for (const e of relay.events) {
      const d = e.tags.find((t) => t[0] === 'd')![1]
      // The keyring is encrypted to its owner; the plaintext profile address ends up only marking a move.
      if (!d.startsWith('canban:') || d.startsWith('canban:keyring:') || d === `canban:profile:${e.pubkey}`) continue
      if ((newest.get(d)?.created_at ?? -1) < e.created_at) newest.set(d, e)
    }
    expect([...newest.values()].filter((e) => !e.tags.some((t) => t[0] === 'k')).map((e) => e.tags[0][1])).toEqual([])
    alice.chain.stop()
    bob.chain.stop()
  })

  it('stays readable when two of the owner’s tabs encrypt it at once', async () => {
    const relay = new Relay()
    const tabA = client(relay)
    const tabB = client(relay, undefined, tabA.sk)
    const bob = client(relay)
    const { companyId, writes } = commands.createCompany(tabA.me, 'Two Tabs')
    tabA.write(writes, companyId)
    tabA.write(commands.setMember(companyId, bob.me, 'member'), companyId)
    const { writes: project } = commands.createProject(companyId, 'Board', [bob.me])
    tabA.write(project, companyId)

    vi.spyOn(Math, 'random').mockReturnValue(0)
    await Promise.all([tabA.chain.sync(), tabB.chain.sync()])
    await settle()
    vi.restoreAllMocks()
    for (let i = 0; i < 2; i++) await Promise.all([tabA.chain.sync(), tabB.chain.sync(), bob.chain.sync()])

    const later = client(relay, undefined, tabA.sk)
    await later.chain.sync()
    for (const c of [later, bob]) {
      const state = c.companies().get(companyId)!
      expect(state.company.name).toBe('Two Tabs')
      expect(state.projects.map((p) => [p.name, p.locked])).toEqual([['Board', false]])
    }
    for (const c of [tabA, tabB, bob, later]) c.chain.stop()
  })

  it('hands out again a key another tab saved over', async () => {
    const relay = new Relay()
    const tabA = client(relay)
    const bob = client(relay)
    const { companyId, key: keyA } = await organization(relay, tabA)
    tabA.write(commands.setMember(companyId, bob.me, 'member'), companyId)
    const { writes: project } = commands.createProject(companyId, 'Board', [bob.me])
    tabA.write(project, companyId)
    await tabA.chain.sync()

    // Tab B made its own first key: its keyring, company event and envelopes replace tab A's.
    const keyB = newOrgKey()
    const cipher = {
      encrypt: async (peer: string, text: string) => nip44.v2.encrypt(text, nip44.v2.utils.getConversationKey(tabA.sk, peer)),
      decrypt: async (peer: string, text: string) => nip44.v2.decrypt(text, nip44.v2.utils.getConversationKey(tabA.sk, peer)),
    }
    const onlyB = new Map([[keyB.kid, keyB.key]])
    const rings = emptyKeyrings()
    rings.keys.set(companyId, onlyB)
    relay.add(finalizeEvent(await keyring(cipher, tabA.me, rings, clock++), tabA.sk))
    const state = tabA.companies().get(companyId)!
    relay.add(finalizeEvent(template({ type: 'company', companyId }, { name: 'Hidden Co', holders: [tabA.me, bob.me] }, clock++, keyB), tabA.sk))
    for (const pk of [tabA.me, bob.me]) relay.add(finalizeEvent(await envelope(cipher, companyId, pk, onlyB, clock++, keyB.kid), tabA.sk))
    expect(state.projects[0].name).toBe('Board')

    for (let i = 0; i < 3; i++) await tabA.chain.sync()
    await bob.chain.sync()
    const later = client(relay, undefined, tabA.sk)
    await later.chain.sync()
    for (const c of [bob, later]) expect(c.keys().has(keyA.kid) && c.keys().has(keyB.kid)).toBe(true)
    for (const c of [tabA, bob, later]) c.chain.stop()
  })

  it('never gives an organization a second key when only its encrypted events are missing', async () => {
    const relay = new Relay()
    const alice = client(relay)
    const { companyId } = await organization(relay, alice)
    // A relay withholding every encrypted company event: only an old plaintext one arrives.
    relay.events = relay.events.filter((e) => !e.tags.some((t) => t[0] === 'd' && t[1] === `canban:company:${companyId}`))
    relay.add(finalizeEvent(template({ type: 'company', companyId }, { name: 'Old' }, 1, undefined), alice.sk))
    const fresh = client(relay, undefined, alice.sk)
    const before = relay.events.length
    await fresh.chain.sync()
    await settle()
    expect(fresh.companies().get(companyId)!.kid).toBeUndefined()
    expect(relay.events.length).toBe(before)
    alice.chain.stop()
    fresh.chain.stop()
  })

  it('hands a new member the key, and replaces it when they are removed', async () => {
    const relay = new Relay()
    const alice = client(relay)
    const bob = client(relay)

    const { companyId, key } = await organization(relay, alice)
    expect(relay.events.every((e) => !e.content.includes('Hidden Co'))).toBe(true)

    alice.write(commands.setMember(companyId, bob.me, 'member'), companyId)
    await alice.chain.sync()
    expect(alice.companies().get(companyId)!.holders).toContain(bob.me)

    await bob.chain.sync()
    expect(bob.companies().get(companyId)!.company.name).toBe('Hidden Co')

    alice.write(commands.setMember(companyId, bob.me, 'removed'), companyId)
    expect(alice.companies().get(companyId)!.rotationDue).toBe(true)
    await alice.chain.sync()
    // The owner rotates at once.
    await new Promise((r) => setTimeout(r, 10))
    const after = alice.companies().get(companyId)!
    expect(after.kid).not.toBe(key.kid)
    expect(after.rotationDue).toBeUndefined()
    expect(after.company.name).toBe('Hidden Co')
    expect(after.holders).toEqual([alice.me])

    // Bob still holds only the old key.
    await bob.chain.sync()
    expect(bob.companies().get(companyId)?.locked ?? true).toBe(true)
    alice.chain.stop()
    bob.chain.stop()
  })

  it('sends an envelope again when it failed to go out', async () => {
    const relay = new Relay()
    let refuseEnvelopes = true
    const alice = client(relay, (e) => refuseEnvelopes && e.tags.some((t) => t[0] === 'd' && t[1].startsWith('canban:key:') && !t[1].endsWith(e.pubkey)))
    const bob = client(relay)
    const { companyId } = await organization(relay, alice)
    alice.write(commands.setMember(companyId, bob.me, 'member'), companyId)
    await alice.chain.sync()
    await bob.chain.sync()
    expect(bob.companies().get(companyId)!.locked).toBe(true)

    refuseEnvelopes = false
    // A refused organization waits a couple of minutes before its duties are tried again.
    const later = Date.now() + 3 * 60_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    await alice.chain.sync()
    vi.restoreAllMocks()
    await bob.chain.sync()
    expect(bob.companies().get(companyId)!.company.name).toBe('Hidden Co')
    alice.chain.stop()
    bob.chain.stop()
  })

  it('keeps writing after an admin who rewrote the company event is demoted', async () => {
    const relay = new Relay()
    const alice = client(relay)
    const bob = client(relay)
    const carol = client(relay)
    const { companyId } = await organization(relay, alice)
    alice.write(commands.setMember(companyId, bob.me, 'admin'), companyId)
    await alice.chain.sync()
    await bob.chain.sync()
    // Bob adds Carol: his client rewrites the company event, and Alice's client pins it.
    bob.write(commands.setMember(companyId, carol.me, 'member'), companyId)
    await bob.chain.sync()
    await alice.chain.sync()
    alice.write(commands.setMember(companyId, bob.me, 'member'), companyId)
    expect(() => alice.chain.keyFor(alice.companies().get(companyId)!)).not.toThrow()
    alice.chain.stop()
    bob.chain.stop()
    carol.chain.stop()
  })

  it('never saves over a keyring it could not read', async () => {
    const relay = new Relay()
    const alice = client(relay)
    await organization(relay, alice)
    const saved = () => relay.events.find((e) => e.pubkey === alice.me && e.tags.some((t) => t[0] === 'd' && t[1].startsWith('canban:keyring:')))!
    const before = saved().id

    // A second device whose signer refuses every decrypt.
    const phone = client(relay, undefined, alice.sk, () => true)
    for (let i = 0; i < 4; i++) await phone.chain.sync()
    await expect(phone.chain.adopt(`${alice.me}.second`, newOrgKey())).rejects.toThrow()
    expect(saved().id).toBe(before)
    alice.chain.stop()
    phone.chain.stop()
  })
})

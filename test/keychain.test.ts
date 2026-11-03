import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type NostrEvent } from 'nostr-tools'
import * as nip44 from 'nostr-tools/nip44'
import * as commands from '../src/domain/commands'
import type { Keyring } from '../src/domain/crypto'
import { template } from '../src/domain/entities'
import { Keychain } from '../src/domain/keychain'
import { newOrgKey } from '../src/domain/keys'
import { resolve } from '../src/domain/resolve'

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

function client(relay: Relay, refuse?: (e: NostrEvent) => boolean) {
  const sk = generateSecretKey()
  const me = getPublicKey(sk)
  const failures: unknown[] = []
  let keys: Keyring = new Map()
  const companies = () => resolve(relay.events, keys)
  const chain = new Keychain({
    me,
    companies,
    versions: (d) => relay.events.filter((e) => e.tags.some((t) => t[0] === 'd' && t[1] === d)),
    cipher: () => ({
      encrypt: async (peer, text) => nip44.v2.encrypt(text, nip44.v2.utils.getConversationKey(sk, peer)),
      decrypt: async (peer, text) => nip44.v2.decrypt(text, nip44.v2.utils.getConversationKey(sk, peer)),
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
  return { me, chain, companies, write, sk, failures }
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

describe('keychain', () => {
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
    await alice.chain.sync()
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
})

import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools'
import * as commands from '../src/domain/commands'
import { open, orgKey, type Keyring } from '../src/domain/crypto'
import { template } from '../src/domain/entities'
import { MAX_TASK_BODY } from '../src/domain/model'
import { resolve } from '../src/domain/resolve'

const ownerKey = generateSecretKey()
const owner = getPublicKey(ownerKey)
const alice = getPublicKey(generateSecretKey())
const key = orgKey(generateSecretKey())
const keyring: Keyring = new Map([[key.kid, key.key]])

let clock = 1000
const sign = (writes: commands.Write[], withKey = true): NostrEvent[] =>
  writes.map(({ address, content }) => finalizeEvent(template(address, content as never, clock++, withKey ? key : undefined), ownerKey))

function board() {
  const company = commands.createCompany(owner, 'Secret Co')
  const project = commands.createProject(company.companyId, 'Moonshot', [owner, alice])
  const events = sign([...company.writes, ...commands.setMember(company.companyId, alice, 'admin', 'Alice'), ...project.writes])
  const state = resolve(events, keyring).get(company.companyId)!
  const task = commands.createTask(state.projects[0], state.lanes[0].id, 'Launch plan', undefined, { body: 'Top secret' })
  return { companyId: company.companyId, events: [...events, ...sign(task.writes)] }
}

describe('encrypted content', () => {
  it('reads back with the key and hides everything without it', () => {
    const { companyId, events } = board()
    for (const e of events) expect(e.content).not.toMatch(/Secret Co|Moonshot|Launch plan|Top secret|Alice/)

    const open_ = resolve(events, keyring).get(companyId)!
    expect(open_.company.name).toBe('Secret Co')
    expect(open_.projects[0].name).toBe('Moonshot')
    expect(open_.tasks[0]).toMatchObject({ title: 'Launch plan', body: 'Top secret' })

    // Without the key, the organization, roles and assignees still resolve from signed tags.
    const locked = resolve(events).get(companyId)!
    expect(locked.company.name).toBe('')
    expect(locked.members.find((m) => m.pubkey === alice)?.role).toBe('admin')
    expect(locked.projects[0].members.sort()).toEqual([owner, alice].sort())
    expect(locked.tasks).toEqual([])
  })

  it('rejects ciphertext moved onto another item, and unknown keys', () => {
    const { events } = board()
    const task = events.at(-1)!
    const moved = finalizeEvent({ ...task, tags: task.tags.map((t) => (t[0] === 'd' ? ['d', t[1] + 'x'] : t)) }, ownerKey)
    expect(open(moved, keyring)).toBeUndefined()
    expect(open(task, new Map())).toBeUndefined()
    expect(open(task, keyring)).toMatchObject({ title: 'Launch plan' })
  })

  it('keeps plaintext events readable during migration', () => {
    const company = commands.createCompany(owner, 'Plain Co')
    expect(resolve(sign(company.writes, false)).get(company.companyId)?.company.name).toBe('Plain Co')
  })

  it('fits the longest body in a 64 KB event once encrypted', () => {
    const { companyId, events } = board()
    const state = resolve(events, keyring).get(companyId)!
    const task = commands.createTask(state.projects[0], state.lanes[0].id, 't'.repeat(200), undefined, { body: '漢'.repeat(MAX_TASK_BODY) })
    const [event] = sign(task.writes)
    expect(new TextEncoder().encode(JSON.stringify(event)).length).toBeLessThan(64 * 1024)
  })

  it('lets signed tags decide roles and assignees when content disagrees', () => {
    const company = commands.createCompany(owner, 'Tag Co')
    const bob = getPublicKey(generateSecretKey())
    const base = template({ type: 'member', companyId: company.companyId, pubkey: bob }, { role: 'removed' }, clock++, key)
    const mismatched = finalizeEvent({ ...base, tags: base.tags.map((t) => (t[0] === 'role' ? ['role', 'admin'] : t)) }, ownerKey)
    const state = resolve([...sign(company.writes), mismatched], keyring).get(company.companyId)!
    expect(state.members.find((m) => m.pubkey === bob)?.role).toBe('admin')
    const bogus = finalizeEvent({ ...base, tags: base.tags.map((t) => (t[0] === 'role' ? ['role', 'owner'] : t)) }, ownerKey)
    expect(resolve([...sign(company.writes), bogus], keyring).get(company.companyId)!.members.some((m) => m.pubkey === bob)).toBe(false)
  })

  it('marks content it cannot read as locked and refuses to write to it', () => {
    const { companyId, events } = board()
    const locked = resolve(events).get(companyId)!
    expect(locked.locked).toBe(true)
    expect(locked.kid).toBe(key.kid)
    expect(locked.projects[0].locked).toBe(true)
    expect(() => commands.createTask(locked.projects[0], 'x', 'New')).toThrow()
    expect(resolve(events, keyring).get(companyId)!.projects[0].locked).toBe(false)
  })

  it('refuses descriptions over the byte limit', () => {
    const { companyId, events } = board()
    const state = resolve(events, keyring).get(companyId)!
    expect(() => commands.createTask(state.projects[0], state.lanes[0].id, 'x', undefined, { body: '漢'.repeat(10_001) })).toThrow()
  })
})

describe('key rotation state', () => {
  const aliceKey = generateSecretKey()
  const admin = getPublicKey(aliceKey)
  const bob = getPublicKey(generateSecretKey())
  const byAlice = (writes: commands.Write[], k: typeof key | null = key) =>
    writes.map(({ address, content }) => finalizeEvent(template(address, content as never, clock++, k ?? undefined), aliceKey))
  const company = (companyId: string, holders: string[]) => [{ address: { type: 'company' as const, companyId }, content: { name: 'Rotate Co', holders } }]

  function org() {
    const c = commands.createCompany(owner, 'Rotate Co')
    const events = sign([...c.writes, ...commands.setMember(c.companyId, admin, 'admin'), ...commands.setMember(c.companyId, bob, 'member')])
    events.push(...sign(company(c.companyId, [owner, admin, bob]) as commands.Write[]))
    return { companyId: c.companyId, events }
  }

  it('asks for a new key once someone holding it is no longer a member', () => {
    const { companyId, events } = org()
    expect(resolve(events, keyring).get(companyId)!.rotationDue).toBeUndefined()
    events.push(...byAlice(commands.setMember(companyId, bob, 'removed')))
    expect(resolve(events, keyring).get(companyId)!.rotationDue).toBe(true)

    const next = orgKey(generateSecretKey())
    events.push(...byAlice(company(companyId, [owner, admin]) as commands.Write[], next))
    const rotated = resolve(events, new Map([...keyring, [next.kid, next.key]])).get(companyId)!
    expect(rotated.kid).toBe(next.kid)
    expect(rotated.company.name).toBe('Rotate Co')
    expect(rotated.rotationDue).toBeUndefined()
  })

  // The relay keeps only each author's newest copy of an address.
  const newestOnly = (events: NostrEvent[]) => {
    const newest = new Map<string, NostrEvent>()
    for (const e of events) {
      const k = `${e.pubkey}:${e.tags.find((t) => t[0] === 'd')![1]}`
      if ((newest.get(k)?.created_at ?? -1) < e.created_at) newest.set(k, e)
    }
    return [...newest.values()]
  }

  it('keeps the holders through a rename', () => {
    const { companyId, events } = org()
    events.push(...sign(commands.renameCompany(companyId, 'Renamed', resolve(events, keyring).get(companyId)!.holders)))
    events.push(...byAlice(commands.setMember(companyId, bob, 'removed')))
    const state = resolve(newestOnly(events), keyring).get(companyId)!
    expect(state.company.name).toBe('Renamed')
    expect(state.rotationDue).toBe(true)
  })

  it('counts holders listed by any admin for the current key', () => {
    const { companyId, events } = org()
    const carol = getPublicKey(generateSecretKey())
    events.push(...sign(commands.setMember(companyId, carol, 'member')))
    // Alice adds Carol while the owner's list doesn't have her: both lists count.
    events.push(...byAlice(company(companyId, [owner, admin, carol]) as commands.Write[]))
    events.push(...sign(commands.setMember(companyId, carol, 'removed')))
    expect(resolve(newestOnly(events), keyring).get(companyId)!.rotationDue).toBe(true)
  })

  it('does not rotate over a holder whose member event has not loaded', () => {
    const { companyId, events } = org()
    const partial = events.filter((e) => !e.tags.some((t) => t[0] === 'd' && t[1].endsWith(bob)))
    expect(resolve(partial, keyring).get(companyId)!.rotationDue).toBeUndefined()
  })

  it('ignores an admin’s plaintext company event: no downgrade, no hiding', () => {
    const { companyId, events } = org()
    events.push(...byAlice(commands.renameCompany(companyId, ''), null))
    const state = resolve(events, keyring).get(companyId)!
    expect(state.kid).toBe(key.kid)
    expect(state.company.name).toBe('Rotate Co')
  })
})

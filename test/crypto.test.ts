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

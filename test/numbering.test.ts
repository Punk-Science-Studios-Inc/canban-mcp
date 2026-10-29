import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools'
import * as commands from '../src/domain/commands'
import { template } from '../src/domain/entities'
import { resolve } from '../src/domain/resolve'

const ownerKey = generateSecretKey()
const owner = getPublicKey(ownerKey)
const aliceKey = generateSecretKey()
const alice = getPublicKey(aliceKey)

let clock = 1000
const sign = (writes: commands.Write[], key = ownerKey, at?: number): NostrEvent[] =>
  writes.map(({ address, content }) => finalizeEvent(template(address, content as never, at ?? clock++), key))

function setup() {
  const company = commands.createCompany(owner, 'Punk Science')
  const project = commands.createProject(company.companyId, 'Launch', [owner, alice])
  const events = sign([...company.writes, ...commands.setMember(company.companyId, alice, 'member'), ...project.writes])
  return { companyId: company.companyId, projectId: project.projectId, events }
}

const state = (events: NostrEvent[], companyId: string) => resolve(events).get(companyId)!
const projectOf = (events: NostrEvent[], companyId: string) => state(events, companyId).projects[0]
const lane = (events: NostrEvent[], companyId: string) => state(events, companyId).lanes[0].id

describe('ticket numbers', () => {
  it('starts a new project at 0 and counts up', () => {
    const { companyId, events } = setup()
    expect(projectOf(events, companyId).nextNumber).toBe(0)
    for (const title of ['a', 'b', 'c']) events.push(...sign(commands.createTask(projectOf(events, companyId), lane(events, companyId), title).writes))
    const numbers = Object.fromEntries(state(events, companyId).tasks.map((t) => [t.title, t.number]))
    expect(numbers).toEqual({ a: 0, b: 1, c: 2 })
  })

  it('never reuses the number of a deleted ticket', () => {
    const { companyId, events } = setup()
    events.push(...sign(commands.createTask(projectOf(events, companyId), lane(events, companyId), 'gone').writes))
    events.push(...sign(commands.updateTask(companyId, state(events, companyId).tasks[0], { removed: true })))
    expect(projectOf(events, companyId).nextNumber).toBe(1)
  })

  it('keeps the number through edits', () => {
    const { companyId, events } = setup()
    events.push(...sign(commands.createTask(projectOf(events, companyId), lane(events, companyId), 'a').writes))
    events.push(...sign(commands.updateTask(companyId, state(events, companyId).tasks[0], { title: 'renamed' })))
    expect(state(events, companyId).tasks[0]).toMatchObject({ title: 'renamed', number: 0 })
  })

  it('renumbers the later of two tickets that took the same number, by its creator only', () => {
    const { companyId, events } = setup()
    const before = projectOf(events, companyId)
    const laneId = lane(events, companyId)
    events.push(...sign(commands.createTask(before, laneId, 'mine first').writes, ownerKey, 5000))
    events.push(...sign(commands.createTask(before, laneId, 'alice second').writes, aliceKey, 5001))
    const clash = state(events, companyId)
    expect(clash.tasks.map((t) => t.number)).toEqual([0, 0])

    expect(commands.renumberings(clash, owner)).toEqual([])
    const fix = commands.renumberings(clash, alice)
    expect(fix).toHaveLength(1)
    events.push(...sign(fix, aliceKey, 6000))
    const healed = state(events, companyId)
    expect(Object.fromEntries(healed.tasks.map((t) => [t.title, t.number]))).toEqual({ 'mine first': 0, 'alice second': 1 })
    expect(commands.renumberings(healed, alice)).toEqual([])
  })
})

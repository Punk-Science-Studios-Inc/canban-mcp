import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SimplePool, nip19 } from 'nostr-tools'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as commands from '../src/domain/commands'
import { template } from '../src/domain/entities'
import { Board } from '../src/board'
import type { Identity } from '../src/identity'
import { registerTools } from '../src/tools'
import { startRelay, type TestRelay } from './relay'

const ownerKey = generateSecretKey()
const owner = getPublicKey(ownerKey)
const agentKey = generateSecretKey()
const agent: Identity = { secret: agentKey, pubkey: getPublicKey(agentKey), npub: nip19.npubEncode(getPublicKey(agentKey)), created: false }

let relay: TestRelay
let board: Board
let client: Client
let projectId = ''
let hiddenId = ''

async function seed(writes: commands.Write[]): Promise<void> {
  const pool = new SimplePool()
  pool.automaticallyAuth = () => async (e) => finalizeEvent(e, ownerKey)
  let at = Math.floor(Date.now() / 1000) - 100
  for (const { address, content } of writes) {
    const event = finalizeEvent(template(address, content as never, at++), ownerKey)
    await Promise.any(pool.publish([relay.url], event, { onauth: async (e) => finalizeEvent(e, ownerKey) }))
  }
  pool.destroy()
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as { text: string }[])[0].text
  return { isError: !!result.isError, text, json: () => JSON.parse(text) }
}

beforeAll(async () => {
  relay = await startRelay()
  relay.allow.add(owner)
  relay.allow.add(agent.pubkey)
  const company = commands.createCompany(owner, 'Punk Science')
  const project = commands.createProject(company.companyId, 'Canban launch', [owner, agent.pubkey])
  const hidden = commands.createProject(company.companyId, 'Secret plans', [owner])
  projectId = project.projectId
  hiddenId = hidden.projectId
  await seed([
    ...company.writes,
    ...commands.setMember(company.companyId, agent.pubkey, 'member', 'Claude'),
    ...project.writes,
    ...hidden.writes,
  ])

  board = new Board(relay.url, agentKey, [])
  board.start()
  const server = new McpServer({ name: 'canban', version: 'test' })
  registerTools(server, board, agent)
  const [a, b] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test', version: '1' })
  await Promise.all([server.connect(a), client.connect(b)])
})

afterAll(async () => {
  board?.stop()
  await relay?.close()
})

describe('canban-mcp', () => {
  it('knows who it is and what it belongs to', async () => {
    const me = (await call('whoami')).json()
    expect(me.relay).toBe('live')
    expect(me.companies[0].name).toBe('Punk Science')
    expect(me.companies[0].projects).toEqual(['Canban launch'])
  })

  it('only lists projects the agent is on', async () => {
    const projects = (await call('list_projects')).json()
    expect(projects.map((p: { name: string }) => p.name)).toEqual(['Canban launch'])
    expect((await call('get_board', { project: hiddenId })).isError).toBe(true)
  })

  it('creates, assigns, moves and deletes a task, and the owner sees each change', async () => {
    const created = (await call('create_task', { project: 'canban launch', title: 'Write the MCP docs', labels: ['Docs'], assignee: 'me' })).json()
    expect(created.lane).toBe('To do')

    await call('update_task', { task: created.created, body: '- tools\n- install' })
    const moved = (await call('move_task', { task: 'Write the MCP docs', lane: 'in progress', position: 'top' })).json()
    expect(moved.lane).toBe('In progress')

    const view = (await call('get_board', { project: projectId })).json()
    const inProgress = view.lanes.find((l: { name: string }) => l.name === 'In progress')
    expect(inProgress.tasks[0]).toMatchObject({ title: 'Write the MCP docs', labels: ['docs'], assignee: 'Claude', hasBody: true })

    const ownerView = await import('../src/domain/resolve').then(({ resolve }) => resolve(relay.events))
    const task = [...ownerView.values()][0].tasks.find((t) => t.title === 'Write the MCP docs')!
    expect(task.updatedBy).toBe(agent.pubkey)
    expect(task.body).toBe('- tools\n- install')

    await call('delete_task', { task: created.created })
    const after = (await call('get_board', { project: projectId })).json()
    expect(after.lanes.flatMap((l: { tasks: unknown[] }) => l.tasks)).toHaveLength(0)
  })

  it('adds and renames lanes', async () => {
    await call('create_lane', { project: 'Canban launch', name: 'Review' })
    await call('rename_lane', { project: 'Canban launch', lane: 'Review', name: 'QA' })
    const view = (await call('get_board', { project: 'Canban launch' })).json()
    expect(view.lanes.map((l: { name: string }) => l.name)).toEqual(['To do', 'In progress', 'Complete', 'QA'])
  })

  it('explains a bad reference instead of guessing', async () => {
    const result = await call('move_task', { task: 'nope', lane: 'Done' })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/No task matches "nope"/)
  })
})

describe('canban-mcp without access', () => {
  it('tells the user exactly which npub to add', async () => {
    const strangerKey = generateSecretKey()
    const stranger: Identity = { secret: strangerKey, pubkey: getPublicKey(strangerKey), npub: nip19.npubEncode(getPublicKey(strangerKey)), created: false }
    const lonely = new Board(relay.url, strangerKey, [])
    lonely.start()
    const server = new McpServer({ name: 'canban', version: 'test' })
    registerTools(server, lonely, stranger)
    const [a, b] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 'test', version: '1' })
    await Promise.all([server.connect(a), c.connect(b)])
    const result = await c.callTool({ name: 'list_projects', arguments: {} })
    expect(result.isError).toBe(true)
    expect((result.content as { text: string }[])[0].text).toContain(stranger.npub)
    lonely.stop()
  })
})

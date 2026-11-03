import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SimplePool, nip19, type EventTemplate } from 'nostr-tools'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import * as commands from '../src/domain/commands'
import { template } from '../src/domain/entities'
import { envelope, newOrgKey } from '../src/domain/keys'
import { Board } from '../src/board'
import type { Identity } from '../src/identity'
import { registerTools } from '../src/tools'
import { startRelay, type TestRelay } from './relay'

const ownerKey = generateSecretKey()
const owner = getPublicKey(ownerKey)
const agentKey = generateSecretKey()
const agent: Identity = { secret: agentKey, pubkey: getPublicKey(agentKey), npub: nip19.npubEncode(getPublicKey(agentKey)), created: false }
const key = newOrgKey()

let relay: TestRelay
let board: Board
let client: Client
let clock = Math.floor(Date.now() / 1000) - 100

async function publish(templates: EventTemplate[]): Promise<void> {
  const pool = new SimplePool()
  pool.automaticallyAuth = () => async (e) => finalizeEvent(e, ownerKey)
  for (const t of templates) {
    const event = finalizeEvent(t, ownerKey)
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
  const company = commands.createCompany(owner, 'Hidden Studio')
  const project = commands.createProject(company.companyId, 'Moonshot', [owner, agent.pubkey])
  const writes = [
    ...company.writes.map((w) => (w.address.type === 'company' ? { ...w, content: { ...w.content, holders: [owner, agent.pubkey] } } : w)),
    ...commands.setMember(company.companyId, agent.pubkey, 'member', 'Claude'),
    ...project.writes,
  ] as commands.Write[]
  const ownerCipher = {
    encrypt: async (peer: string, text: string) => nip44.v2.encrypt(text, nip44.v2.utils.getConversationKey(ownerKey, peer)),
    decrypt: async (peer: string, text: string) => nip44.v2.decrypt(text, nip44.v2.utils.getConversationKey(ownerKey, peer)),
  }
  await publish([
    ...writes.map(({ address, content }) => template(address, content as never, clock++, key)),
    await envelope(ownerCipher, company.companyId, agent.pubkey, new Map([[key.kid, key.key]]), clock++, key.kid),
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

describe('encrypted organizations', () => {
  it('reads them with the key from its envelope', async () => {
    const me = (await call('whoami')).json()
    expect(me.companies[0].name).toBe('Hidden Studio')
    expect(me.companies[0].projects).toEqual(['Moonshot'])
  })

  it('writes encrypted with the current key', async () => {
    const created = (await call('create_task', { project: 'Moonshot', title: 'Launch window' })).json()
    expect((await call('get_task', { task: created.created })).json().title).toBe('Launch window')
    const stored = relay.events.filter((e) => e.pubkey === agent.pubkey && e.tags.some((t) => t[0] === 'd' && t[1].startsWith('canban:task:')))
    expect(stored.length).toBeGreaterThan(0)
    for (const e of stored) {
      expect(e.tags).toContainEqual(['k', key.kid])
      expect(e.content).not.toContain('Launch window')
    }
  })
})

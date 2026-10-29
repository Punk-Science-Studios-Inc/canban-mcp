import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SimplePool } from 'nostr-tools'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as commands from '../src/domain/commands'
import { template } from '../src/domain/entities'
import { startRelay, type TestRelay } from './relay'

let relay: TestRelay
let client: Client
let stderr = ''
const keyFile = join(mkdtempSync(join(tmpdir(), 'canban-mcp-')), 'agent.nsec')

const whoami = async () => JSON.parse(((await client.callTool({ name: 'whoami', arguments: {} })).content as { text: string }[])[0].text)

beforeAll(async () => {
  relay = await startRelay()
  const transport = new StdioClientTransport({
    command: 'node',
    args: [join(__dirname, '..', 'dist', 'canban-mcp.mjs')],
    env: { ...process.env, CANBAN_RELAY: relay.url, CANBAN_KEY_FILE: keyFile } as Record<string, string>,
    stderr: 'pipe',
  })
  transport.stderr?.on('data', (d) => (stderr += d))
  client = new Client({ name: 'test', version: '1' })
  await client.connect(transport)
})

afterAll(async () => {
  await client?.close()
  await relay?.close()
})

it('starts working once access is granted, without reconnecting', async () => {
  const before = await whoami()
  expect(before.relay).toBe('denied')

  const ownerKey = generateSecretKey()
  const owner = getPublicKey(ownerKey)
  const agent = (await import('nostr-tools')).nip19.decode(before.npub as `npub1${string}`).data
  relay.allow.add(owner)
  relay.allow.add(agent)
  const company = commands.createCompany(owner, 'Punk Science')
  const project = commands.createProject(company.companyId, 'Launch', [owner, agent])
  const pool = new SimplePool()
  pool.automaticallyAuth = () => async (e) => finalizeEvent(e, ownerKey)
  let at = Math.floor(Date.now() / 1000)
  for (const { address, content } of [...company.writes, ...commands.setMember(company.companyId, agent, 'member', 'Bot'), ...project.writes]) {
    await Promise.any(pool.publish([relay.url], finalizeEvent(template(address, content as never, at++), ownerKey), { onauth: async (e) => finalizeEvent(e, ownerKey) }))
  }
  pool.destroy()

  const deadline = Date.now() + 25_000
  let after = await whoami()
  while (after.relay !== 'live' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    after = await whoami()
  }
  console.error(`recovered after ${Math.round((25_000 - (deadline - Date.now())) / 1000)}s; stderr: ${stderr.trim()}`)
  expect(after.relay).toBe('live')
  expect(after.companies[0]?.projects).toEqual(['Launch'])
}, 40_000)

it('keeps working after the relay restarts', async () => {
  const port = Number(new URL(relay.url).port)
  const { events, allow } = relay
  await relay.close()
  await new Promise((r) => setTimeout(r, 2000))
  relay = await startRelay(port, events, allow)

  const deadline = Date.now() + 30_000
  let me = await whoami()
  let board = await client.callTool({ name: 'list_projects', arguments: {} })
  while ((me.relay !== 'live' || board.isError) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    me = await whoami()
    board = await client.callTool({ name: 'list_projects', arguments: {} })
  }
  const created = await client.callTool({ name: 'create_task', arguments: { project: 'Launch', title: 'After restart' } })
  console.error(`after restart: relay=${me.relay} createError=${created.isError} ${(created.content as { text: string }[])[0].text.slice(0, 120)}`)
  expect(me.relay).toBe('live')
  expect(created.isError).toBeFalsy()
}, 60_000)

#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Board } from './board'
import { loadIdentity } from './identity'
import { INSTRUCTIONS, registerTools } from './tools'

const RELAY = process.env.CANBAN_RELAY ?? 'wss://relay.punkscience.ca'

if (process.argv.includes('--whoami')) {
  const me = loadIdentity()
  console.log(me.npub)
  if (me.created) console.error(`New agent key saved to ${me.keyFile}. Add the npub above on Canban's People page.`)
  process.exit(0)
}

const me = loadIdentity()
if (me.created) console.error(`canban-mcp: new agent key saved to ${me.keyFile}. Add ${me.npub} on Canban's People page.`)

const board = new Board(RELAY, me.secret)
board.start()

const server = new McpServer({ name: 'canban', version: '0.1.0' }, { instructions: INSTRUCTIONS })
registerTools(server, board, me)
await server.connect(new StdioServerTransport())

const shutdown = () => {
  board.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.stdin.on('close', shutdown)

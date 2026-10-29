import { WebSocketServer, type WebSocket } from 'ws'
import { matchFilter, verifyEvent, type Filter, type NostrEvent } from 'nostr-tools'
import { parseD } from '../src/domain/entities'
import { canSee } from '../src/domain/model'
import { resolve } from '../src/domain/resolve'

export interface TestRelay {
  url: string
  events: NostrEvent[]
  allow: Set<string>
  close: () => Promise<void>
}

// The same rule as ps-relay's canban.go: a company's events go to its members, a project's to
// its admins and assigned members, and authors always see their own.
function visible(viewer: string, event: NostrEvent, events: NostrEvent[]): boolean {
  const d = event.tags.find((t) => t[0] === 'd')?.[1] ?? ''
  if (event.kind !== 30078 || !d.startsWith('canban:') || event.pubkey === viewer) return true
  const address = parseD(d)
  const state = address && resolve(events).get(address.companyId)
  if (!address || !state || !state.members.some((m) => m.pubkey === viewer)) return false
  if (address.type === 'company' || address.type === 'member') return true
  const project = state.projects.find((p) => p.id === address.projectId)
  return project ? canSee(state, project, viewer) : state.members.some((m) => m.pubkey === viewer && m.role !== 'member')
}

export async function startRelay(port = 0, events: NostrEvent[] = [], allow = new Set<string>()): Promise<TestRelay> {
  const wss = new WebSocketServer({ port })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`
  const subs = new Map<WebSocket, Map<string, Filter[]>>()
  const authed = new Map<WebSocket, string>()

  wss.on('connection', (ws) => {
    const challenge = Math.random().toString(36).slice(2)
    subs.set(ws, new Map())
    ws.send(JSON.stringify(['AUTH', challenge]))
    const member = () => {
      const pk = authed.get(ws)
      if (!pk) return 'auth-required: test relay'
      if (!allow.has(pk)) return 'restricted: not a member'
      return ''
    }
    ws.on('message', (raw) => {
      const [type, ...rest] = JSON.parse(raw.toString())
      if (type === 'AUTH') {
        const event = rest[0] as NostrEvent
        const ok = verifyEvent(event) && event.kind === 22242 && event.tags.some((t) => t[0] === 'challenge' && t[1] === challenge)
        if (ok) authed.set(ws, event.pubkey)
        ws.send(JSON.stringify(['OK', event.id, ok, ok ? '' : 'invalid: auth']))
      } else if (type === 'REQ') {
        const [id, ...filters] = rest as [string, ...Filter[]]
        const refused = member()
        if (refused) return ws.send(JSON.stringify(['CLOSED', id, refused]))
        subs.get(ws)!.set(id, filters)
        const viewer = authed.get(ws)!
        for (const e of events) if (filters.some((f) => matchFilter(f, e)) && visible(viewer, e, events)) ws.send(JSON.stringify(['EVENT', id, e]))
        ws.send(JSON.stringify(['EOSE', id]))
      } else if (type === 'CLOSE') {
        subs.get(ws)!.delete(rest[0])
      } else if (type === 'EVENT') {
        const event = rest[0] as NostrEvent
        const refused = member() || (verifyEvent(event) ? '' : 'invalid: signature')
        if (refused) return ws.send(JSON.stringify(['OK', event.id, false, refused]))
        events.push(event)
        ws.send(JSON.stringify(['OK', event.id, true, '']))
        for (const [peer, peerSubs] of subs) {
          const viewer = authed.get(peer)
          if (!viewer || !visible(viewer, event, events)) continue
          for (const [id, filters] of peerSubs) if (filters.some((f) => matchFilter(f, event))) peer.send(JSON.stringify(['EVENT', id, event]))
        }
      }
    })
    ws.on('close', () => {
      subs.delete(ws)
      authed.delete(ws)
    })
  })

  return {
    url,
    events,
    allow,
    close: () =>
      new Promise((r) => {
        for (const ws of wss.clients) ws.terminate()
        wss.close(() => r())
      }),
  }
}

import { SimplePool, type NostrEvent } from 'nostr-tools'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { dOf, template } from './domain/entities'
import { APP_TAG, KIND, visibilityKey, type CompanyState } from './domain/model'
import { resolve } from './domain/resolve'
import { renumberings, type Write } from './domain/commands'

export type Connection = 'connecting' | 'live' | 'denied' | 'offline'

const READY_TIMEOUT = 10_000
const RETRY_MS = 3_000
const RESUBSCRIBE_MS = 400
export const PROFILE_RELAYS = ['wss://purplepag.es', 'wss://relay.primal.net', 'wss://relay.damus.io', 'wss://nos.lol']

export class Board {
  connection: Connection = 'connecting'
  lastError = ''
  private events = new Map<string, NostrEvent>()
  private newestByD = new Map<string, number>()
  private pool = new SimplePool({ enablePing: true, enableReconnect: true })
  private profiles = new Map<string, string>()
  private loaded = false
  private waiters: (() => void)[] = []
  private sub?: { close: () => void }
  private closed = false
  private me: string
  private visible = ''
  private recheck?: ReturnType<typeof setTimeout>

  constructor(
    private relay: string,
    private secret: Uint8Array,
    private profileRelays: string[] = PROFILE_RELAYS,
  ) {
    this.me = getPublicKey(secret)
    this.pool.automaticallyAuth = () => (event) => Promise.resolve(finalizeEvent(event, this.secret))
  }

  start(): void {
    this.sub = this.pool.subscribe([this.relay], { kinds: [KIND], '#t': [APP_TAG] }, {
      onauth: async (event) => finalizeEvent(event, this.secret),
      onevent: (event) => this.add(event),
      oneose: () => {
        this.connection = 'live'
        this.visible = visibilityKey(this.companies(), this.me)
        this.markLoaded()
      },
      onclose: (reasons) => {
        const reason = reasons.map((r) => r.reason).join('; ')
        if (this.closed || reason.includes('closed by caller')) return
        this.lastError = reason
        this.connection = /restricted|auth-required/i.test(reason) ? 'denied' : 'offline'
        this.markLoaded()
        setTimeout(() => !this.closed && this.start(), this.connection === 'denied' ? RETRY_MS * 5 : RETRY_MS)
      },
    })
  }

  stop(): void {
    this.closed = true
    clearTimeout(this.recheck)
    this.sub?.close()
    this.pool.destroy()
  }

  async ready(): Promise<void> {
    if (this.loaded) return
    await Promise.race([new Promise<void>((r) => this.waiters.push(r)), new Promise<void>((r) => setTimeout(r, READY_TIMEOUT))])
  }

  companies(): Map<string, CompanyState> {
    return resolve(this.events.values())
  }

  async apply(writes: Write[]): Promise<void> {
    for (const { address, content } of writes) {
      const d = dOf(address)
      const createdAt = Math.max(Math.floor(Date.now() / 1000), (this.newestByD.get(d) ?? 0) + 1)
      const event = finalizeEvent(template(address, content as never, createdAt), this.secret)
      this.add(event)
      await Promise.any(this.pool.publish([this.relay], event, { onauth: async (e) => finalizeEvent(e, this.secret) })).catch((error: unknown) => {
        const reason = error instanceof AggregateError ? error.errors[0] : error
        throw new Error(`The relay refused the write: ${reason instanceof Error ? reason.message : String(reason)}`)
      })
    }
  }

  async names(pubkeys: string[]): Promise<Map<string, string>> {
    const missing = pubkeys.filter((pk) => !this.profiles.has(pk))
    if (missing.length && this.profileRelays.length) {
      const events = await this.pool.querySync(this.profileRelays, { kinds: [0], authors: missing }, { maxWait: 3000 }).catch(() => [])
      const newest = new Map<string, NostrEvent>()
      for (const e of events) if ((newest.get(e.pubkey)?.created_at ?? -1) < e.created_at) newest.set(e.pubkey, e)
      for (const pk of missing) {
        try {
          const meta = JSON.parse(newest.get(pk)?.content ?? '{}')
          this.profiles.set(pk, meta.display_name || meta.name || '')
        } catch {
          this.profiles.set(pk, '')
        }
      }
    }
    return new Map(pubkeys.map((pk) => [pk, this.profiles.get(pk) ?? '']))
  }

  private add(event: NostrEvent): void {
    if (this.events.has(event.id)) return
    this.events.set(event.id, event)
    const d = event.tags.find((t) => t[0] === 'd')?.[1]
    if (d) this.newestByD.set(d, Math.max(this.newestByD.get(d) ?? 0, event.created_at))
    if (this.loaded) this.scheduleRecheck()
  }

  // The relay only serves what this agent may see, so gaining a company or project means
  // asking again for what it already holds.
  private scheduleRecheck(): void {
    clearTimeout(this.recheck)
    this.recheck = setTimeout(() => {
      void this.healNumbers()
      const key = visibilityKey(this.companies(), this.me)
      if (key === this.visible || this.closed) return
      this.visible = key
      this.sub?.close()
      this.start()
    }, RESUBSCRIBE_MS)
  }

  private healing = false

  private async healNumbers(): Promise<void> {
    if (this.healing || this.connection !== 'live') return
    const writes = [...this.companies().values()].flatMap((state) => renumberings(state, this.me))
    if (!writes.length) return
    this.healing = true
    try {
      await this.apply(writes)
    } catch {
      return
    } finally {
      this.healing = false
    }
  }

  private markLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    this.waiters.splice(0).forEach((w) => w())
  }
}

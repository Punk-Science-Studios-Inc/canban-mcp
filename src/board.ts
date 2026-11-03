import type { NostrEvent } from 'nostr-tools'
// Pool and WebSocket setting from the same module: the 'nostr-tools' entry bundles its own copy.
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
import WebSocket from 'ws'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { dOf, template } from './domain/entities'
import { visibilityKey, type CompanyState } from './domain/model'
import { canbanFilters, companiesNaming } from './domain/subscription'
import { resolve } from './domain/resolve'
import { renumberings, retaggings, type Write } from './domain/commands'
import { blockedWrite, subscriptionListOf, type SubscriptionList } from './domain/entitlements'
import * as nip44 from 'nostr-tools/nip44'
import type { Keyring } from './domain/crypto'
import { Keychain } from './domain/keychain'

export type Connection = 'connecting' | 'live' | 'denied' | 'offline'

const READY_TIMEOUT = 10_000
const RETRY_MS = 3_000
const RESUBSCRIBE_MS = 400
// A live subscription can go quiet without closing (a dropped socket the relay never reports),
// so a read after this long asks the relay again in full.
const STALE_MS = 30_000
// Node's built-in WebSocket fires `error` synchronously from close() while connecting, and
// nostr-tools closes from its error handler, so a failed connect recursed until the stack overflowed.
useWebSocketImplementation(WebSocket)

export const PROFILE_RELAYS = ['wss://purplepag.es', 'wss://relay.primal.net', 'wss://relay.damus.io', 'wss://nos.lol']

export class Board {
  connection: Connection = 'connecting'
  lastError = ''
  private events = new Map<string, NostrEvent>()
  private newestByD = new Map<string, number>()
  // No automatic reconnect: nostr-tools resumes with `since` = the newest event seen, which drops
  // anything stamped earlier. A dropped connection closes the subscription and start() asks again.
  private pool = new SimplePool({ enablePing: true, enableReconnect: false })
  private profiles = new Map<string, string>()
  private loaded = false
  private loadedAt = 0
  private waiters: (() => void)[] = []
  private sub?: { close: () => void }
  private closed = false
  private me: string
  private visible = ''
  // Counts subscriptions; callbacks from one already closed (nostr-tools fires oneose on close) are ignored.
  private generation = 0
  // Organizations events show this agent is in; the subscription asks for each separately (the
  // relay caps results per filter before filtering them per agent).
  private known = new Set<string>()
  private recheck?: ReturnType<typeof setTimeout>
  // Organization keys this agent holds, opened from its envelopes and keyring (domain/keychain.ts).
  private keys: Keyring = new Map()
  private keychain: Keychain

  constructor(
    private relay: string,
    private secret: Uint8Array,
    private profileRelays: string[] = PROFILE_RELAYS,
  ) {
    this.me = getPublicKey(secret)
    this.pool.automaticallyAuth = () => (event) => Promise.resolve(finalizeEvent(event, this.secret))
    const conversation = (peer: string) => nip44.v2.utils.getConversationKey(this.secret, peer)
    this.keychain = new Keychain({
      me: this.me,
      companies: () => (this.loaded ? this.companies() : undefined),
      versions: (d) => [...this.events.values()].filter((e) => e.tags.some((t) => t[0] === 'd' && t[1] === d)),
      cipher: () => ({
        encrypt: async (peer, text) => nip44.v2.encrypt(text, conversation(peer)),
        decrypt: async (peer, text) => nip44.v2.decrypt(text, conversation(peer)),
      }),
      sign: async (unsigned) => finalizeEvent(unsigned, this.secret),
      // Kept only once the relay accepts it, so a refused key change is never taken as current.
      send: (event) => this.send(event, false),
      nextTimestamp: (d) => this.nextTimestamp(d),
      nextTimestampIn: (companyId) => {
        let newest = 0
        for (const [d, at] of this.newestByD) if (d.includes(`:${companyId}`)) newest = Math.max(newest, at)
        return Math.max(Math.floor(Date.now() / 1000), newest + 1)
      },
      setKeys: (keys) => (this.keys = keys),
      report: (outcome, error) => {
        if (outcome === 'failed') this.lastError = `Organization keys: ${error instanceof Error ? error.message : String(error)}`
        else if (this.lastError.startsWith('Organization keys:')) this.lastError = ''
      },
    })
  }

  private subscriptionKey(): string {
    return `${visibilityKey(this.companies(), this.me)}|${[...this.known].sort().join(',')}`
  }

  start(): void {
    const openedFor = this.subscriptionKey()
    const generation = ++this.generation
    const current = () => !this.closed && generation === this.generation
    const filters = canbanFilters(this.me, this.known, [])
    this.sub = this.pool.subscribeMap(filters.map((filter) => ({ url: this.relay, filter })), {
      onauth: async (event) => finalizeEvent(event, this.secret),
      onevent: (event) => this.add(event),
      oneose: () => {
        if (!current()) return
        this.connection = 'live'
        this.visible = this.subscriptionKey()
        // Learned of organizations the subscription didn't cover yet: ask again before counting as loaded.
        if (this.visible !== openedFor) {
          this.sub?.close()
          this.start()
          return
        }
        this.loadedAt = Date.now()
        this.markLoaded()
      },
      onclose: (reasons) => {
        const reason = reasons.map((r) => r.reason).join('; ')
        if (!current() || reason.includes('closed by caller')) return
        this.lastError = reason
        this.connection = /restricted|auth-required/i.test(reason) ? 'denied' : 'offline'
        this.markLoaded()
        setTimeout(() => !this.closed && this.start(), this.connection === 'denied' ? RETRY_MS * 5 : RETRY_MS)
      },
    })
  }

  stop(): void {
    this.keychain.stop()
    this.closed = true
    clearTimeout(this.recheck)
    this.sub?.close()
    this.pool.destroy()
  }

  async ready(): Promise<void> {
    if (this.loaded && this.connection === 'live' && Date.now() - this.loadedAt > STALE_MS) {
      this.loaded = false
      this.sub?.close()
      this.start()
    }
    if (!this.loaded) await Promise.race([new Promise<void>((r) => this.waiters.push(r)), new Promise<void>((r) => setTimeout(r, READY_TIMEOUT))])
    // Opens any organization key that arrived, so encrypted boards read at once.
    await this.keychain.settled()
  }

  companies(): Map<string, CompanyState> {
    return resolve(this.events.values(), this.keys)
  }

  subscriptions(): SubscriptionList | undefined {
    return subscriptionListOf(this.events.values())
  }

  async apply(writes: Write[]): Promise<void> {
    const companies = this.companies()
    const list = this.subscriptions()
    for (const write of writes) {
      const state = companies.get(write.address.companyId)
      const blocked = state && blockedWrite(state, list, write)
      if (blocked) throw new Error(blocked)
    }
    for (const { address, content } of writes) {
      const state = companies.get(address.companyId)
      // Encrypted with the organization's current key; refused while this agent can't open it.
      const key = state && this.keychain.keyFor(state)
      await this.send(finalizeEvent(template(address, content as never, this.nextTimestamp(dOf(address)), key), this.secret))
    }
  }

  private nextTimestamp(d: string): number {
    return Math.max(Math.floor(Date.now() / 1000), (this.newestByD.get(d) ?? 0) + 1)
  }

  // Optimistic writes show at once; the keychain's are kept only once accepted.
  private async send(event: NostrEvent, optimistic = true): Promise<void> {
    if (optimistic) this.add(event)
    await Promise.any(this.pool.publish([this.relay], event, { onauth: async (e) => finalizeEvent(e, this.secret) })).catch((error: unknown) => {
      const reason = error instanceof AggregateError ? error.errors[0] : error
      throw new Error(`The relay refused the write: ${reason instanceof Error ? reason.message : String(reason)}`)
    })
    if (!optimistic) this.add(event)
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
    for (const c of companiesNaming(this.me, event)) this.known.add(c)
    this.keychain.schedule()
    if (this.loaded) this.scheduleRecheck()
  }

  // The relay only serves what this agent may see, so gaining a company or project means
  // asking again for what it already holds.
  private scheduleRecheck(): void {
    clearTimeout(this.recheck)
    this.recheck = setTimeout(() => {
      void this.healNumbers()
      const key = this.subscriptionKey()
      if (key === this.visible || this.closed) return
      this.visible = key
      this.sub?.close()
      this.start()
    }, RESUBSCRIBE_MS)
  }

  private healing = false

  private async healNumbers(): Promise<void> {
    if (this.healing || this.connection !== 'live') return
    const writes = [...this.companies().values()].flatMap((state) => [...renumberings(state, this.me), ...retaggings(state, this.me)])
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

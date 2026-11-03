import type { EventTemplate, NostrEvent } from 'nostr-tools'
import * as commands from './commands'
import type { Keyring, OrgKey } from './crypto'
import { template } from './entities'
import {
  emptyKeyrings,
  envelope,
  envelopeD,
  flatten,
  keyring,
  keyringD,
  merge,
  mergeKeyrings,
  noteCurrent,
  openEnvelope,
  openKeyring,
  rotation,
  writeKey,
  type Cipher,
  type Keyrings,
} from './keys'
import { isAdmin, type CompanyState } from './model'

// Opens, hands out and replaces organization keys in the background, so nobody ever sees one
// (docs/encryption.md). Shared by the web app and canban-mcp, which each supply a host. Keys live
// only in memory and in the person's keyring on the relay, encrypted to them; the host may also keep
// the newest key id seen per organization (pins), so a relay can't roll an organization back.

export interface KeychainHost {
  me: string
  // Resolved organizations, or undefined until everything has loaded.
  companies(): Map<string, CompanyState> | undefined
  // Versions held of one address.
  versions(d: string): NostrEvent[]
  // NIP-44 with the person's key, or undefined when their signer can't.
  cipher(): Cipher | undefined
  sign(unsigned: EventTemplate): Promise<NostrEvent>
  // Keeps an event locally and publishes it.
  send(event: NostrEvent): Promise<void>
  nextTimestamp(d: string): number
  // Later than anything seen in an organization.
  nextTimestampIn(companyId: string): number
  // Every key now held, for reading.
  setKeys(keys: Keyring): void
  // After each pass: whether keys could be handled, and why not.
  report(outcome: 'ok' | 'cant-decrypt' | 'failed', error?: unknown): void
  savePins?(pins: Keyrings['current']): void
}

const SYNC_MS = 300
// Admins other than the owner wait a little before replacing a key, so usually only one does.
const ROTATE_DELAY_MS = [5_000, 30_000]

export class Keychain {
  private keyrings: Keyrings = emptyKeyrings()
  private opened = new Set<string>()
  private timer?: ReturnType<typeof setTimeout>
  private busy = false
  private again = false
  private stopped = false
  private rotations = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private host: KeychainHost,
    pins?: Keyrings['current'],
  ) {
    for (const [companyId, pin] of pins ?? []) this.keyrings.current.set(companyId, pin)
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.rotations.forEach(clearTimeout)
    this.rotations.clear()
  }

  // Call whenever events arrive; passes are debounced.
  schedule(): void {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.sync(), SYNC_MS)
  }

  // The key to encrypt a write to this organization with; throws when it can't be written yet.
  keyFor(state: CompanyState): OrgKey | undefined {
    return writeKey(state, this.keyrings)
  }

  // A new organization's key: held at once, so its first writes are encrypted with it.
  adopt(companyId: string, key: OrgKey): void {
    merge(this.keyrings, companyId, new Map([[key.kid, key.key]]))
    this.host.setKeys(flatten(this.keyrings))
  }

  // Puts a new organization's key in its owner's own envelope and keyring.
  async share(companyId: string, key: OrgKey): Promise<void> {
    const cipher = this.host.cipher()
    if (!cipher) return
    const me = this.host.me
    await this.publish(await envelope(cipher, companyId, me, new Map([[key.kid, key.key]]), this.host.nextTimestamp(envelopeD(companyId, me))))
    await this.saveKeyring(cipher)
  }

  async sync(): Promise<void> {
    if (this.stopped) return
    if (this.busy) {
      this.again = true
      return
    }
    const companies = this.host.companies()
    if (!companies) return
    if (![...companies.values()].some((s) => s.kid || s.locked)) return this.host.report('ok')
    const cipher = this.host.cipher()
    if (!cipher) return this.host.report('cant-decrypt')
    this.busy = true
    try {
      await this.open(cipher, companies)
      this.host.report('ok')
      await this.duties(cipher, this.host.companies() ?? companies)
    } catch (error) {
      this.host.report('failed', error)
    } finally {
      this.busy = false
      if (this.again) {
        this.again = false
        this.schedule()
      }
    }
  }

  // Reads the keyring, then any envelope for a key still missing.
  private async open(cipher: Cipher, companies: Map<string, CompanyState>): Promise<void> {
    const me = this.host.me
    let changed = false
    let save = false
    for (const event of this.host.versions(keyringD(me))) {
      if (this.opened.has(event.id)) continue
      this.opened.add(event.id)
      changed = mergeKeyrings(this.keyrings, await openKeyring(cipher, event, me)) || changed
    }
    for (const state of companies.values()) {
      const id = state.company.id
      if (!state.kid || this.keyrings.keys.get(id)?.has(state.kid)) continue
      for (const event of this.host.versions(envelopeD(id, me))) {
        if (this.opened.has(event.id)) continue
        const keys = await openEnvelope(cipher, event, state, me)
        // An envelope from someone not (yet) an admin is tried again later.
        if (keys.size || isAdmin(state, event.pubkey)) this.opened.add(event.id)
        if (merge(this.keyrings, id, keys)) changed = save = true
      }
    }
    let pinned = false
    for (const state of companies.values()) pinned = noteCurrent(this.keyrings, state) || pinned
    if (pinned) this.host.savePins?.(this.keyrings.current)
    if (changed) this.host.setKeys(flatten(this.keyrings))
    if (save) await this.saveKeyring(cipher)
  }

  // What an admin's client does unasked: hand the key to new members, replace it after a removal.
  private async duties(cipher: Cipher, companies: Map<string, CompanyState>): Promise<void> {
    const me = this.host.me
    for (const state of companies.values()) {
      const id = state.company.id
      if (!state.kid || state.locked || !isAdmin(state, me) || !this.keyrings.keys.get(id)?.has(state.kid)) continue
      if (state.rotationDue) {
        this.planRotation(state)
        continue
      }
      const holders = state.holders ?? []
      const missing = state.members.map((m) => m.pubkey).filter((pk) => !holders.includes(pk))
      if (!missing.length) continue
      // Listed as holders first, so nobody ever holds the key without being listed.
      const [{ address, content }] = commands.renameCompany(id, state.company.name, [...holders, ...missing])
      await this.publish(template(address, content as never, this.host.nextTimestamp(`canban:company:${id}`), this.keyFor(state)))
      const history = this.keyrings.keys.get(id)!
      for (const pk of missing) await this.publish(await envelope(cipher, id, pk, history, this.host.nextTimestamp(envelopeD(id, pk))))
    }
  }

  private planRotation(state: CompanyState): void {
    const id = state.company.id
    if (this.rotations.has(id)) return
    const [min, max] = ROTATE_DELAY_MS
    const delay = state.company.owner === this.host.me ? 0 : min + Math.random() * (max - min)
    this.rotations.set(
      id,
      setTimeout(() => {
        this.rotations.delete(id)
        void this.rotate(id)
      }, delay),
    )
  }

  private async rotate(companyId: string): Promise<void> {
    const state = this.host.companies()?.get(companyId)
    const cipher = this.host.cipher()
    // Another admin may have replaced it meanwhile.
    if (this.stopped || !state?.rotationDue || !cipher) return
    if (this.busy) return this.planRotation(state)
    this.busy = true
    try {
      const r = rotation(state, this.keyrings, this.host.me)
      merge(this.keyrings, companyId, r.history)
      this.host.setKeys(flatten(this.keyrings))
      // Saved before anything names the new key, so it can't be lost.
      await this.saveKeyring(cipher)
      const { address, content } = r.company
      await this.publish(template(address, content as never, this.host.nextTimestampIn(companyId), r.key))
      for (const pk of r.recipients) await this.publish(await envelope(cipher, companyId, pk, r.history, this.host.nextTimestamp(envelopeD(companyId, pk))))
    } catch (error) {
      this.host.report('failed', error)
    } finally {
      this.busy = false
      this.schedule()
    }
  }

  private async saveKeyring(cipher: Cipher): Promise<void> {
    // Every copy seen is merged in first: saving replaces it.
    const me = this.host.me
    const event = await this.host.sign(await keyring(cipher, me, this.keyrings, this.host.nextTimestamp(keyringD(me))))
    this.opened.add(event.id)
    await this.host.send(event)
  }

  private async publish(unsigned: EventTemplate): Promise<void> {
    await this.host.send(await this.host.sign(unsigned))
  }
}

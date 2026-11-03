import type { EventTemplate, NostrEvent } from 'nostr-tools'
import * as commands from './commands'
import { isEncrypted, kidTag, open, orgKey, type Keyring, type OrgKey } from './crypto'
import { dOf, template, type CompanyContent } from './entities'
import {
  emptyKeyrings,
  envelope,
  envelopeD,
  envelopeKids,
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
import { reencryptions } from './migration'
import { movedTemplate, orgProfileD, profileD, profilesOf, profileTemplate, sameProfile } from './profile'
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
  // Every event held for one organization.
  eventsIn(companyId: string): NostrEvent[]
  // NIP-44 with the person's key, or undefined when their signer can't.
  cipher(): Cipher | undefined
  sign(unsigned: EventTemplate): Promise<NostrEvent>
  // Publishes an event and keeps it locally only once the relay has accepted it.
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
const RETRY_MS = 15_000
// An event the signer keeps failing to decrypt is given up on for the session after this many tries.
const MAX_TRIES = 3
// Admins other than the owner wait a little before replacing a key, so usually only one does.
const ROTATE_DELAY_MS = [5_000, 30_000]
const BUSY_RETRY_MS = 2_000
const FIRST_KEY_SPREAD_MS = 5_000
// Items left in plaintext from before an organization was encrypted are written again this many at a
// time, then a pause: 60 a minute, the relay's limit for keys that aren't relay members.
const REENCRYPT_BATCH = 30
const REENCRYPT_PAUSE_MS = 30_000

class Stopped extends Error {}
// The relay refused a write: not the signer's fault, and retried only after REFUSED_BACKOFF_MS.
class Refused extends Error {}
const REFUSED_BACKOFF_MS = 2 * 60_000

export class Keychain {
  private keyrings: Keyrings = emptyKeyrings()
  // Events read (or not worth reading), failed attempts at the others, and ones given up on.
  private opened = new Set<string>()
  private tries = new Map<string, number>()
  private givenUp = new Set<string>()
  // Organizations whose key duties the relay refused, until when.
  private backoff = new Map<string, number>()
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private again = false
  private stopped = false
  private rotations = new Map<string, ReturnType<typeof setTimeout>>()
  // Organizations being re-encrypted, and when the next batch may go.
  private reencrypting = new Map<string, number>()
  private keyringStale = false

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
  schedule(delay = SYNC_MS): void {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.sync(), delay)
  }

  // The key to encrypt a write to this organization with; throws when it can't be written yet.
  keyFor(state: CompanyState): OrgKey | undefined {
    return writeKey(state, this.keyrings)
  }

  // A new organization: its key is saved to the owner's keyring and envelope before anything is
  // encrypted with it, so it can't be lost, then held for the first writes.
  async adopt(companyId: string, key: OrgKey): Promise<void> {
    const cipher = this.host.cipher()
    if (!cipher) throw new Error('This sign-in can’t create encrypted organizations.')
    await this.settled()
    await this.readKeyrings(cipher)
    merge(this.keyrings, companyId, new Map([[key.kid, key.key]]))
    await this.saveKeyring(cipher)
    const me = this.host.me
    await this.publish(await envelope(cipher, companyId, me, new Map([[key.kid, key.key]]), this.host.nextTimestamp(envelopeD(companyId, me)), key.kid))
    this.setKeys()
  }

  // Waits for any pass in progress, then runs one, so callers see every key that has arrived.
  async settled(): Promise<void> {
    while (this.running) await this.running
    await this.sync()
  }

  sync(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.pass().finally(() => {
      this.running = undefined
      if (this.again) {
        this.again = false
        this.schedule()
      }
    })
    return this.running
  }

  private async pass(): Promise<void> {
    const companies = this.host.companies()
    if (!companies) return
    const encrypted = [...companies.values()].some((s) => s.kid || s.locked)
    if (!encrypted && ![...companies.values()].some((s) => this.unencrypted(s))) return this.host.report('ok')
    const cipher = this.host.cipher()
    // A sign-in that can't encrypt leaves plaintext organizations as they are.
    if (!cipher) return this.host.report(encrypted ? 'cant-decrypt' : 'ok')
    try {
      const failed = await this.open(cipher, companies)
      this.check()
      if (failed) {
        this.host.report('failed', failed)
        this.schedule(RETRY_MS)
        return
      }
      this.host.report('ok')
      await this.duties(cipher, this.host.companies() ?? companies)
      await this.profiles(this.host.companies() ?? companies)
    } catch (error) {
      if (error instanceof Stopped) return
      // A refused keyring save isn't the signer's fault: no phone message.
      this.host.report(error instanceof Refused ? 'ok' : 'failed', error)
      this.schedule(RETRY_MS)
    }
  }

  // Reads every copy of the keyring; throws if one can't be read, so nothing ever saves over it.
  private async readKeyrings(cipher: Cipher): Promise<boolean> {
    let changed = false
    for (const event of this.host.versions(keyringD(this.host.me))) {
      if (this.givenUp.has(event.id)) throw new Error('Your saved keys could not be read this session.')
      if (this.opened.has(event.id)) continue
      const copy = await this.attempt(event.id, () => openKeyring(cipher, event, this.host.me))
      // Another tab or device saved over a key held here: it must be saved again or it is lost.
      if (lacks(copy, this.keyrings)) this.keyringStale = true
      changed = mergeKeyrings(this.keyrings, copy) || changed
      this.opened.add(event.id)
    }
    return changed
  }

  // Reads the keyring, then any envelope for a key still missing. Returns the first signer failure,
  // if any; the rest still goes ahead.
  private async open(cipher: Cipher, companies: Map<string, CompanyState>): Promise<unknown> {
    const me = this.host.me
    let failed: unknown
    let changed = false
    let keyringRead = true
    try {
      changed = await this.readKeyrings(cipher)
    } catch (error) {
      if (error instanceof Stopped) throw error
      failed = error
      keyringRead = false
    }
    let found = false
    for (const state of companies.values()) {
      const id = state.company.id
      // Envelopes are opened while the current key, or any key an item here names, is missing: two
      // admins giving an organization its first key at once each hand theirs out.
      const held = this.keyrings.keys.get(id)
      const missing = (kid?: string) => !!kid && !held?.has(kid)
      if (!state.kid || (!missing(state.kid) && !this.host.eventsIn(id).some((e) => missing(kidTag(e))))) continue
      for (const event of this.host.versions(envelopeD(id, me))) {
        if (this.opened.has(event.id) || this.givenUp.has(event.id)) continue
        try {
          const keys = await this.attempt(event.id, () => openEnvelope(cipher, event, state, me))
          // An envelope from someone not (yet) an admin is tried again later.
          if (keys.size || isAdmin(state, event.pubkey)) this.opened.add(event.id)
          if (merge(this.keyrings, id, keys)) changed = found = true
        } catch (error) {
          if (error instanceof Stopped) throw error
          failed ??= error
        }
      }
    }
    let pinned = false
    for (const state of companies.values()) pinned = noteCurrent(this.keyrings, state) || pinned
    if (pinned) this.host.savePins?.(this.keyrings.current)
    if (changed) this.setKeys()
    // Saved only once every copy of the keyring is merged in: saving replaces it.
    if ((found || this.keyringStale) && keyringRead) await this.saveKeyring(cipher)
    return failed
  }

  // Runs one decrypt, counting failures; after too many the event is skipped for the session.
  private async attempt<T>(id: string, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run()
      this.check()
      return result
    } catch (error) {
      this.check()
      const tries = (this.tries.get(id) ?? 0) + 1
      this.tries.set(id, tries)
      if (tries >= MAX_TRIES) this.givenUp.add(id)
      throw error
    }
  }

  // What an admin's client does unasked: hand the key to new members, replace it after a removal.
  private async duties(cipher: Cipher, companies: Map<string, CompanyState>): Promise<void> {
    for (const state of companies.values()) {
      const id = state.company.id
      if ((this.backoff.get(id) ?? 0) > Date.now()) continue
      try {
        await this.duty(cipher, state)
      } catch (error) {
        if (!(error instanceof Refused)) throw error
        // Each organization's duties stand alone; one the relay refuses waits, the rest go ahead.
        this.backoff.set(id, Date.now() + REFUSED_BACKOFF_MS)
      }
    }
  }

  private async duty(cipher: Cipher, state: CompanyState): Promise<void> {
    const me = this.host.me
    const id = state.company.id
    // An organization from before encryption gets its first key the way a removal gets a new one.
    if (this.unencrypted(state)) return this.planRotation(state)
    if (!state.kid || state.locked || !isAdmin(state, me) || !this.keyrings.keys.get(id)?.has(state.kid)) return
    if (state.rotationDue) return this.planRotation(state)
    const holders = state.holders ?? []
    const missing = state.members.map((m) => m.pubkey).filter((pk) => !holders.includes(pk))
    const key = this.keyFor(state)
    if (missing.length) {
      // Listed as holders first, so nobody ever holds the key without being listed.
      const { address, content } = commands.companyWrite(state, { holders: [...holders, ...missing] })
      await this.publish(template(address, content as never, this.host.nextTimestamp(`canban:company:${id}`), key))
    }
    // Everyone this admin has listed for the current key gets an envelope from it; one that
    // failed to send before is sent again.
    const history = this.keyrings.keys.get(id)!
    for (const pk of new Set([...this.listedByMe(id, state.kid), ...missing])) {
      if (this.sentTo(id, pk, state.kid)) continue
      await this.publish(await envelope(cipher, id, pk, history, this.host.nextTimestamp(envelopeD(id, pk)), state.kid))
    }
    await this.reencrypt(state, key!)
  }

  // My profile goes into every encrypted organization I'm in, encrypted with its key; once all of them
  // hold it, the plaintext copy from before encryption is emptied (src/domain/profile.ts).
  private async profiles(companies: Map<string, CompanyState>): Promise<void> {
    const me = this.host.me
    const keys = flatten(this.keyrings)
    const mine = (d: string) => this.host.versions(d).filter((e) => e.pubkey === me)
    const joined = [...companies.values()].filter((s) => s.members.some((m) => m.pubkey === me))
    const current = profilesOf([...mine(profileD(me)), ...joined.flatMap((s) => mine(orgProfileD(s.company.id, me)))], keys).get(me)
    if (!current || !joined.length) return
    let everywhere = true
    for (const state of joined) {
      const id = state.company.id
      let key: OrgKey | undefined
      try {
        key = this.keyFor(state)
      } catch {
        key = undefined
      }
      if (!key || (this.backoff.get(id) ?? 0) > Date.now()) {
        everywhere = false
        continue
      }
      const copy = profilesOf(mine(orgProfileD(id, me)), keys).get(me)
      if (copy && sameProfile(copy, current)) continue
      try {
        await this.publish(profileTemplate(me, current, this.host.nextTimestamp(orgProfileD(id, me)), { companyId: id, key }))
      } catch (error) {
        if (!(error instanceof Refused)) throw error
        this.backoff.set(id, Date.now() + REFUSED_BACKOFF_MS)
        everywhere = false
      }
    }
    const plain = mine(profileD(me)).sort((a, b) => b.created_at - a.created_at)[0]
    if (everywhere && plain && profilesOf([plain]).size) await this.publish(movedTemplate(me, this.host.nextTimestamp(profileD(me))))
  }

  // A plaintext organization this admin can encrypt. Any sign that it is encrypted already (an
  // encrypted event, an envelope, a key id seen named) means the newest company event hasn't arrived,
  // and a second key must not be made.
  private unencrypted(state: CompanyState): boolean {
    const id = state.company.id
    if (state.kid || state.locked || !isAdmin(state, this.host.me) || this.keyrings.current.has(id)) return false
    return !this.host.eventsIn(id).some((e) => isEncrypted(e) || e.tags.some((t) => t[0] === 'd' && t[1].startsWith('canban:key:')))
  }

  // Writes the next batch of items still in plaintext again, encrypted, then waits before the next.
  private async reencrypt(state: CompanyState, key: OrgKey): Promise<void> {
    const id = state.company.id
    const wait = (this.reencrypting.get(id) ?? 0) - Date.now()
    if (wait > 0) return this.schedule(wait)
    const writes = reencryptions(state, this.host.eventsIn(id), this.host.me)
    if (!writes.length) return void this.reencrypting.delete(id)
    this.reencrypting.set(id, Date.now() + REENCRYPT_PAUSE_MS)
    let sent = 0
    for (const { address, content } of writes) {
      if (sent === REENCRYPT_BATCH) return this.schedule(REENCRYPT_PAUSE_MS)
      let unsigned: EventTemplate
      try {
        unsigned = template(address, content as never, this.host.nextTimestamp(dOf(address)), key)
      } catch {
        // Too large to encrypt: it stays as it is, and the relay keeps its plaintext.
        continue
      }
      await this.publish(unsigned)
      sent++
    }
  }

  // The holders named by this admin's own newest company event for the key.
  private listedByMe(companyId: string, kid: string): string[] {
    const mine = this.host
      .versions(`canban:company:${companyId}`)
      .filter((e) => e.pubkey === this.host.me && kidTag(e) === kid)
      .sort((a, b) => b.created_at - a.created_at)[0]
    const holders = open<CompanyContent>(mine, flatten(this.keyrings))?.holders
    return Array.isArray(holders) ? holders.filter((pk) => typeof pk === 'string') : []
  }

  // Whether this admin has already sent `pk` an envelope carrying the key and every older one held
  // here, so a key another tab's envelope left out is handed out again.
  private sentTo(companyId: string, pk: string, kid: string): boolean {
    const held = [...(this.keyrings.keys.get(companyId)?.keys() ?? [])]
    return this.host
      .versions(envelopeD(companyId, pk))
      .some((e) => e.pubkey === this.host.me && kidTag(e) === kid && held.every((k) => envelopeKids(e).includes(k)))
  }

  private planRotation(state: CompanyState, delay?: number): void {
    const id = state.company.id
    if (this.rotations.has(id)) return
    const [min, max] = ROTATE_DELAY_MS
    // The owner's tabs and devices each spread a first key out a little, so usually one makes it.
    const owner = state.company.owner === this.host.me ? (state.rotationDue ? 0 : Math.random() * FIRST_KEY_SPREAD_MS) : undefined
    const wait = delay ?? owner ?? min + Math.random() * (max - min)
    this.rotations.set(
      id,
      setTimeout(() => {
        this.rotations.delete(id)
        void this.rotate(id)
      }, wait),
    )
  }

  private async rotate(companyId: string): Promise<void> {
    const state = this.host.companies()?.get(companyId)
    const cipher = this.host.cipher()
    // Another admin may have replaced it meanwhile.
    if (this.stopped || !state || !(state.rotationDue || this.unencrypted(state)) || !cipher) return
    if (this.running) return this.planRotation(state, BUSY_RETRY_MS)
    const run = (async () => {
      await this.readKeyrings(cipher)
      // A first key one of my other tabs or devices already saved is used again, never a second one.
      const first = !state.rotationDue
      const saved = first ? [...(this.keyrings.keys.get(companyId) ?? [])][0] : undefined
      const r = rotation(state, this.keyrings, this.host.me, saved && orgKey(saved[1]))
      // Saved before anything names the new key, so it can't be lost.
      if (merge(this.keyrings, companyId, r.history) || this.keyringStale) await this.saveKeyring(cipher)
      this.setKeys()
      // Someone else may have given the organization its key while the signer was busy.
      const now = this.host.companies()?.get(companyId)
      if (first && (!now || !this.unencrypted(now))) return
      const { address, content } = r.company
      await this.publish(template(address, content as never, this.host.nextTimestampIn(companyId), r.key))
      // An envelope that fails here is sent again by the next pass's duties.
      for (const pk of r.recipients) await this.publish(await envelope(cipher, companyId, pk, r.history, this.host.nextTimestamp(envelopeD(companyId, pk)), r.key.kid))
    })()
    this.running = run
      .catch((error) => {
        if (error instanceof Refused) this.backoff.set(companyId, Date.now() + REFUSED_BACKOFF_MS)
        else if (!(error instanceof Stopped)) this.host.report('failed', error)
      })
      .finally(() => {
        this.running = undefined
        this.schedule()
      })
    await this.running
  }

  private setKeys(): void {
    this.check()
    this.host.setKeys(flatten(this.keyrings))
  }

  private async saveKeyring(cipher: Cipher): Promise<void> {
    const me = this.host.me
    const unsigned = await keyring(cipher, me, this.keyrings, this.host.nextTimestamp(keyringD(me)))
    this.check()
    const event = await this.host.sign(unsigned)
    this.check()
    this.opened.add(event.id)
    await this.sendOrRefuse(event)
    this.keyringStale = false
  }

  private async publish(unsigned: EventTemplate): Promise<void> {
    this.check()
    const event = await this.host.sign(unsigned)
    this.check()
    await this.sendOrRefuse(event)
  }

  private async sendOrRefuse(event: NostrEvent): Promise<void> {
    try {
      await this.host.send(event)
    } catch (error) {
      throw new Refused(error instanceof Error ? error.message : String(error))
    }
  }

  // Work still in flight when the person signs out must not touch the next session.
  private check(): void {
    if (this.stopped) throw new Stopped()
  }
}

// Whether a saved copy of the keyring is missing any key held now.
function lacks(copy: Keyrings, held: Keyrings): boolean {
  for (const [companyId, ring] of held.keys) for (const kid of ring.keys()) if (!copy.keys.get(companyId)?.has(kid)) return true
  return false
}

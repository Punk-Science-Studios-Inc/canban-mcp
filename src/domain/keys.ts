import type { EventTemplate, NostrEvent } from 'nostr-tools'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { kidOf, orgKey, type Keyring, type OrgKey } from './crypto'
import { companyWrite, type Write } from './commands'
import { APP_TAG, KIND, isAdmin, ownerOf, type CompanyState } from './model'

// How an organization's key reaches its members without anyone seeing it (docs/encryption.md):
// an admin writes each member an envelope holding the organization's whole key history, NIP-44
// encrypted to them; each person keeps what they've opened in a keyring encrypted to themselves.

// NIP-44 to or from another pubkey, as signers expose it (src/nostr/signer.ts Nip44).
export interface Cipher {
  encrypt(peer: string, plaintext: string): Promise<string>
  decrypt(peer: string, ciphertext: string): Promise<string>
}

// What a person holds: each organization's keys (companyId → kid → key), and the newest current key
// they've seen named for it, so a relay can't roll an organization back to a key from before a
// removal by withholding the newest company event.
export interface Keyrings {
  keys: Map<string, Keyring>
  current: Map<string, { kid: string; at: number }>
}

export const emptyKeyrings = (): Keyrings => ({ keys: new Map(), current: new Map() })

export const envelopeD = (companyId: string, member: string): string => `canban:key:${companyId}:${member}`
export const keyringD = (pubkey: string): string => `canban:keyring:${pubkey}`

// The key ids an envelope carries, from its tags.
export const envelopeKids = (event: NostrEvent): string[] => event.tags.filter((t) => (t[0] === 'k' || t[0] === 'h') && t[1]).map((t) => t[1])

export function newOrgKey(): OrgKey {
  return orgKey(crypto.getRandomValues(new Uint8Array(32)))
}

// Every key a person holds, whichever organization it belongs to, for reading events by kid.
export function flatten(keyrings: Keyrings): Keyring {
  const all: Keyring = new Map()
  for (const ring of keyrings.keys.values()) for (const [kid, key] of ring) all.set(kid, key)
  return all
}

const NOT_YET = 'This organization can’t be changed from here yet. Try again in a moment.'

// The key new content in an organization is encrypted with: the one its company event names.
// Undefined for an organization that isn't encrypted yet; an error when this person can't open it
// or has seen a newer one named, so nothing is ever written in plaintext over encrypted data or
// with a key from before a removal.
export function writeKey(state: CompanyState, keyrings: Keyrings): OrgKey | undefined {
  if (state.locked) throw new Error(NOT_YET)
  const seen = keyrings.current.get(state.company.id)
  // Known to be encrypted, yet no key named now: a relay withholding the newest company events.
  if (!state.kid) {
    if (seen) throw new Error(NOT_YET)
    return undefined
  }
  const key = keyrings.keys.get(state.company.id)?.get(state.kid)
  // A different key seen named later means this one is from before a rotation. The same key named
  // by an event that no longer counts (its admin was demoted) is still current.
  if (!key || (seen && seen.kid !== state.kid && seen.at > (state.kidAt ?? 0))) throw new Error(NOT_YET)
  return { kid: state.kid, key }
}

// Records the current key a resolved organization names; true when it is newer than what was known.
export function noteCurrent(keyrings: Keyrings, state: CompanyState): boolean {
  if (!state.kid || state.kidAt === undefined) return false
  const seen = keyrings.current.get(state.company.id)
  if (seen && seen.at >= state.kidAt) return false
  keyrings.current.set(state.company.id, { kid: state.kid, at: state.kidAt })
  return true
}

// Key history as stored inside envelopes and keyrings: kid → hex key.
const encode = (ring: Keyring): Record<string, string> => Object.fromEntries([...ring].map(([kid, key]) => [kid, bytesToHex(key)]))

// Keeps only entries whose key hashes to the kid they claim, so a wrong key is never used.
function decode(raw: unknown): Keyring {
  const ring: Keyring = new Map()
  if (!raw || typeof raw !== 'object') return ring
  for (const [kid, hex] of Object.entries(raw)) {
    try {
      const key = hexToBytes(String(hex))
      if (key.length === 32 && kidOf(key) === kid) ring.set(kid, key)
    } catch {
      // Not hex: skipped.
    }
  }
  return ring
}

// `kid` is the organization's current key, named in a tag so the writer can tell later which
// members already have it without decrypting.
export async function envelope(cipher: Cipher, companyId: string, member: string, history: Keyring, createdAt: number, kid: string): Promise<EventTemplate> {
  return {
    kind: KIND,
    created_at: createdAt,
    // The p tag lets the member's subscription find it.
    // h names every other key it carries, so the writer (and the relay's purge) can tell whether it
    // hands out the whole history.
    tags: [['d', envelopeD(companyId, member)], ['t', APP_TAG], ['c', companyId], ['p', member], ['k', kid], ...[...history.keys()].filter((h) => h !== kid).map((h) => ['h', h])],
    content: await cipher.encrypt(member, JSON.stringify(encode(history))),
  }
}

// The keys in an envelope for `me`, accepted only from a current admin of the organization (the
// owner counts). Empty when the envelope isn't one or holds nothing valid; a signer that refuses or
// fails to decrypt throws, so the caller can try again.
export async function openEnvelope(cipher: Cipher, event: NostrEvent, state: CompanyState, me: string): Promise<Keyring> {
  const d = event.tags.find((t) => t[0] === 'd')?.[1]
  if (event.kind !== KIND || d !== envelopeD(state.company.id, me)) return new Map()
  if (!isAdmin(state, event.pubkey)) return new Map()
  const text = await cipher.decrypt(event.pubkey, event.content)
  try {
    return decode(JSON.parse(text))
  } catch {
    return new Map()
  }
}

export async function keyring(cipher: Cipher, me: string, keyrings: Keyrings, createdAt: number): Promise<EventTemplate> {
  const content = {
    keys: Object.fromEntries([...keyrings.keys].map(([companyId, ring]) => [companyId, encode(ring)])),
    current: Object.fromEntries(keyrings.current),
  }
  return {
    kind: KIND,
    created_at: createdAt,
    tags: [['d', keyringD(me)], ['t', APP_TAG]],
    content: await cipher.encrypt(me, JSON.stringify(content)),
  }
}

// A person's own keyring: one decrypt per session instead of one per envelope.
export async function openKeyring(cipher: Cipher, event: NostrEvent, me: string): Promise<Keyrings> {
  const keyrings = emptyKeyrings()
  const d = event.tags.find((t) => t[0] === 'd')?.[1]
  if (event.kind !== KIND || event.pubkey !== me || d !== keyringD(me)) return keyrings
  // A signer that refuses or fails throws, so the caller can try again.
  const text = await cipher.decrypt(me, event.content)
  try {
    const raw = JSON.parse(text) as { keys?: Record<string, unknown>; current?: Record<string, { kid?: unknown; at?: unknown }> }
    for (const [companyId, ring] of Object.entries(raw.keys ?? {})) {
      const keys = decode(ring)
      if (keys.size) keyrings.keys.set(companyId, keys)
    }
    for (const [companyId, c] of Object.entries(raw.current ?? {})) {
      if (typeof c?.kid === 'string' && typeof c.at === 'number') keyrings.current.set(companyId, { kid: c.kid, at: c.at })
    }
  } catch {
    // Unreadable: start again from envelopes.
  }
  return keyrings
}

// Adds what another copy of the keyring holds (another device, or the one on the relay) before
// saving, since saving replaces it: no key is ever dropped from the history. True when anything changed.
export function mergeKeyrings(into: Keyrings, from: Keyrings): boolean {
  let changed = false
  for (const [companyId, ring] of from.keys) changed = merge(into, companyId, ring) || changed
  for (const [companyId, c] of from.current) {
    const seen = into.current.get(companyId)
    if (seen && seen.at >= c.at) continue
    into.current.set(companyId, c)
    changed = true
  }
  return changed
}

// Adds keys to a person's keyrings; true when anything was new, so the keyring needs saving.
export function merge(keyrings: Keyrings, companyId: string, keys: Keyring): boolean {
  const ring = keyrings.keys.get(companyId) ?? new Map<string, Uint8Array>()
  let added = false
  for (const [kid, key] of keys) {
    if (ring.has(kid)) continue
    ring.set(kid, key)
    added = true
  }
  if (added) keyrings.keys.set(companyId, ring)
  return added
}

// Everyone who must hold the key: the owner and every member.
export function recipients(state: CompanyState): string[] {
  return [...new Set([ownerOf(state.company.id), ...state.members.map((m) => m.pubkey)])]
}

// A new key for an organization whose current one must be replaced (state.rotationDue, from any
// device or agent): the company event rewritten to name it and list who holds it, and envelopes with
// the whole history for everyone who remains. Run it on fully loaded state, so every removal is
// counted. The company write goes out encrypted with `key` (created_at above every member event
// seen), then the envelopes.
// `key` is a first key already saved to the admin's keyring, used instead of a new one.
export function rotation(state: CompanyState, keyrings: Keyrings, me: string, key = newOrgKey()): { key: OrgKey; history: Keyring; company: Write; recipients: string[] } {
  if (state.locked || !isAdmin(state, me)) throw new Error(NOT_YET)
  const history: Keyring = new Map(keyrings.keys.get(state.company.id) ?? [])
  history.set(key.kid, key.key)
  const people = recipients(state)
  return { key, history, company: companyWrite(state, { holders: people }), recipients: people }
}

// Handing the current key to someone new: they join the holders on the company event (written with
// the current key), so removing them later triggers a rotation. Write this before their envelope, so
// nobody ever holds the key without being listed.
export function addHolder(state: CompanyState, me: string, pubkey: string): Write | undefined {
  if (!state.kid || state.locked || !isAdmin(state, me)) return undefined
  const holders = state.holders ?? []
  return holders.includes(pubkey) ? undefined : companyWrite(state, { holders: [...holders, pubkey] })
}


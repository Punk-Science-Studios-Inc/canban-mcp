import type { NostrEvent } from 'nostr-tools'
import * as nip44 from 'nostr-tools/nip44'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

// An organization's content is encrypted with a shared 32-byte key, used directly as the NIP-44 v2
// conversation key. Events name their key with a `k` tag holding its id. People never see either;
// see docs/encryption.md.

export interface OrgKey {
  kid: string
  key: Uint8Array
}

// kid → key, for every key a person can open.
export type Keyring = Map<string, Uint8Array>

export const kidOf = (key: Uint8Array): string => bytesToHex(sha256(key)).slice(0, 16)

export const orgKey = (key: Uint8Array): OrgKey => ({ kid: kidOf(key), key })

// The event's own d goes inside the plaintext, so ciphertext can't be moved onto another item.
export function seal(content: unknown, d: string, key: OrgKey): string {
  const json = JSON.stringify({ ...(content as object), d })
  if (new TextEncoder().encode(json).length > MAX_PLAINTEXT) throw new Error('This item is too large to save.')
  return nip44.v2.encrypt(json, key.key)
}

export const kidTag = (event: NostrEvent): string | undefined => event.tags.find((t) => t[0] === 'k')?.[1]
export const isEncrypted = (event: NostrEvent): boolean => event.tags.some((t) => t[0] === 'k')

// NIP-44 plaintext limit.
const MAX_PLAINTEXT = 65_535

// The content of an event: plaintext JSON, or decrypted when its key is in the keyring. Undefined when
// it can't be read: unknown key, tampered ciphertext, or ciphertext moved from another item.
export function open<T>(event: NostrEvent | undefined, keyring?: Keyring): T | undefined {
  if (!event) return undefined
  try {
    if (!isEncrypted(event)) return JSON.parse(event.content) as T
    const kid = kidTag(event)
    const key = kid ? keyring?.get(kid) : undefined
    if (!key) return undefined
    const { d, ...content } = JSON.parse(nip44.v2.decrypt(event.content, key)) as { d?: string }
    return d === event.tags.find((t) => t[0] === 'd')?.[1] ? (content as T) : undefined
  } catch {
    return undefined
  }
}

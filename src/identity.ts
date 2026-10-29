import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { nip19 } from 'nostr-tools'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'

export interface Identity {
  secret: Uint8Array
  pubkey: string
  npub: string
  keyFile?: string
  created: boolean
}

export function defaultKeyFile(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'canban', 'agent.nsec')
}

function decodeNsec(raw: string, source: string): Uint8Array {
  const decoded = nip19.decode(raw.trim())
  if (decoded.type !== 'nsec') throw new Error(`${source} does not hold an nsec.`)
  return decoded.data
}

export function loadIdentity(env = process.env): Identity {
  if (env.CANBAN_NSEC) return describe(decodeNsec(env.CANBAN_NSEC, 'CANBAN_NSEC'), undefined, false)
  const keyFile = env.CANBAN_KEY_FILE ?? defaultKeyFile()
  if (existsSync(keyFile)) return describe(decodeNsec(readFileSync(keyFile, 'utf8'), keyFile), keyFile, false)
  const secret = generateSecretKey()
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 })
  writeFileSync(keyFile, nip19.nsecEncode(secret) + '\n', { mode: 0o600 })
  chmodSync(keyFile, 0o600)
  return describe(secret, keyFile, true)
}

function describe(secret: Uint8Array, keyFile: string | undefined, created: boolean): Identity {
  const pubkey = getPublicKey(secret)
  return { secret, pubkey, npub: nip19.npubEncode(pubkey), keyFile, created }
}

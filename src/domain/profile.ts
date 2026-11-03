import type { EventTemplate, NostrEvent } from 'nostr-tools'
import { isEncrypted, open, seal, type Keyring, type OrgKey } from './crypto'
import { APP_TAG, KIND } from './model'

// A person's own Canban profile: the display name and avatar collaborators see, overriding their
// Nostr profile inside Canban. Only the person's own events count: a copy in each organization they
// are in, encrypted with its key, and a plaintext one used only while an organization they are in
// isn't encrypted (docs/encryption.md, Profiles). The newest copy a viewer can read wins.
export interface CanbanProfile {
  name?: string
  picture?: string
}

export const profileD = (pubkey: string) => `canban:profile:${pubkey}`
export const orgProfileD = (companyId: string, pubkey: string) => `canban:profile:${companyId}:${pubkey}`

export function profileTemplate(pubkey: string, profile: CanbanProfile, createdAt: number, org?: { companyId: string; key: OrgKey }): EventTemplate {
  if (!org) return { kind: KIND, created_at: createdAt, tags: [['d', profileD(pubkey)], ['t', APP_TAG]], content: JSON.stringify(profile) }
  const d = orgProfileD(org.companyId, pubkey)
  return { kind: KIND, created_at: createdAt, tags: [['d', d], ['t', APP_TAG], ['c', org.companyId], ['k', org.key.kid]], content: seal(profile, d, org.key) }
}

// Replaces the plaintext profile once every organization holds an encrypted copy.
export function movedTemplate(pubkey: string, createdAt: number): EventTemplate {
  return { kind: KIND, created_at: createdAt, tags: [['d', profileD(pubkey)], ['t', APP_TAG]], content: JSON.stringify({ moved: true }) }
}

// Most a picture may be: a 96 px JPEG is about 8 KB, and encrypted it must fit a 64 KB profile.
const MAX_PICTURE = 24_000

// Avatars are small images stored in the event itself. Links are dropped so a profile can't make
// every viewer fetch from someone else's server.
export function safePicture(picture: unknown): string | undefined {
  if (typeof picture !== 'string' || picture.length > MAX_PICTURE) return undefined
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(picture) ? picture : undefined
}

function isOwnProfile(e: NostrEvent): boolean {
  if (e.kind !== KIND) return false
  const d = e.tags.find((t) => t[0] === 'd')?.[1] ?? ''
  if (d === profileD(e.pubkey)) return true
  const [app, type, companyId, pubkey, extra] = d.split(':')
  return app === 'canban' && type === 'profile' && !!companyId && pubkey === e.pubkey && extra === undefined && isEncrypted(e)
}

function read(e: NostrEvent, keyring?: Keyring): CanbanProfile | undefined {
  const raw = open<Record<string, unknown>>(e, keyring)
  if (!raw || typeof raw !== 'object' || raw.moved) return undefined
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : undefined
  return { name, picture: safePicture(raw.picture) }
}

export function profilesOf(events: Iterable<NostrEvent>, keyring?: Keyring): Map<string, CanbanProfile> {
  const newest = new Map<string, { at: number; profile: CanbanProfile }>()
  for (const e of events) {
    if (!isOwnProfile(e)) continue
    const seen = newest.get(e.pubkey)
    if (seen && seen.at >= e.created_at) continue
    const profile = read(e, keyring)
    if (profile) newest.set(e.pubkey, { at: e.created_at, profile })
  }
  return new Map([...newest].map(([pubkey, { profile }]) => [pubkey, profile]))
}

export const sameProfile = (a: CanbanProfile, b: CanbanProfile) => (a.name ?? '') === (b.name ?? '') && (a.picture ?? '') === (b.picture ?? '')

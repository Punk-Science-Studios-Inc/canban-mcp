import type { EventTemplate, NostrEvent } from 'nostr-tools'
import { APP_TAG, KIND } from './model'

// A person's own Canban profile: the display name and avatar collaborators see, overriding their
// Nostr profile inside Canban. Only the person's own event counts.
export interface CanbanProfile {
  name?: string
  picture?: string
}

export const profileD = (pubkey: string) => `canban:profile:${pubkey}`

export function profileTemplate(pubkey: string, profile: CanbanProfile, createdAt: number): EventTemplate {
  return { kind: KIND, created_at: createdAt, tags: [['d', profileD(pubkey)], ['t', APP_TAG]], content: JSON.stringify(profile) }
}

// Most a picture may be: a 96 px JPEG is about 8 KB, and encrypted it must fit a 64 KB profile.
const MAX_PICTURE = 24_000

// Avatars are small images stored in the event itself. Links are dropped so a profile can't make
// every viewer fetch from someone else's server.
export function safePicture(picture: unknown): string | undefined {
  if (typeof picture !== 'string' || picture.length > MAX_PICTURE) return undefined
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(picture) ? picture : undefined
}

export function profilesOf(events: Iterable<NostrEvent>): Map<string, CanbanProfile> {
  const newest = new Map<string, NostrEvent>()
  for (const e of events) {
    if (e.kind !== KIND || e.tags.find((t) => t[0] === 'd')?.[1] !== profileD(e.pubkey)) continue
    const seen = newest.get(e.pubkey)
    if (!seen || e.created_at > seen.created_at) newest.set(e.pubkey, e)
  }
  const profiles = new Map<string, CanbanProfile>()
  for (const [pubkey, e] of newest) {
    try {
      const raw = JSON.parse(e.content) as Record<string, unknown>
      const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : undefined
      profiles.set(pubkey, { name, picture: safePicture(raw.picture) })
    } catch {
      continue
    }
  }
  return profiles
}

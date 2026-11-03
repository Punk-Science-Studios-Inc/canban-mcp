import type { Filter, NostrEvent } from 'nostr-tools'
import { SUBSCRIPTIONS_D } from './entitlements'
import { APP_TAG, KIND } from './model'
import { keyringD } from './keys'
import { profileD } from './profile'

// What a client asks the relay for. One filter per organization, because the relay caps each
// filter's results before filtering them per person: a single filter for all of Canban would let a
// busy relay push older organizations out of view.
export function canbanFilters(me: string, companyIds: Iterable<string>, people: Iterable<string>): Filter[] {
  const base = { kinds: [KIND], '#t': [APP_TAG] }
  const profiles = [...new Set(people)].map(profileD)
  return [
    // Member events and project assignments name me with a p tag: they reveal my organizations.
    { ...base, '#p': [me] },
    // My own writes: organizations I own, my profile.
    { ...base, authors: [me] },
    ...[...new Set(companyIds)].sort().map((c) => ({ ...base, '#c': [c] })),
    // Join requests, which the relay shows only to admins (src/domain/requests.ts).
    ...(new Set(companyIds).size ? [{ ...base, '#r': [...new Set(companyIds)].sort() }] : []),
    // The keyring is rarely rewritten, so the authors filter (newest first, capped) can miss it.
    { ...base, '#d': [SUBSCRIPTIONS_D, keyringD(me)] },
    ...(profiles.length ? [{ ...base, '#d': profiles }] : []),
  ]
}

// The organizations an event shows I belong to or own.
export function companiesNaming(me: string, event: NostrEvent): string[] {
  const c = event.tags.find((t) => t[0] === 'c')?.[1]
  if (!c) return []
  const namesMe = event.pubkey === me || event.tags.some((t) => t[0] === 'p' && t[1] === me)
  return namesMe ? [c] : []
}

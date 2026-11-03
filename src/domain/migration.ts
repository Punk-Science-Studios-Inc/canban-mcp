import type { NostrEvent } from 'nostr-tools'
import { companyWrite, type Write } from './commands'
import { isEncrypted } from './crypto'
import { parseD, type Address } from './entities'
import { latest } from './resolve'
import { KIND, type CompanyState } from './model'

// Encrypting an organization made before encryption (docs/encryption.md, Migration): once it has a
// key, an admin's client writes every item whose current version is still plaintext again, unchanged
// but encrypted. Deleted items are included, so their task numbers are never reused once the relay
// purges the plaintext.

// The writes `me` still needs to make, oldest item first. Only versions that count (resolve.ts) are
// rewritten (an admin's, or an assigned member's for lanes and tasks), and only where a version by
// `me` would count in their place.
export function reencryptions(state: CompanyState, events: Iterable<NostrEvent>, me: string): Write[] {
  const companyId = state.company.id
  const admins = new Set(state.members.filter((m) => m.role !== 'member').map((m) => m.pubkey))
  const assigned = new Map(state.projects.map((p) => [p.id, new Set(p.members)]))
  const byD = new Map<string, { address: Address; versions: NostrEvent[] }>()
  for (const event of events) {
    if (event.kind !== KIND) continue
    const d = event.tags.find((t) => t[0] === 'd')?.[1] ?? ''
    const address = parseD(d)
    if (!address || address.companyId !== companyId) continue
    const entry = byD.get(d) ?? { address, versions: [] }
    entry.versions.push(event)
    byD.set(d, entry)
  }
  const writes: { at: number; write: Write }[] = []
  for (const { address, versions } of byD.values()) {
    const allowed = writers(address, state.company.owner, admins, assigned)
    if (!allowed(me)) continue
    const event = latest(versions, allowed)
    if (!event || isEncrypted(event)) continue
    // The organization exists by its owner's company event, so the owner rewrites theirs even when
    // an admin's already names the key; it carries the current name, holders and invite.
    if (address.type === 'company') {
      writes.push({ at: event.created_at, write: companyWrite(state, {}) })
      continue
    }
    let content: unknown
    try {
      content = JSON.parse(event.content)
    } catch {
      continue
    }
    if (content && typeof content === 'object') writes.push({ at: event.created_at, write: { address, content } as Write })
  }
  return writes.sort((a, b) => a.at - b.at).map((w) => w.write)
}

function writers(address: Address, owner: string, admins: Set<string>, assigned: Map<string, Set<string>>): (pk: string) => boolean {
  switch (address.type) {
    case 'company':
      return (pk) => pk === owner
    case 'member':
      // The owner's own member event is theirs; nobody appoints themselves otherwise.
      return address.pubkey === owner ? (pk) => pk === owner : (pk) => admins.has(pk) && pk !== address.pubkey
    case 'lane':
    case 'task':
      return (pk) => admins.has(pk) || !!assigned.get(address.projectId)?.has(pk)
    default:
      return (pk) => admins.has(pk)
  }
}

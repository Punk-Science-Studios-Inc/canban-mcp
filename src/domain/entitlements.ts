import type { NostrEvent } from 'nostr-tools'
import type { Write } from './commands'
import { OPERATOR, ownerOf, type CompanyState } from './model'

// The billing service signs this list; only its key's copy counts.
export const BILLING = '33d4228191df2857292cb601c65a978a9adfac4f1fd044d3616202af922b4642'
export const SUBSCRIPTIONS_D = 'canban/subscriptions'
export const GRACE_DAYS = 7
export const FREE_PROJECTS = 1
export const FREE_PEOPLE = 3

// Content of the kind 30078 event with d = canban/subscriptions: each paying organization and the
// last day (YYYY-MM-DD, UTC) its payment covers.
export interface SubscriptionList {
  orgs: Record<string, { paidUntil: string }>
}

export type Entitlement = 'free' | 'paid' | 'grace' | 'unpaid'

// Operator-owned organizations are free. Others are paid through paidUntil, then have a grace
// period, then fall back to the free tier (read-only beyond its limits).
export function entitlement(list: SubscriptionList | undefined, companyId: string, today = new Date().toISOString().slice(0, 10)): Entitlement {
  if (ownerOf(companyId) === OPERATOR) return 'free'
  const paidUntil = list?.orgs[companyId]?.paidUntil
  if (!paidUntil) return 'unpaid'
  if (today <= paidUntil) return 'paid'
  return today <= addDays(paidUntil, GRACE_DAYS) ? 'grace' : 'unpaid'
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// The newest list signed by the billing key among the events seen.
export function subscriptionListOf(events: Iterable<NostrEvent>): SubscriptionList | undefined {
  let newest: NostrEvent | undefined
  for (const e of events) {
    if (e.pubkey !== BILLING || e.tags.find((t) => t[0] === 'd')?.[1] !== SUBSCRIPTIONS_D) continue
    if (!newest || e.created_at > newest.created_at) newest = e
  }
  try {
    const list = newest && (JSON.parse(newest.content) as SubscriptionList)
    return list && typeof list.orgs === 'object' ? list : undefined
  } catch {
    return undefined
  }
}

export function withinFreeTier(state: CompanyState): boolean {
  return state.projects.length <= FREE_PROJECTS && state.members.length <= FREE_PEOPLE
}

// Organizations without a subscription keep the free tier: one project and three people. Past
// that they are read-only, except for removals that bring them back within it.
export function blockedWrite(state: CompanyState, list: SubscriptionList | undefined, write: Write, today?: string): string | undefined {
  if (entitlement(list, state.company.id, today) !== 'unpaid') return undefined
  const { address, content } = write
  const removing = ('removed' in content && content.removed) || ('role' in content && content.role === 'removed')
  if (removing) return undefined
  const limits = `The free plan covers ${FREE_PROJECTS} project and ${FREE_PEOPLE} people. The organization owner can subscribe under Plan & billing.`
  if (!withinFreeTier(state)) return `This organization is read-only: it is over the free plan. ${limits}`
  if (address.type === 'project' && !state.projects.some((p) => p.id === address.projectId) && state.projects.length >= FREE_PROJECTS) {
    return `Adding another project needs a subscription. ${limits}`
  }
  if (address.type === 'member' && !state.members.some((m) => m.pubkey === address.pubkey) && state.members.length >= FREE_PEOPLE) {
    return `Adding another person needs a subscription. ${limits}`
  }
  return undefined
}

// Whether an organization can still add a project or a person: always when it is free, paid or in
// its grace period; within the free plan's limits otherwise. Used to offer an upgrade at the limit.
export function room(state: CompanyState, list: SubscriptionList | undefined, today?: string): { projects: boolean; people: boolean } {
  if (entitlement(list, state.company.id, today) !== 'unpaid') return { projects: true, people: true }
  // An organization already over the free plan is read-only, so it has room for nothing.
  const within = withinFreeTier(state)
  return { projects: within && state.projects.length < FREE_PROJECTS, people: within && state.members.length < FREE_PEOPLE }
}

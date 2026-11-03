import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import * as commands from '../src/domain/commands'
import { addDays, blockedWrite, entitlement, room, subscriptionListOf, type SubscriptionList } from '../src/domain/entitlements'
import { OPERATOR, type CompanyState } from '../src/domain/model'

const org = `${'a'.repeat(64)}.x1`
const list: SubscriptionList = { orgs: { [org]: { paidUntil: '2026-12-01' } } }

describe('entitlement', () => {
  it('treats operator-owned organizations as free', () => {
    expect(entitlement(undefined, `${OPERATOR}.abc`)).toBe('free')
  })

  it('is paid through paidUntil, then grace for 7 days, then unpaid', () => {
    expect(entitlement(list, org, '2026-12-01')).toBe('paid')
    expect(entitlement(list, org, '2026-12-08')).toBe('grace')
    expect(entitlement(list, org, '2026-12-09')).toBe('unpaid')
    expect(entitlement(list, `${'b'.repeat(64)}.x2`, '2026-11-01')).toBe('unpaid')
  })

  it('adds days across month ends', () => {
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04')
  })

  it('only trusts the list signed by the billing key', () => {
    const forged = finalizeEvent({ kind: 30078, created_at: 1, tags: [['d', 'canban/subscriptions']], content: JSON.stringify(list) }, generateSecretKey())
    expect(subscriptionListOf([forged])).toBeUndefined()
  })
})

describe('blockedWrite', () => {
  const state = (projects: number, members: number): CompanyState => ({
    company: { id: org, owner: 'a'.repeat(64), name: 'Acme' },
    members: Array.from({ length: members }, (_, i) => ({ pubkey: String(i), role: i ? 'member' : 'owner' })),
    projects: Array.from({ length: projects }, (_, i) => ({ id: `p${i}`, companyId: org, name: `P${i}`, members: [], nextNumber: 0 })),
    lanes: [],
    tasks: [],
  })
  const newProject = commands.createProject(org, 'Another', []).writes[0]

  it('lets unpaid organizations work within the free plan but not grow past it', () => {
    expect(blockedWrite(state(0, 1), undefined, newProject)).toBeUndefined()
    expect(blockedWrite(state(1, 1), undefined, newProject)).toMatch(/another project/)
    expect(blockedWrite(state(1, 3), undefined, commands.setMember(org, 'x', 'member')[0])).toMatch(/another person/)
    expect(blockedWrite(state(1, 3), undefined, commands.setMember(org, '1', 'admin')[0])).toBeUndefined()
  })

  it('makes an organization over the free plan read-only, except for removals', () => {
    const over = state(2, 1)
    expect(blockedWrite(over, undefined, commands.createProject(org, 'x', []).writes[0])).toMatch(/read-only/)
    // Renaming or re-keying the organization stays possible, so a key can always be rotated.
    expect(blockedWrite(over, undefined, commands.renameCompany(org, 'x')[0])).toBeUndefined()
    expect(blockedWrite(over, undefined, commands.removeProject(over.projects[1])[0])).toBeUndefined()
  })

  it('does not limit paid or grace-period organizations', () => {
    expect(blockedWrite(state(5, 9), list, newProject, '2026-12-05')).toBeUndefined()
  })

  it('reports room left on the free plan, and unlimited room when paid', () => {
    expect(room(state(0, 1), undefined)).toEqual({ projects: true, people: true })
    expect(room(state(1, 3), undefined)).toEqual({ projects: false, people: false })
    expect(room(state(2, 2), undefined)).toEqual({ projects: false, people: false })
    expect(room(state(1, 3), list, '2026-11-15')).toEqual({ projects: true, people: true })
  })
})

import type { EventTemplate } from 'nostr-tools'
import { seal, type OrgKey } from './crypto'
import { APP_TAG, KIND, type MemberRole } from './model'

export type Address =
  | { type: 'company'; companyId: string }
  | { type: 'member'; companyId: string; pubkey: string }
  | { type: 'project'; companyId: string; projectId: string }
  | { type: 'lane'; companyId: string; projectId: string; laneId: string }
  | { type: 'task'; companyId: string; projectId: string; taskId: string }

export interface CompanyContent {
  name: string
}
export interface MemberContent {
  role: MemberRole
  name?: string
}
export interface ProjectContent {
  name: string
  members: string[]
  removed?: boolean
}
export interface LaneContent {
  name: string
  order: number
  removed?: boolean
}
export interface TaskContent {
  lane: string
  title: string
  body: string
  order: number
  assignee?: string
  labels: string[]
  number?: number
  // Ids of tasks in the same project that must be finished first.
  dependsOn?: string[]
  removed?: boolean
}

export type Content<A extends Address> = A extends { type: 'company' }
  ? CompanyContent
  : A extends { type: 'member' }
    ? MemberContent
    : A extends { type: 'project' }
      ? ProjectContent
      : A extends { type: 'lane' }
        ? LaneContent
        : TaskContent

export function dOf(address: Address): string {
  switch (address.type) {
    case 'company':
      return `canban:company:${address.companyId}`
    case 'member':
      return `canban:member:${address.companyId}:${address.pubkey}`
    case 'project':
      return `canban:project:${address.companyId}:${address.projectId}`
    case 'lane':
      return `canban:lane:${address.companyId}:${address.projectId}:${address.laneId}`
    case 'task':
      return `canban:task:${address.companyId}:${address.projectId}:${address.taskId}`
  }
}

export function parseD(d: string): Address | undefined {
  const [app, type, companyId, a, b] = d.split(':')
  if (app !== 'canban' || !companyId) return undefined
  if (type === 'company') return { type, companyId }
  if (type === 'member' && a) return { type, companyId, pubkey: a }
  if (type === 'project' && a) return { type, companyId, projectId: a }
  if (type === 'lane' && a && b) return { type, companyId, projectId: a, laneId: b }
  if (type === 'task' && a && b) return { type, companyId, projectId: a, taskId: b }
  return undefined
}

// What access control needs is carried in signed tags as well as content, so the relay and people
// without the organization's key can still tell roles, project assignees and deletions apart.
function accessTags(address: Address, content: Record<string, unknown>): string[][] {
  const tags: string[][] = []
  if (address.type === 'member') {
    tags.push(['p', address.pubkey])
    if (typeof content.role === 'string') tags.push(['role', content.role])
  }
  if (address.type === 'project' && Array.isArray(content.members)) {
    for (const pk of content.members) if (typeof pk === 'string') tags.push(['p', pk])
  }
  if (content.removed === true) tags.push(['removed'])
  return tags
}

// With a key, the content is encrypted and the event names the key in a `k` tag.
export function template<A extends Address>(address: A, content: Content<A>, createdAt: number, key?: OrgKey): EventTemplate {
  const d = dOf(address)
  const tags = [['d', d], ['t', APP_TAG], ['c', address.companyId], ...accessTags(address, content as unknown as Record<string, unknown>)]
  if (!key) return { kind: KIND, created_at: createdAt, tags, content: JSON.stringify(content) }
  return { kind: KIND, created_at: createdAt, tags: [...tags, ['k', key.kid]], content: seal(content, d, key) }
}

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

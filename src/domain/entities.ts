import type { EventTemplate } from 'nostr-tools'
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

export function template<A extends Address>(address: A, content: Content<A>, createdAt: number): EventTemplate {
  const tags = [
    ['d', dOf(address)],
    ['t', APP_TAG],
    ['c', address.companyId],
  ]
  if (address.type === 'member') tags.push(['p', address.pubkey])
  return { kind: KIND, created_at: createdAt, tags, content: JSON.stringify(content) }
}

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

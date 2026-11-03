export const KIND = 30078
export const APP_TAG = 'canban'
export const OPERATOR = 'c14156fdd00160ff55221dadd8616475a318f6d8ca17392dc9ea513b2bac38fe'
export const RELAY_LIST_D = 'canban/members'
export const DEFAULT_LANES = ['To do', 'In progress', 'Complete']
// Encrypted, a body this long (even all 3-byte characters) fits the relay's 64 KB event limit.
export const MAX_TASK_BODY = 10_000
export const MAX_TASK_BODY_BYTES = 30_000

export type Role = 'owner' | 'admin' | 'member'
export type MemberRole = Exclude<Role, 'owner'> | 'removed'

export interface Company {
  id: string
  owner: string
  name: string
}

export interface Member {
  pubkey: string
  role: Role
  name?: string
  // Their member event predates the p tag, so their client can't find this organization by it.
  untagged?: true
}

export interface Project {
  id: string
  companyId: string
  name: string
  members: string[]
  nextNumber: number
  // Some of its content couldn't be read (no key): it must not be written to.
  locked?: boolean
}

export interface Lane {
  id: string
  projectId: string
  name: string
  order: number
}

export interface Task {
  id: string
  projectId: string
  lane: string
  title: string
  body: string
  order: number
  assignee?: string
  labels: string[]
  number?: number
  dependsOn: string[]
  createdBy: string
  createdAt: number
  updatedBy: string
  updatedAt: number
}

export interface CompanyState {
  // Its name or other content couldn't be read (no key).
  locked?: boolean
  // The key new content is encrypted with, named by the newest company event from the owner or an
  // admin, and when that was written. None until encrypted.
  kid?: string
  kidAt?: number
  // Who has been handed the current key, and whether one of them is no longer a member, so an admin
  // must replace it.
  holders?: string[]
  rotationDue?: true
  company: Company
  members: Member[]
  projects: Project[]
  lanes: Lane[]
  tasks: Task[]
}

export function ownerOf(companyId: string): string {
  return companyId.split('.')[0]
}

export function isAdmin(state: CompanyState, pubkey: string): boolean {
  return state.members.some((m) => m.pubkey === pubkey && m.role !== 'member')
}

export function canSee(state: CompanyState, project: Project, pubkey: string): boolean {
  return isAdmin(state, pubkey) || project.members.includes(pubkey)
}

export function visibilityKey(companies: Map<string, CompanyState>, pubkey: string): string {
  const parts: string[] = []
  for (const state of companies.values()) {
    if (!state.members.some((m) => m.pubkey === pubkey)) continue
    parts.push(state.company.id, ...state.projects.filter((p) => canSee(state, p, pubkey)).map((p) => p.id))
  }
  return parts.sort().join(',')
}

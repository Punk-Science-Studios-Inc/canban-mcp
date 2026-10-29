export const KIND = 30078
export const APP_TAG = 'canban'
export const OPERATOR = 'c14156fdd00160ff55221dadd8616475a318f6d8ca17392dc9ea513b2bac38fe'
export const RELAY_LIST_D = 'canban/members'
export const DEFAULT_LANES = ['To do', 'In progress', 'Complete']

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
}

export interface Project {
  id: string
  companyId: string
  name: string
  members: string[]
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
  updatedBy: string
  updatedAt: number
}

export interface CompanyState {
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

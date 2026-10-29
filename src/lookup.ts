import { nip19 } from 'nostr-tools'
import { canSee, type CompanyState, type Lane, type Member, type Project, type Task } from './domain/model'
import { lanesOf } from './domain/commands'

export class LookupError extends Error {}

export interface Scoped<T> {
  state: CompanyState
  item: T
}

const norm = (s: string) => s.trim().toLowerCase()

function pick<T>(kind: string, ref: string, items: T[], id: (t: T) => string, name: (t: T) => string): T {
  const exact = items.filter((t) => id(t) === ref)
  if (exact.length === 1) return exact[0]
  const byName = items.filter((t) => norm(name(t)) === norm(ref))
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) throw new LookupError(`More than one ${kind} is called "${ref}". Use its id: ${byName.map(id).join(', ')}.`)
  const prefix = ref.length >= 6 ? items.filter((t) => id(t).startsWith(ref)) : []
  if (prefix.length === 1) return prefix[0]
  const known = items.map((t) => `"${name(t)}" (${id(t)})`).join(', ')
  throw new LookupError(`No ${kind} matches "${ref}".${known ? ` Known: ${known}.` : ''}`)
}

export function myCompanies(companies: Map<string, CompanyState>, me: string): CompanyState[] {
  return [...companies.values()].filter((c) => c.members.some((m) => m.pubkey === me))
}

export function findCompany(companies: CompanyState[], ref?: string): CompanyState {
  if (!ref) {
    if (companies.length === 1) return companies[0]
    if (companies.length === 0) throw new LookupError('This agent is not in any company yet.')
    throw new LookupError(`This agent is in ${companies.length} companies. Say which: ${companies.map((c) => `"${c.company.name}"`).join(', ')}.`)
  }
  return pick('company', ref, companies, (c) => c.company.id, (c) => c.company.name)
}

export function visibleProjects(companies: CompanyState[], me: string): Scoped<Project>[] {
  return companies.flatMap((state) => state.projects.filter((p) => canSee(state, p, me)).map((item) => ({ state, item })))
}

export function findProject(companies: CompanyState[], me: string, ref: string): Scoped<Project> {
  const all = visibleProjects(companies, me)
  if (all.length === 0) throw new LookupError('This agent is not on any project yet. Ask an admin to tick it in the project\'s Settings.')
  return pick('project', ref, all, (s) => s.item.id, (s) => s.item.name)
}

export function findLane(state: CompanyState, project: Project, ref?: string): Lane {
  const lanes = lanesOf(state, project.id)
  if (lanes.length === 0) throw new LookupError(`"${project.name}" has no lanes.`)
  if (!ref) return lanes[0]
  return pick('lane', ref, lanes, (l) => l.id, (l) => l.name)
}

export function findTask(companies: CompanyState[], me: string, ref: string): Scoped<Task> {
  const visible = new Set(visibleProjects(companies, me).map((s) => s.item.id))
  const all = companies.flatMap((state) => state.tasks.filter((t) => visible.has(t.projectId)).map((item) => ({ state, item })))
  const numbered = /^#?(\d+)$/.exec(ref.trim())
  if (numbered) {
    const matches = all.filter((s) => s.item.number === Number(numbered[1]))
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      const where = matches.map((s) => `"${s.item.title}" in ${s.state.projects.find((p) => p.id === s.item.projectId)?.name} (${s.item.id})`)
      throw new LookupError(`#${numbered[1]} exists in more than one project: ${where.join(', ')}. Use the id.`)
    }
  }
  return pick('task', ref, all, (s) => s.item.id, (s) => s.item.title)
}

export function findMember(state: CompanyState, me: string, ref: string, names: Map<string, string>): Member {
  if (norm(ref) === 'me') return state.members.find((m) => m.pubkey === me)!
  let key = ref.trim()
  if (key.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(key)
      if (decoded.type === 'npub') key = decoded.data
    } catch {
      throw new LookupError(`"${ref}" is not a valid npub.`)
    }
  }
  return pick('person', key, state.members, (m) => m.pubkey, (m) => names.get(m.pubkey) || m.name || '')
}

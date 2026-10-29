import type { NostrEvent } from 'nostr-tools'
import { parseD, type Address, type CompanyContent, type LaneContent, type MemberContent, type ProjectContent, type TaskContent } from './entities'
import { KIND, ownerOf, type CompanyState, type Lane, type Member, type Project, type Task } from './model'

type Versions = NostrEvent[]

interface CompanyEvents {
  company: Versions
  members: Map<string, Versions>
  projects: Map<string, Versions>
  lanes: Map<string, Map<string, Versions>>
  tasks: Map<string, Map<string, Versions>>
}

const MAX_ROLE_PASSES = 8

export function resolve(events: Iterable<NostrEvent>): Map<string, CompanyState> {
  const grouped = group(events)
  const result = new Map<string, CompanyState>()
  for (const [companyId, ce] of grouped) {
    const state = resolveCompany(companyId, ce)
    if (state) result.set(companyId, state)
  }
  return result
}

function group(events: Iterable<NostrEvent>): Map<string, CompanyEvents> {
  const companies = new Map<string, CompanyEvents>()
  for (const event of events) {
    if (event.kind !== KIND) continue
    const d = event.tags.find((t) => t[0] === 'd')?.[1]
    const address = d ? parseD(d) : undefined
    if (!address) continue
    let ce = companies.get(address.companyId)
    if (!ce) {
      ce = { company: [], members: new Map(), projects: new Map(), lanes: new Map(), tasks: new Map() }
      companies.set(address.companyId, ce)
    }
    file(ce, address, event)
  }
  return companies
}

function file(ce: CompanyEvents, address: Address, event: NostrEvent): void {
  const push = (map: Map<string, Versions>, key: string) => map.set(key, [...(map.get(key) ?? []), event])
  const nested = (map: Map<string, Map<string, Versions>>, outer: string, inner: string) => {
    if (!map.has(outer)) map.set(outer, new Map())
    push(map.get(outer)!, inner)
  }
  switch (address.type) {
    case 'company':
      ce.company.push(event)
      break
    case 'member':
      push(ce.members, address.pubkey)
      break
    case 'project':
      push(ce.projects, address.projectId)
      break
    case 'lane':
      nested(ce.lanes, address.projectId, address.laneId)
      break
    case 'task':
      nested(ce.tasks, address.projectId, address.taskId)
      break
  }
}

export function latest(versions: Versions, allowed: (pubkey: string) => boolean): NostrEvent | undefined {
  let best: NostrEvent | undefined
  for (const event of versions) {
    if (!allowed(event.pubkey)) continue
    if (!best || event.created_at > best.created_at || (event.created_at === best.created_at && event.id < best.id)) {
      best = event
    }
  }
  return best
}

function earliest(versions: Versions, allowed: (pubkey: string) => boolean): NostrEvent | undefined {
  let first: NostrEvent | undefined
  for (const event of versions) {
    if (!allowed(event.pubkey)) continue
    if (!first || event.created_at < first.created_at || (event.created_at === first.created_at && event.id < first.id)) first = event
  }
  return first
}

function content<T>(event: NostrEvent | undefined): T | undefined {
  if (!event) return undefined
  try {
    return JSON.parse(event.content) as T
  } catch {
    return undefined
  }
}

function resolveCompany(companyId: string, ce: CompanyEvents): CompanyState | undefined {
  const owner = ownerOf(companyId)
  const company = content<CompanyContent>(latest(ce.company, (pk) => pk === owner))
  if (!company?.name) return undefined

  const roles = resolveRoles(owner, ce.members)
  const ownerEntry = content<MemberContent>(latest(ce.members.get(owner) ?? [], (pk) => pk === owner))
  const members: Member[] = [{ pubkey: owner, role: 'owner', name: ownerEntry?.name }]
  for (const [pubkey, entry] of roles) {
    if (entry.role !== 'removed') members.push({ pubkey, role: entry.role, name: entry.name })
  }
  const memberSet = new Set(members.map((m) => m.pubkey))
  const admins = new Set(members.filter((m) => m.role !== 'member').map((m) => m.pubkey))

  const projects: Project[] = []
  const lanes: Lane[] = []
  const tasks: Task[] = []
  for (const [projectId, versions] of ce.projects) {
    const p = content<ProjectContent>(latest(versions, (pk) => admins.has(pk)))
    if (!p || p.removed) continue
    const assigned = (p.members ?? []).filter((pk) => memberSet.has(pk))
    const project: Project = { id: projectId, companyId, name: p.name, members: assigned, nextNumber: 0 }
    projects.push(project)

    const writers = new Set([...admins, ...assigned])
    const allowed = (pk: string) => writers.has(pk)
    const projectLanes: Lane[] = []
    for (const [laneId, lv] of ce.lanes.get(projectId) ?? []) {
      const l = content<LaneContent>(latest(lv, allowed))
      if (l && !l.removed) projectLanes.push({ id: laneId, projectId, name: l.name, order: l.order })
    }
    projectLanes.sort(byOrder)
    lanes.push(...projectLanes)

    const laneIds = new Set(projectLanes.map((l) => l.id))
    let highest = -1
    for (const [taskId, tv] of ce.tasks.get(projectId) ?? []) {
      const event = latest(tv, allowed)
      const t = content<TaskContent>(event)
      if (event && t && Number.isInteger(t.number)) highest = Math.max(highest, t.number!)
      if (!event || !t || t.removed || projectLanes.length === 0) continue
      const first = earliest(tv, allowed)!
      tasks.push({
        id: taskId,
        projectId,
        lane: laneIds.has(t.lane) ? t.lane : projectLanes[0].id,
        title: t.title,
        body: t.body ?? '',
        order: t.order,
        assignee: t.assignee && memberSet.has(t.assignee) ? t.assignee : undefined,
        labels: t.labels ?? [],
        number: Number.isInteger(t.number) ? t.number : undefined,
        createdBy: first.pubkey,
        createdAt: first.created_at,
        updatedBy: event.pubkey,
        updatedAt: event.created_at,
      })
    }
    project.nextNumber = highest + 1
  }
  projects.sort((a, b) => a.name.localeCompare(b.name))
  tasks.sort(byOrder)

  return { company: { id: companyId, owner, name: company.name }, members, projects, lanes, tasks }
}

function resolveRoles(owner: string, versions: Map<string, Versions>): Map<string, MemberContent> {
  let admins = new Set([owner])
  let roles = new Map<string, MemberContent>()
  for (let pass = 0; pass < MAX_ROLE_PASSES; pass++) {
    roles = new Map()
    for (const [pubkey, v] of versions) {
      if (pubkey === owner) continue
      const entry = content<MemberContent>(latest(v, (pk) => admins.has(pk) && pk !== pubkey))
      if (entry?.role) roles.set(pubkey, entry)
    }
    const next = new Set([owner, ...[...roles].filter(([, r]) => r.role === 'admin').map(([pk]) => pk)])
    if (next.size === admins.size && [...next].every((pk) => admins.has(pk))) break
    admins = next
  }
  return roles
}

function byOrder(a: { order: number; id: string }, b: { order: number; id: string }): number {
  return a.order - b.order || a.id.localeCompare(b.id)
}

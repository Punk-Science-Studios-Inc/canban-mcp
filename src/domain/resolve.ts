import type { NostrEvent } from 'nostr-tools'
import { parseD, type Address, type CompanyContent, type LaneContent, type MemberContent, type ProjectContent, type TaskContent } from './entities'
import { KIND, ownerOf, type CompanyState, type Lane, type Member, type MemberRole, type Project, type Task } from './model'
import { isEncrypted, open, type Keyring } from './crypto'

type Versions = NostrEvent[]

interface CompanyEvents {
  company: Versions
  members: Map<string, Versions>
  projects: Map<string, Versions>
  lanes: Map<string, Map<string, Versions>>
  tasks: Map<string, Map<string, Versions>>
}

const MAX_ROLE_PASSES = 8

// With a keyring, encrypted content is read; without the right key, structure (organizations,
// roles, project assignees) still comes from signed tags and names are empty.
export function resolve(events: Iterable<NostrEvent>, keyring?: Keyring): Map<string, CompanyState> {
  const grouped = group(events)
  const result = new Map<string, CompanyState>()
  for (const [companyId, ce] of grouped) {
    const state = resolveCompany(companyId, ce, keyring)
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

const tag = (event: NostrEvent, name: string) => event.tags.find((t) => t[0] === name)
const removedTag = (event: NostrEvent) => !!tag(event, 'removed')
const ROLES: MemberRole[] = ['admin', 'member', 'removed']
const validRole = (role: unknown): MemberRole | undefined => (ROLES.includes(role as MemberRole) ? (role as MemberRole) : undefined)

// Signed tags decide roles, assignees and deletions whenever an event carries them, so clients and
// the relay always agree; content only supplies names. Old plaintext events without tags fall back
// to their content.
function memberEntry(event: NostrEvent | undefined, keyring?: Keyring): MemberContent | undefined {
  if (!event) return undefined
  const read = open<MemberContent>(event, keyring)
  const roleTag = tag(event, 'role')
  const role = validRole(roleTag ? roleTag[1] : isEncrypted(event) ? undefined : read?.role)
  return role ? { role, name: typeof read?.name === 'string' ? read.name : undefined } : undefined
}

const hasAccessTags = (event: NostrEvent) => isEncrypted(event) || event.tags.some((t) => t[0] === 'role' || t[0] === 'removed' || (t[0] === 'p' && !!t[1]))

function resolveCompany(companyId: string, ce: CompanyEvents, keyring?: Keyring): CompanyState | undefined {
  const owner = ownerOf(companyId)
  // The owner's signed company event makes the organization real, whether or not its name can be read.
  const companyEvent = latest(ce.company, (pk) => pk === owner)
  if (!companyEvent) return undefined
  const read = open<CompanyContent>(companyEvent, keyring)
  if (!isEncrypted(companyEvent) && !read?.name) return undefined
  const company = { name: read?.name ?? '' }
  const companyLocked = !read

  const roles = resolveRoles(owner, ce.members, keyring)
  const ownerEntry = memberEntry(latest(ce.members.get(owner) ?? [], (pk) => pk === owner), keyring)
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
    const event = latest(versions, (pk) => admins.has(pk))
    if (!event) continue
    const p = open<ProjectContent>(event, keyring)
    if (!p && !isEncrypted(event)) continue
    if (removedTag(event) || p?.removed) continue
    const listed = hasAccessTags(event) ? event.tags.filter((t) => t[0] === 'p').map((t) => t[1]) : (p?.members ?? [])
    const assigned = listed.filter((pk) => memberSet.has(pk))
    const project: Project = { id: projectId, companyId, name: p?.name ?? '', members: assigned, nextNumber: 0, locked: !p }
    projects.push(project)

    const writers = new Set([...admins, ...assigned])
    const allowed = (pk: string) => writers.has(pk)
    const projectLanes: Lane[] = []
    for (const [laneId, lv] of ce.lanes.get(projectId) ?? []) {
      const laneEvent = latest(lv, allowed)
      const l = open<LaneContent>(laneEvent, keyring)
      if (laneEvent && !l && isEncrypted(laneEvent) && !removedTag(laneEvent)) project.locked = true
      if (l && !l.removed && !(laneEvent && removedTag(laneEvent))) projectLanes.push({ id: laneId, projectId, name: l.name, order: l.order })
    }
    projectLanes.sort(byOrder)
    lanes.push(...projectLanes)

    const laneIds = new Set(projectLanes.map((l) => l.id))
    let highest = -1
    for (const [taskId, tv] of ce.tasks.get(projectId) ?? []) {
      const event = latest(tv, allowed)
      const t = open<TaskContent>(event, keyring)
      // An unreadable task may hold a number, so new numbers can't be chosen safely.
      if (event && !t && isEncrypted(event)) project.locked = true
      if (event && t && Number.isInteger(t.number)) highest = Math.max(highest, t.number!)
      if (!event || !t || t.removed || removedTag(event) || projectLanes.length === 0) continue
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
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
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
  const projectOf = new Map(tasks.map((t) => [t.id, t.projectId]))
  for (const t of tasks) t.dependsOn = [...new Set(t.dependsOn)].filter((id) => id !== t.id && projectOf.get(id) === t.projectId)

  return { locked: companyLocked, company: { id: companyId, owner, name: company.name }, members, projects, lanes, tasks }
}

function resolveRoles(owner: string, versions: Map<string, Versions>, keyring?: Keyring): Map<string, MemberContent> {
  let admins = new Set([owner])
  let roles = new Map<string, MemberContent>()
  for (let pass = 0; pass < MAX_ROLE_PASSES; pass++) {
    roles = new Map()
    for (const [pubkey, v] of versions) {
      if (pubkey === owner) continue
      const entry = memberEntry(latest(v, (pk) => admins.has(pk) && pk !== pubkey), keyring)
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

import { newId, type Address, type Content, type LaneContent, type TaskContent } from './entities'
import { DEFAULT_LANES, type CompanyState, type Lane, type MemberRole, type Project, type Task } from './model'
import { between } from './order'

export type Write = { [A in Address as A['type']]: { address: A; content: Content<A> } }[Address['type']]

function write<A extends Address>(address: A, content: Content<A>): Write {
  return { address, content } as Write
}

export function createCompany(owner: string, name: string): { companyId: string; writes: Write[] } {
  const companyId = `${owner}.${newId()}`
  return {
    companyId,
    writes: [write({ type: 'company', companyId }, { name }), write({ type: 'member', companyId, pubkey: owner }, { role: 'admin' })],
  }
}

export function renameCompany(companyId: string, name: string): Write[] {
  return [write({ type: 'company', companyId }, { name })]
}

export function setMember(companyId: string, pubkey: string, role: MemberRole, name?: string): Write[] {
  return [write({ type: 'member', companyId, pubkey }, { role, ...(name ? { name } : {}) })]
}

export function createProject(companyId: string, name: string, members: string[]): { projectId: string; writes: Write[] } {
  const projectId = newId()
  const lanes = DEFAULT_LANES.map((laneName, i) =>
    write({ type: 'lane', companyId, projectId, laneId: newId() }, { name: laneName, order: between(undefined, undefined) * (i + 1) }),
  )
  return { projectId, writes: [write({ type: 'project', companyId, projectId }, { name, members }), ...lanes] }
}

export function updateProject(project: Project, patch: Partial<Pick<Project, 'name' | 'members'>>): Write[] {
  const { companyId, id: projectId } = project
  return [write({ type: 'project', companyId, projectId }, { name: project.name, members: project.members, ...patch })]
}

export function removeProject(project: Project): Write[] {
  const { companyId, id: projectId } = project
  return [write({ type: 'project', companyId, projectId }, { name: project.name, members: project.members, removed: true })]
}

export function createLane(companyId: string, projectId: string, name: string, after?: Lane): Write[] {
  return [write({ type: 'lane', companyId, projectId, laneId: newId() }, { name, order: between(after?.order, undefined) })]
}

export function updateLane(companyId: string, lane: Lane, patch: Partial<LaneContent>): Write[] {
  return [write({ type: 'lane', companyId, projectId: lane.projectId, laneId: lane.id }, { name: lane.name, order: lane.order, ...patch })]
}

export function createTask(
  project: Project,
  lane: string,
  title: string,
  last?: Task,
  extra: Partial<Pick<TaskContent, 'body' | 'labels' | 'assignee'>> = {},
): { taskId: string; number: number; writes: Write[] } {
  const taskId = newId()
  const number = project.nextNumber
  return {
    taskId,
    number,
    writes: [
      write(
        { type: 'task', companyId: project.companyId, projectId: project.id, taskId },
        { lane, title, body: extra.body ?? '', order: between(last?.order, undefined), labels: extra.labels ?? [], assignee: extra.assignee, number },
      ),
    ],
  }
}

export function updateTask(companyId: string, task: Task, patch: Partial<TaskContent>): Write[] {
  const { lane, title, body, order, assignee, labels, number } = task
  return [write({ type: 'task', companyId, projectId: task.projectId, taskId: task.id }, { lane, title, body, order, assignee, labels, number, ...patch })]
}

// Two people can pick the same number at once. The task created first keeps it; each later
// one is renumbered by whoever created it, so every client agrees and only one writes.
export function renumberings(state: CompanyState, me: string): Write[] {
  const writes: Write[] = []
  for (const project of state.projects) {
    const byNumber = new Map<number, Task[]>()
    for (const t of tasksOf(state, project.id)) {
      if (t.number === undefined) continue
      byNumber.set(t.number, [...(byNumber.get(t.number) ?? []), t])
    }
    let next = project.nextNumber
    for (const group of byNumber.values()) {
      if (group.length < 2) continue
      group.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      for (const loser of group.slice(1)) {
        if (loser.createdBy === me) writes.push(...updateTask(state.company.id, loser, { number: next++ }))
      }
    }
  }
  return writes
}

export function lanesOf(state: CompanyState, projectId: string): Lane[] {
  return state.lanes.filter((l) => l.projectId === projectId)
}

export function tasksOf(state: CompanyState, projectId: string): Task[] {
  return state.tasks.filter((t) => t.projectId === projectId)
}

export function tasksInLane(state: CompanyState, laneId: string): Task[] {
  return state.tasks.filter((t) => t.lane === laneId)
}

export function canWrite(state: CompanyState, project: Project, pubkey: string): boolean {
  return state.members.some((m) => m.pubkey === pubkey && m.role !== 'member') || project.members.includes(pubkey)
}

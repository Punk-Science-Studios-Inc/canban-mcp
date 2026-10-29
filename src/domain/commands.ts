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
  companyId: string,
  projectId: string,
  lane: string,
  title: string,
  last?: Task,
  extra: Partial<Pick<TaskContent, 'body' | 'labels' | 'assignee'>> = {},
): { taskId: string; writes: Write[] } {
  const taskId = newId()
  return {
    taskId,
    writes: [
      write(
        { type: 'task', companyId, projectId, taskId },
        { lane, title, body: extra.body ?? '', order: between(last?.order, undefined), labels: extra.labels ?? [], assignee: extra.assignee },
      ),
    ],
  }
}

export function updateTask(companyId: string, task: Task, patch: Partial<TaskContent>): Write[] {
  const { lane, title, body, order, assignee, labels } = task
  return [write({ type: 'task', companyId, projectId: task.projectId, taskId: task.id }, { lane, title, body, order, assignee, labels, ...patch })]
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

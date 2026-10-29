import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import * as commands from './domain/commands'
import type { CompanyState, Project, Task } from './domain/model'
import type { Board } from './board'
import type { Identity } from './identity'
import { findCompany, findLane, findMember, findProject, findTask, LookupError, myCompanies, visibleProjects } from './lookup'

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }

const ok = (value: unknown): Result => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
const fail = (message: string): Result => ({ content: [{ type: 'text', text: message }], isError: true })

export const INSTRUCTIONS = `Canban is a kanban board for small teams, stored on a Nostr relay.
Companies hold people and projects; projects hold lanes (columns) and tasks (cards).
Every task has a number within its project, shown as #0, #1, …; refer to tasks by that number, id or title, and to projects, lanes and people by id or exact name. Call whoami first if a tool says this agent has no access.
Changes appear live to everyone watching the board. Task bodies are markdown.`

export function registerTools(server: McpServer, board: Board, me: Identity): void {
  const guard = <A,>(fn: (args: A) => Promise<Result>) => async (args: A): Promise<Result> => {
    await board.ready()
    if (board.connection === 'denied') return fail(noAccess(me))
    try {
      return await fn(args)
    } catch (error) {
      if (error instanceof LookupError) return fail(error.message)
      return fail(error instanceof Error ? error.message : String(error))
    }
  }
  const mine = () => myCompanies(board.companies(), me.pubkey)
  const writable = (state: CompanyState, project: Project) => {
    if (!commands.canWrite(state, project, me.pubkey)) {
      throw new LookupError(`This agent can see "${project.name}" but is not on it. Ask an admin to tick it in the project's Settings.`)
    }
  }
  const nameOf = async (state: CompanyState) => {
    const names = await board.names(state.members.map((m) => m.pubkey))
    return (pk?: string) => (pk ? names.get(pk) || state.members.find((m) => m.pubkey === pk)?.name || pk.slice(0, 8) : undefined)
  }
  const taskView = (t: Task, name: (pk?: string) => string | undefined, withBody = false) => ({
    id: t.id,
    number: t.number,
    title: t.title,
    labels: t.labels,
    assignee: name(t.assignee),
    ...(withBody ? { body: t.body, updatedBy: name(t.updatedBy), updatedAt: new Date(t.updatedAt * 1000).toISOString() } : { hasBody: !!t.body }),
  })

  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description: "This agent's Nostr identity, relay status and the companies it belongs to. Explains how to grant access if it has none.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      await board.ready()
      const companies = mine()
      return ok({
        npub: me.npub,
        relay: board.connection,
        companies: companies.map((c) => ({ id: c.company.id, name: c.company.name, projects: visibleProjects([c], me.pubkey).map((s) => s.item.name) })),
        ...(companies.length === 0 || board.connection === 'denied' ? { nextStep: noAccess(me) } : {}),
      })
    },
  )

  server.registerTool(
    'list_projects',
    { title: 'List projects', description: 'Projects this agent can see, with lane and task counts.', annotations: { readOnlyHint: true } },
    guard(async () =>
      ok(
        visibleProjects(mine(), me.pubkey).map(({ state, item }) => ({
          id: item.id,
          name: item.name,
          company: state.company.name,
          lanes: commands.lanesOf(state, item.id).map((l) => `${l.name} (${commands.tasksInLane(state, l.id).length})`),
          canEdit: commands.canWrite(state, item, me.pubkey),
        })),
      ),
    ),
  )

  server.registerTool(
    'get_board',
    {
      title: 'Get board',
      description: 'Every lane of a project in order, with its tasks in order. Bodies are omitted; use get_task for one.',
      inputSchema: { project: z.string().describe('Project id or name') },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ project }: { project: string }) => {
      const { state, item } = findProject(mine(), me.pubkey, project)
      const name = await nameOf(state)
      return ok({
        project: { id: item.id, name: item.name, people: item.members.map((pk) => name(pk)) },
        lanes: commands.lanesOf(state, item.id).map((l) => ({ id: l.id, name: l.name, tasks: commands.tasksInLane(state, l.id).map((t) => taskView(t, name)) })),
      })
    }),
  )

  server.registerTool(
    'get_task',
    {
      title: 'Get task',
      description: 'One task in full, including its markdown body and lane.',
      inputSchema: { task: z.string().describe('Task number ("#12"), id, or exact title') },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ task }: { task: string }) => {
      const { state, item } = findTask(mine(), me.pubkey, task)
      const name = await nameOf(state)
      const lane = state.lanes.find((l) => l.id === item.lane)
      const project = state.projects.find((p) => p.id === item.projectId)
      return ok({ ...taskView(item, name, true), lane: lane?.name, project: project?.name })
    }),
  )

  server.registerTool(
    'create_task',
    {
      title: 'Create task',
      description: 'Add a task to the bottom of a lane. Defaults to the first lane.',
      inputSchema: {
        project: z.string().describe('Project id or name'),
        title: z.string().min(1),
        lane: z.string().optional().describe('Lane id or name; defaults to the first lane'),
        body: z.string().optional().describe('Markdown description'),
        labels: z.array(z.string()).optional(),
        assignee: z.string().optional().describe('Person name, npub, or "me"'),
      },
    },
    guard(async (args: { project: string; title: string; lane?: string; body?: string; labels?: string[]; assignee?: string }) => {
      const { state, item } = findProject(mine(), me.pubkey, args.project)
      writable(state, item)
      const lane = findLane(state, item, args.lane)
      const names = await board.names(state.members.map((m) => m.pubkey))
      const assignee = args.assignee ? findMember(state, me.pubkey, args.assignee, names).pubkey : undefined
      const last = commands.tasksInLane(state, lane.id).at(-1)
      const { taskId, number, writes } = commands.createTask(item, lane.id, args.title.trim(), last, {
        body: args.body,
        labels: cleanLabels(args.labels),
        assignee,
      })
      await board.apply(writes)
      return ok({ created: taskId, number, lane: lane.name, project: item.name })
    }),
  )

  server.registerTool(
    'update_task',
    {
      title: 'Update task',
      description: 'Change a task\'s title, body, labels or assignee. Fields left out stay as they are. Pass assignee "" to unassign.',
      inputSchema: {
        task: z.string().describe('Task number ("#12"), id, or exact title'),
        title: z.string().min(1).optional(),
        body: z.string().optional().describe('Replaces the whole markdown body'),
        labels: z.array(z.string()).optional().describe('Replaces all labels'),
        assignee: z.string().optional().describe('Person name, npub, "me", or "" to unassign'),
      },
    },
    guard(async (args: { task: string; title?: string; body?: string; labels?: string[]; assignee?: string }) => {
      const { state, item } = findTask(mine(), me.pubkey, args.task)
      writable(state, projectOf(state, item))
      const names = await board.names(state.members.map((m) => m.pubkey))
      const patch = {
        ...(args.title !== undefined ? { title: args.title.trim() } : {}),
        ...(args.body !== undefined ? { body: args.body } : {}),
        ...(args.labels !== undefined ? { labels: cleanLabels(args.labels) } : {}),
        ...(args.assignee !== undefined ? { assignee: args.assignee.trim() ? findMember(state, me.pubkey, args.assignee, names).pubkey : undefined } : {}),
      }
      await board.apply(commands.updateTask(state.company.id, item, patch))
      return ok({ updated: item.id, changed: Object.keys(patch) })
    }),
  )

  server.registerTool(
    'move_task',
    {
      title: 'Move task',
      description: 'Move a task to another lane (or reorder within one), at the top or bottom.',
      inputSchema: {
        task: z.string().describe('Task number ("#12"), id, or exact title'),
        lane: z.string().describe('Destination lane id or name'),
        position: z.enum(['top', 'bottom']).optional().describe('Defaults to bottom'),
      },
    },
    guard(async (args: { task: string; lane: string; position?: 'top' | 'bottom' }) => {
      const { state, item } = findTask(mine(), me.pubkey, args.task)
      const project = projectOf(state, item)
      writable(state, project)
      const lane = findLane(state, project, args.lane)
      const others = commands.tasksInLane(state, lane.id).filter((t) => t.id !== item.id)
      const order = args.position === 'top' ? (others[0]?.order ?? 1024) - 1024 : (others.at(-1)?.order ?? 0) + 1024
      await board.apply(commands.updateTask(state.company.id, item, { lane: lane.id, order }))
      return ok({ moved: item.id, lane: lane.name, position: args.position ?? 'bottom' })
    }),
  )

  server.registerTool(
    'delete_task',
    {
      title: 'Delete task',
      description: 'Remove a task from the board for everyone.',
      inputSchema: { task: z.string().describe('Task number ("#12"), id, or exact title') },
      annotations: { destructiveHint: true },
    },
    guard(async ({ task }: { task: string }) => {
      const { state, item } = findTask(mine(), me.pubkey, task)
      writable(state, projectOf(state, item))
      await board.apply(commands.updateTask(state.company.id, item, { removed: true }))
      return ok({ deleted: item.id, title: item.title })
    }),
  )

  server.registerTool(
    'create_lane',
    {
      title: 'Create lane',
      description: 'Add a lane to the right-hand end of a project.',
      inputSchema: { project: z.string().describe('Project id or name'), name: z.string().min(1) },
    },
    guard(async ({ project, name }: { project: string; name: string }) => {
      const { state, item } = findProject(mine(), me.pubkey, project)
      writable(state, item)
      await board.apply(commands.createLane(state.company.id, item.id, name.trim(), commands.lanesOf(state, item.id).at(-1)))
      return ok({ created: name.trim(), project: item.name })
    }),
  )

  server.registerTool(
    'rename_lane',
    {
      title: 'Rename lane',
      description: 'Rename a lane in a project.',
      inputSchema: { project: z.string().describe('Project id or name'), lane: z.string().describe('Lane id or current name'), name: z.string().min(1) },
    },
    guard(async (args: { project: string; lane: string; name: string }) => {
      const { state, item } = findProject(mine(), me.pubkey, args.project)
      writable(state, item)
      const lane = findLane(state, item, args.lane)
      await board.apply(commands.updateLane(state.company.id, lane, { name: args.name.trim() }))
      return ok({ renamed: lane.name, to: args.name.trim() })
    }),
  )

  server.registerTool(
    'list_people',
    {
      title: 'List people',
      description: 'People in a company, with their roles. Use their names as task assignees.',
      inputSchema: { company: z.string().optional().describe('Company id or name; optional if the agent is in only one') },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ company }: { company?: string }) => {
      const state = findCompany(mine(), company)
      const name = await nameOf(state)
      return ok(state.members.map((m) => ({ name: name(m.pubkey), role: m.role, isMe: m.pubkey === me.pubkey })))
    }),
  )
}

function projectOf(state: CompanyState, task: Task): Project {
  return state.projects.find((p) => p.id === task.projectId)!
}

function cleanLabels(labels?: string[]): string[] {
  return [...new Set((labels ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean))]
}

function noAccess(me: Identity): string {
  return `This agent's key is not in any Canban company yet. In Canban, open People, add ${me.npub} with a name such as "Claude", then tick it in each project's Settings. The relay admits it once the company owner has Canban open.`
}

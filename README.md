# canban-mcp

An MCP server that lets AI agents read and work [Canban](https://punkscience.ca/canban/) boards.
Canban is a kanban board for small teams whose data lives on a Nostr relay. This server runs on
the user's own machine, signs with its own Nostr key, and talks straight to the relay. There is no
Canban server, no account and no API token.

---

## For AI agents: install and set up canban-mcp for your user

Follow these steps in order. Each one says what to run, what you should see, and what to do if
you don't. Run the commands yourself where you can; only step 5 needs the user.

### 1. Check Node.js

```sh
node --version
```

You need **v22 or later**. If `node` is missing or older, stop and tell the user:
"canban-mcp needs Node.js 22 or later. Install it from https://nodejs.org, then ask me again."

### 2. Download the server

macOS and Linux:

```sh
git clone --depth 1 https://github.com/Punk-Science-Studios-Inc/canban-mcp.git "$HOME/.local/share/canban-mcp" \
  || git -C "$HOME/.local/share/canban-mcp" pull --ff-only
```

Windows (PowerShell):

```powershell
git clone --depth 1 https://github.com/Punk-Science-Studios-Inc/canban-mcp.git "$env:LOCALAPPDATA\canban-mcp"
```

There is nothing to build or install: `dist/canban-mcp.mjs` is a single self-contained file. The
rest of this guide calls its **absolute path** `SERVER`, for example
`/home/alex/.local/share/canban-mcp/dist/canban-mcp.mjs`. Expand `$HOME` or `%LOCALAPPDATA%`
yourself; MCP config files do not.

If `git` is missing, tell the user to install it and stop.

### 3. Pick a key file for this agent

Each agent gets its own Nostr key, so its changes on the board are labelled as its own and the
user can remove it on its own. Choose a file name that names your client:

| You are | Key file |
|---|---|
| Claude Code | `$HOME/.config/canban/claude-code.nsec` |
| Claude Desktop | `$HOME/.config/canban/claude-desktop.nsec` |
| Cursor | `$HOME/.config/canban/cursor.nsec` |
| Codex | `$HOME/.config/canban/codex.nsec` |
| Anything else | `$HOME/.config/canban/<your-client-name>.nsec` |

On Windows use `%APPDATA%\canban\<name>.nsec`. Use the absolute path everywhere below; the
rest of this guide calls it `KEY_FILE`.

### 4. Create the key and get its npub

macOS and Linux:

```sh
CANBAN_KEY_FILE="KEY_FILE" node "SERVER" --whoami
```

Windows (PowerShell):

```powershell
$env:CANBAN_KEY_FILE = "KEY_FILE"; node "SERVER" --whoami
```

Expected output: one line starting with `npub1`, plus, the first time, a note that a new key was
saved. The key file is created readable only by the user. **Never print, copy or send the
contents of the key file.** The npub is public and safe to show.

### 5. Ask the user to let the agent in

Give the user this message, with the real npub and your name filled in:

> To let me work on your Canban boards:
> 1. Open https://punkscience.ca/canban and sign in.
> 2. Go to **People** (bottom left) and add `npub1…` with the name "<your name, e.g. Claude Code>".
> 3. Open each project I should work on, click **Settings**, and tick "<your name>".
>
> Tell me when that's done. If you aren't an admin of the company, ask an admin to do it. If the
> person who added me isn't the company owner, the owner needs to open Canban once before I can
> connect.

Carry on with the next step while you wait; the last step checks whether access has been granted.

### 6. Register the server with your client

Replace `SERVER` and `KEY_FILE` with the absolute paths from steps 2 and 3.

**Claude Code** (run it; `--scope user` makes it work in every project):

```sh
claude mcp add canban --scope user -e CANBAN_KEY_FILE="KEY_FILE" -- node "SERVER"
```

**Claude Desktop**: add this to `claude_desktop_config.json`, merging with any existing
`mcpServers`, then tell the user to restart Claude Desktop. The file is at
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and
`%APPDATA%\Claude\claude_desktop_config.json` on Windows.

**Cursor**: the same JSON goes in `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "canban": {
      "command": "node",
      "args": ["SERVER"],
      "env": { "CANBAN_KEY_FILE": "KEY_FILE" }
    }
  }
}
```

**Codex**: add this to `~/.codex/config.toml`:

```toml
[mcp_servers.canban]
command = "node"
args = ["SERVER"]
env = { CANBAN_KEY_FILE = "KEY_FILE" }
```

**Any other MCP client**: register a **stdio** server with command `node`, argument `SERVER`,
and environment variable `CANBAN_KEY_FILE`. If you don't know where your client keeps its MCP
config, ask the user rather than guessing.

Most clients only load new MCP servers at the start of a session. If the `canban` tools don't
appear, tell the user to restart the client or start a new session.

### 7. Verify

Call the `whoami` tool.

| Result | Meaning | Do this |
|---|---|---|
| `"relay": "live"` and a company in `companies` | Working | Call `list_projects` and tell the user which projects you can see |
| `companies` is empty, or `relay` is `"denied"` | Not let in yet | Repeat the step 5 message. If the user says it's done, ask them to have the company owner open Canban, then call `whoami` again |
| A company but no projects | In the company, not on a project | Ask the user to tick you in the project's **Settings** |
| `relay` is `"offline"` | Can't reach the relay | Tell the user `wss://relay.punkscience.ca` is unreachable |

Setup is complete when `list_projects` returns at least one project with `"canEdit": true`.

### Updating

```sh
git -C "$HOME/.local/share/canban-mcp" pull --ff-only
```

Then restart the client. The key file is untouched, so the agent keeps its identity.

---

## Using the tools

Projects, lanes, tasks and people can be given by id or by exact name (case doesn't matter).
`"me"` as an assignee means the agent. Changes appear live to everyone watching the board.

| Tool | Does |
|---|---|
| `whoami` | The agent's npub, relay status, and companies; explains how to get access |
| `list_projects` | Projects the agent can see, lane counts, and whether it can edit them |
| `get_board` | A project's lanes and tasks, in order (no task bodies) |
| `get_task` | One task in full, including its markdown body |
| `create_task` | Add a task to a lane (defaults to the first lane), with optional body, labels and assignee |
| `update_task` | Change title, body, labels or assignee; `assignee: ""` unassigns |
| `move_task` | Move a task to a lane, at the top or bottom |
| `delete_task` | Remove a task for everyone |
| `create_lane`, `rename_lane` | Add a lane at the end, or rename one |
| `list_people` | People in a company and their roles, for assigning |

Good habits: call `get_board` before changing a board you haven't seen this session, prefer
`move_task` over editing a task's lane by hand, and confirm with the user before `delete_task`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CANBAN_KEY_FILE` | `~/.config/canban/agent.nsec` | The agent's key; created on first run |
| `CANBAN_NSEC` | none | Use this nsec instead of a key file |
| `CANBAN_RELAY` | `wss://relay.punkscience.ca` | Relay to connect to |

## Security

- The key file holds the agent's secret key, created with permissions `600`. Anyone with it can
  act as the agent, so don't commit, share or paste it.
- The agent can only write to projects it is ticked on. Removing it on the People page cuts it
  off at once.
- Board content is not encrypted. Any member of the relay could read it with a raw Nostr client.

## Develop

```sh
npm ci
npm test         # tools against an in-process relay that enforces NIP-42 login
npm run build    # rebuilds dist/canban-mcp.mjs, which is committed
```

`src/domain/` is copied from the Canban web app, which owns the data model. After changing it
there, run `npm run sync-domain` (it expects `../canban`), then test, build and commit `dist/`.
CI fails if the committed bundle doesn't match the source.

## Licence

MIT. See [LICENSE](LICENSE).

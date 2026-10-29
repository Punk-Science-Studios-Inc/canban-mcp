# AGENTS.md

canban-mcp: a stdio MCP server for Canban boards on Nostr. `README.md` is written for agents
*installing* it; this file is for agents *working on* it.

- `npm test` runs the tools against `test/relay.ts`, an in-process relay that enforces NIP-42.
- `npm run build` bundles everything into `dist/canban-mcp.mjs`, which is committed so
  `npx github:Punk-Science-Studios-Inc/canban-mcp` works with no build step. Rebuild and commit it
  with every source change; CI fails on a stale bundle.
- `src/domain/` is a copy from the Canban web app (`Punk-Science-Studios-Inc/canban`,
  `src/domain/`). Change it there first, then `npm run sync-domain`. Never edit it only here.
- All writes go through `src/domain/commands.ts`; the server must not build events any other way.
- Never log or return the agent's secret key.

# Synapse

Synapse is a realtime coordination layer for teams using coding agents. Agents still write the code; Synapse gives them current team context before they edit, then records contract-level changes after they edit so other agents can avoid collisions.

The planning source of truth lives in:

- [synapse-context.md](/Users/princekumar/Documents/synapseWork/synapse-context.md)
- [synapse-build-plan.md](/Users/princekumar/Documents/synapseWork/synapse-build-plan.md)
- [synapse-technical-spec.md](/Users/princekumar/Documents/synapseWork/synapse-technical-spec.md)

## Current Build Track

We are starting with Milestone 0 from the build plan:

1. Create the repository and README.
2. Scaffold a TypeScript monorepo.
3. Define shared protocol types.
4. Add a stub server that shares live state between daemon sessions.
5. Add a local daemon/CLI exposing `synapse_check` and `synapse_report`.
6. Verify one session can report an edit and a second session can see the conflict.

The first implementation is intentionally in-memory and local-only. It proves the hot loop before we add persistence, auth, analyzers, GitHub webhooks, or real hook installation.

## Architecture Shape

```text
apps/
  cli/          local daemon plus CLI commands
  server/       local websocket fanout server
packages/
  analyzer-ts/ TypeScript contract extraction
  protocol/     shared wire, state, and symbol types
  conflict-engine/
                pure conflict evaluator
```

## Local Development

Prerequisite: Node.js 20+ and npm.

```bash
npm install
npm run build
npm test
```

Inspect TypeScript contracts from a file:

```bash
npm run build
npm run dev --workspace @synapse/cli -- analyze --file packages/analyzer-ts/src/index.ts
```

Start the local coordination server:

```bash
npm run dev --workspace @synapse/server
```

Start two local daemon sessions in separate terminals:

```bash
npm run dev --workspace @synapse/cli -- daemon --member alice --session alice --port 4011
npm run dev --workspace @synapse/cli -- daemon --member bob --session bob --port 4012
```

Report an unpushed contract change from Alice:

```bash
npm run dev --workspace @synapse/cli -- report --port 4011 --file src/auth/token.ts --symbol ts:src/auth/token.ts#TokenValidator.validate --summary "TokenValidator.validate now returns Result<Token, AuthError>"
```

Check the same symbol from Bob:

```bash
npm run dev --workspace @synapse/cli -- check --port 4012 --file src/auth/token.ts --symbol ts:src/auth/token.ts#TokenValidator.validate
```

Expected result: Bob receives a `warn` verdict for `same_symbol_unpushed`.

## Decisions In Force

These are already resolved in the planning docs and should guide implementation unless we explicitly revise them:

- Single repo first.
- Self-hosted first.
- TypeScript server/daemon with polyglot analyzers later.
- Local daemon keeps raw code local.
- Agents query; agents decide. Synapse warns inline, never auto-blocks.
- TypeScript/JS and Python analyzers are the first language targets.
- Dependency-graph-grade conflict detection is the moat.

## Open Decisions

Before changing these, ask the project owner:

- Exact session lifecycle and idle timeout.
- Edit lock granularity for v1: symbol-level only, file-level fallback, or both.
- Python resolver packaging: pyright, jedi, or both behind the sidecar.
- Graph cache format and acceptable initial index time.
- Self-host packaging strategy for the Python sidecar.
- Wire-protocol auth and token rotation.

## Roadmap

- Milestone 0: runnable skeleton and realtime stub loop.
- Milestone 1: TS/Python contract extraction, contract delta diffing, Redis/Postgres-backed live state, severity scoring.
- Milestone 2: dependency graph, MCP adapter, GitHub webhooks, cross-agent support.
- Milestone 3: team briefings.
- Milestone 4: persistent memory.

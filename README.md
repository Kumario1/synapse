<div align="center">

# Synapse

**A realtime coordination layer for teams using coding agents.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](LICENSE)
[![Built by Prince Kumar](https://img.shields.io/badge/Built%20by-Prince%20Kumar-blue?style=for-the-badge)](#license)
[![Node](https://img.shields.io/badge/Node-20%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Status](https://img.shields.io/badge/Status-In%20development-orange?style=for-the-badge)](#roadmap)

</div>

> Agents still write the code. Synapse gives them current team context **before** they edit, then records contract-level changes **after** they edit, so other agents can avoid collisions.

---

## Features

<table>
  <tr>
    <td><b>Contract-level conflicts</b></td>
    <td>Compares real <code>before</code> → <code>after</code> signatures and classifies them <i>breaking / compatible / identical / divergent</i> — not just "same file touched."</td>
  </tr>
  <tr>
    <td><b>Polyglot analyzers</b></td>
    <td>TypeScript contract extraction in-process; Python via a long-lived <b>tree-sitter + jedi</b> sidecar over JSON-RPC/stdio. Same conflict engine for both.</td>
  </tr>
  <tr>
    <td><b>Deterministic first</b></td>
    <td>Detection is never the LLM. An optional <a href="https://openrouter.ai">OpenRouter</a> layer only enriches analysis and resolution — it can raise, never downgrade, a verdict.</td>
  </tr>
  <tr>
    <td><b>Claude Code hooks</b></td>
    <td><code>synapse join</code> installs <code>PreToolUse</code> / <code>PostToolUse</code> / <code>SessionStart</code> hooks so checks fire automatically — no manual tool calls.</td>
  </tr>
  <tr>
    <td><b>MCP adapter</b></td>
    <td>A thin stdio MCP server exposes the same daemon tools to any MCP-capable agent.</td>
  </tr>
  <tr>
    <td><b>Team briefings</b></td>
    <td><code>synapse whatsup</code> gives a deterministic team-state briefing from the daemon's warm cache.</td>
  </tr>
  <tr>
    <td><b>Memory search</b></td>
    <td><code>synapse why</code> searches durable team state and answers with cited sources.</td>
  </tr>
  <tr>
    <td><b>Durable state</b></td>
    <td>Server state persists through a storage-agnostic <code>StateStore</code> (SQLite now; Postgres/Redis later) and survives restarts.</td>
  </tr>
  <tr>
    <td><b>Seamless multi-machine</b></td>
    <td><code>synapse up</code> resolves identity from the git remote, joins, preflights, and starts the daemon; <code>synapse doctor</code> diagnoses why two machines aren't coordinating.</td>
  </tr>
  <tr>
    <td><b>Resilient channel</b></td>
    <td>Reconnect with backoff + jitter, a capped offline outbox flushed in order on reconnect, and dead-socket detection — no message loss across outages.</td>
  </tr>
  <tr>
    <td><b>Observable</b></td>
    <td>One JSON log line per event and Prometheus counters at <code>GET /metrics</code> (aggregate only — never repo content or identity).</td>
  </tr>
  <tr>
    <td><b>Ship anywhere</b></td>
    <td>Dockerized server with per-project keys (<code>synapse keygen</code>) for real tenancy, or install <code>@synapse/cli</code> as a self-contained tarball.</td>
  </tr>
</table>

---

## Quick Start

**Prerequisites:** Node.js 20+ and npm. Python 3.10+ is optional — needed only to analyze `.py` files; without it, Python degrades gracefully to file-level detection.

```bash
npm install
npm run build
npm test
```

**Seamless multi-machine setup** — two machines coordinate when their daemons share the same `repoId` (auto-derived from the git remote) against the same server.

```bash
# Host: start the server, expose it over a public wss:// tunnel,
# write the URL into .synapse/team.json, and print the teammate command + token.
synapse up --serve --tunnel

# Teammate: commit .synapse/team.json, share the token out-of-band, then:
SYNAPSE_AUTH_TOKEN=<token> synapse up
```

`synapse doctor` diagnoses a setup without starting anything (resolved identity, server reachability, auth vs. unreachable, protocol version, live peers).

---

## Commands

The CLI binary is `synapse` (`apps/cli/src/index.ts`). In a dev checkout, run any command via `npm run dev --workspace @synapse/cli -- <command>`.

| Command | Description |
| --- | --- |
| `daemon` | Start the local daemon |
| `check` | Call the local `synapse_check` endpoint |
| `report` | Call the local `synapse_report` endpoint |
| `push` | Notify Synapse that files were pushed |
| `feedback` | Record acted/dismissed feedback for a conflict warning |
| `session` | Start, heartbeat, or end a local session |
| `whatsup` | Show the daemon's current team-state briefing |
| `why` | Search Synapse memory with source citations |
| `mcp` | Run a stdio MCP server forwarding tools to the local daemon |
| `join` | Write `.synapse/config.json` and install Claude Code hooks |
| `up` | join + preflight + start daemon (`--serve` / `--tunnel` for the host) |
| `keygen` | Mint a project-scoped key for this repo (needs `SYNAPSE_MASTER_SECRET`) |
| `doctor` | Preflight: identity, server reachability, auth, and live peers |
| `hook` | Claude Code hook entrypoint (`pre`\|`post`); reads hook JSON on stdin |
| `analyze` | Extract TypeScript contract symbols from a file |
| `help` | Print usage and examples |

---

## Architecture

```text
apps/
  cli/          local daemon, CLI commands, and MCP stdio adapter
  server/       websocket fanout server + durable StateStore (SQLite)
packages/
  analyzer-ts/      TypeScript contract extraction
  analyzer-py/      Python contract extraction + dependency graph
                    (tree-sitter + jedi sidecar over JSON-RPC/stdio)
  protocol/         shared wire, state, and symbol types
  conflict-engine/  pure conflict evaluator
```

The server is single-process with an in-memory hot path backed by a durable store. The daemon keeps raw code local. Detection is deterministic; humans decide — Synapse warns inline, never auto-blocks.

---

## Deterministic vs. optional LLM (OpenRouter)

| Layer | Without a key | With `OPENROUTER_API_KEY` |
| --- | --- | --- |
| Detection | Fully deterministic | Unchanged (never affected) |
| Analysis | Structured before→after verdict | Task-aware prose; can raise but not downgrade a verdict |
| Resolution | `contract_divergent` → escalate; `same_symbol_unpushed` → adopt counterpart | Synthesizes one merged contract (must parse via the real analyzer) |
| Session summary | Structured list of changes | 2–3 prose sentences |

Set the key in `.env` (see `.env.example`). Model defaults to `anthropic/claude-haiku-4.5`, overridable via `SYNAPSE_LLM_MODEL`. Disable layers independently with `SYNAPSE_LLM_EXPLAIN=0`, `SYNAPSE_LLM_RESOLVE=0`, `SYNAPSE_LLM_SUMMARY=0`.

---

## Server auth modes

Resolved at server startup. `/health` and the GitHub webhook (its own HMAC) stay open; credentials are sent via `?token=` / `Authorization: Bearer` and compared in constant time — never written to disk.

| Mode | Trigger | Behavior |
| --- | --- | --- |
| **open** | neither var set | No auth — keeps local/dev and verify scripts hermetic |
| **shared-token** | `SYNAPSE_AUTH_TOKEN` | Any valid token reads/writes any project |
| **project-key** | `SYNAPSE_MASTER_SECRET` | Real tenancy: key = `base64url(HMAC-SHA256(secret, repoId))`, authorizes only its project (checked at handshake + per-message) |

Credentials are sent via `Authorization: Bearer` (the server still accepts `?token=` for back-compat), keeping tokens out of URL query strings and access logs. State store selected by `SYNAPSE_DB_PATH`: unset → ephemeral in-memory SQLite; a file path → file-backed SQLite (WAL) that survives restarts.

---

## Reliability & operations

| Capability | Summary |
| --- | --- |
| **Resilient channel** | Exponential backoff + full jitter (`SYNAPSE_RECONNECT_BASE_MS` / `SYNAPSE_RECONNECT_MAX_MS`), capped offline outbox flushed in order on reconnect, and 20s server pings (`SYNAPSE_WS_PING_INTERVAL_MS`) that terminate half-open sockets |
| **Observability** | JSON logs gated by `SYNAPSE_LOG_LEVEL` (default `info`) + Prometheus counters at `GET /metrics` |
| **Ingress validation** | Every wire message is validated against shared zod schemas before any state mutation; WS/webhook bodies capped at 1MB (`SYNAPSE_MAX_PAYLOAD_BYTES`) |
| **Adaptive severity** | `synapse_feedback` telemetry demotes a noisy rule (≥5 dismissals, ≥80% dismiss rate) from `warn` to `info`; detection never changes. Opt out with `SYNAPSE_ADAPTIVE_SEVERITY=0` |

**Install as a package** — `@synapse/cli` packs as a self-contained tarball (all five workspace packages, server, and the Python sidecar bundled):

```bash
node apps/cli/scripts/pack.mjs   # prints the tarball path
```

**CI** — `.github/workflows/ci.yml` runs build + typecheck + test plus the full hermetic verify matrix:

```bash
npm run verify:all                                       # one build, then every verify
node scripts/ci-verify-all.mjs --only why,doctor         # a subset while iterating
SYNAPSE_VERIFY_SKIP=hot-path-latency npm run verify:all  # explicit skips
```

---

## Verification scripts

Run with `npm run <script>`. See [`package.json`](package.json) for the complete list.

| Script | Verifies |
| --- | --- |
| `verify:m0` | Runnable skeleton + realtime stub loop (milestone 0) |
| `verify:analyzer-ts` / `verify:analyzer-py` | Per-language contract extraction and signature diffing |
| `verify:python-check` | Full realtime Python loop → `contract_divergent` + resolution |
| `verify:daemon-ts-report` / `verify:file-only-ts-check` | Automatic TS report path; symbol-level conflicts from a file path |
| `verify:dependency-ts-check` | Warns when a file depends on another's unpushed change |
| `verify:contract-compat` / `verify:resolution` | Compatibility classification; merged-contract resolution |
| `verify:hot-path-latency` / `verify:large-repo-latency` / `verify:repo-latency` | Pre-edit hot-path latency budgets (p95 ≤ 50ms, max ≤ 150ms) |
| `verify:whatsup` / `verify:why` / `verify:feedback` | Team briefing; memory search; conflict feedback telemetry |
| `verify:session-summary` / `verify:session-start` | Layer II session summaries and catch-up briefing |
| `verify:hooks` | Claude Code `join` + `hook pre`/`hook post` as invoked by Claude Code |
| `verify:mcp-adapter` | Stdio MCP adapter forwarding to the daemon |
| `verify:auth` / `verify:tenancy` | Shared-token and project-key auth paths |
| `verify:up` / `verify:up-tunnel` / `verify:doctor` | Multi-machine setup, tunnels, and preflight diagnostics |
| `verify:persistence` | State survives a server restart |
| `verify:reconnect` | A delta emitted while the server is down still reaches the team after restart |
| `verify:metrics` | Structured logs and `/metrics` counters |
| `verify:adaptive-severity` | Feedback-tuned demotion of noisy warnings |
| `verify:docker` | Builds the server image, boots it, drives one edit→report |
| `verify:npm-pack` | Packs the CLI, installs into a fresh project, joins, drives a check |
| `verify:github-webhook` / `verify:github-briefing` | GitHub push/PR/review/comment webhooks and catch-ups |
| `verify:all` | One build, then every verify (the CI matrix) |
| `eval:conflicts` | Recorded conflict eval suite (overlap, breaking, compatible, divergent, …) |

---

## Documentation

Planning is the source of truth — there is no public docs site.

| Doc | Contents |
| --- | --- |
| [`synapse-context.md`](synapse-context.md) | Product context and rationale |
| [`synapse-build-plan.md`](synapse-build-plan.md) | Milestone build plan |
| [`synapse-technical-spec.md`](synapse-technical-spec.md) | Technical specification |
| [`apps/cli/src/index.ts`](apps/cli/src/index.ts) | CLI commands and daemon |

---

## Roadmap

| Milestone | Scope |
| --- | --- |
| **0** | Runnable skeleton and realtime stub loop |
| **1** | TS/Python contract extraction, delta diffing, durable live state, severity scoring |
| **2** | Dependency graph, MCP adapter, GitHub webhooks, cross-agent support |
| **3** | Team briefings |
| **4** | Persistent memory (`synapse why` deterministic seed now; pgvector/RAG later) |

---

## License

[MIT](LICENSE) © 2026 Prince Kumar

<div align="center">

**Built by Prince Kumar**

</div>

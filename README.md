# Synapse

Synapse is a realtime coordination layer for teams using coding agents. Agents still write the code; Synapse gives them current team context before they edit, then records contract-level changes after they edit so other agents can avoid collisions.

The planning source of truth lives in:

- [synapse-context.md](/Users/princekumar/Documents/synapseWork/synapse-context.md)
- [synapse-build-plan.md](/Users/princekumar/Documents/synapseWork/synapse-build-plan.md)
- [synapse-technical-spec.md](/Users/princekumar/Documents/synapseWork/synapse-technical-spec.md)

## Current Build Track

The repository now has the local realtime loop in place:

1. TypeScript monorepo, shared protocol types, and in-memory fanout server.
2. Local daemon/CLI with joined config defaults, `synapse_check`, `synapse_report`,
   `synapse_push`, and session tools.
3. TypeScript contract extraction, file-only checks, dependency checks, compatibility analysis, and
   deterministic/optional-LLM contract resolution.
4. Python contract extraction and cross-file dependency graphs via a long-lived analyzer sidecar
   (tree-sitter + jedi), routed through the same conflict engine as TypeScript.
5. Deterministic `synapse whatsup` team-state briefing from the daemon's warm cache, plus durable
   session summaries (Layer II) distilled on session end and GitHub PR/review/comment activity.
6. Deterministic `synapse why` memory search over the same durable team state, with source citations
   from session summaries, repo events, pushes, resolutions, and live deltas.
7. Stdio MCP adapter so MCP-capable agents can call the same daemon tools without shell-specific
   integration code.
8. Durable server state via a `StateStore` (SQLite): live sessions, unpushed deltas, recent pushes,
   edit locks, and resolutions survive a server restart.
9. Automatic Claude Code hooks installed by `synapse join`: `PreToolUse` checks before an edit and
   `PostToolUse` reports after, via the `synapse hook` entrypoint.
10. A deterministic hot-path latency verifier for the file-only pre-edit check path: two daemons,
   separate worktrees, no external network or LLM calls, with p95 and max latency budgets enforced.
   A larger synthetic verifier covers the same path across 181 TypeScript source files.

The server is single-process with an in-memory hot path backed by a durable store. Postgres/Redis
(for multi-instance fan-out) can implement the same `StateStore` later without touching server logic.
The daemon↔server channel supports optional shared-token auth; GitHub OAuth is the planned upgrade.

## Install from npm (quickstart)

The CLI ships as a single npm package (the five internal `@synapse/*` workspace packages are bundled
inside the tarball). The installed command is `synapse`.

```bash
npm install -g @kumario/synapse   # or: npx @kumario/synapse <command>

# Host (one machine runs the coordination server and exposes it):
cd your-repo
synapse up --serve --tunnel       # prints the teammate onboarding command

# Each teammate, in their clone of the same repo:
synapse up
```

`synapse up` derives the repo identity from the git remote, writes `.synapse/config.json`, installs
the Claude Code hooks, prepares the Python analyzer venv, runs a `synapse doctor` preflight, and
starts the daemon. Leave it running; it is the local coordination process everything else talks to.

### Using the installed CLI

**Host (first machine).** Run the server alongside your daemon and expose it:

```bash
cd your-repo
synapse up --serve --tunnel
```

This boots the coordination server, opens a public `wss://` tunnel (needs `cloudflared` or `ngrok`
on PATH; without one it falls back to printing a LAN URL), generates a shared auth token, writes the
server URL into the committable `.synapse/team.json`, and prints the exact command teammates run.
Commit `.synapse/team.json`; share the token privately. On a trusted LAN you can skip the tunnel:
`synapse up --serve` and teammates pass `--server ws://<your-ip>:4010`.

**Teammates.** Pull the repo (so `.synapse/team.json` is present), then:

```bash
SYNAPSE_AUTH_TOKEN=<token> synapse up
```

**Claude Code** needs nothing else — `up` installed `PreToolUse`/`PostToolUse`/`SessionStart` hooks
into `.claude/settings.json`, so every edit is checked against the team's in-flight changes
automatically and reported afterward.

**Cursor / Cline / Aider (MCP).** Register the stdio MCP server; it forwards tool calls
(`synapse_check`, `synapse_report`, `synapse_whatsup`, `synapse_why`, `synapse_feedback`) to the
running daemon. For Cursor, in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "synapse": { "command": "synapse", "args": ["mcp"] }
  }
}
```

**Day-to-day commands** (all read defaults from `.synapse/config.json`):

```bash
synapse doctor          # why aren't two machines coordinating? identity/server/auth/peers preflight
synapse whatsup         # briefing: active sessions, unpushed contract deltas, locks, recent pushes
synapse why --question "why did auth validation change?"   # memory search with cited sources
synapse check --file src/auth/token.ts                     # manual pre-edit conflict check
synapse feedback --conflict-id conflict:abc123 --outcome acted   # tell Synapse a warning helped
synapse analyze --file src/index.ts                        # inspect extracted contract symbols
```

Optional LLM layer: set `OPENROUTER_API_KEY` (and optionally `SYNAPSE_LLM_MODEL`) in the daemon's
environment to upgrade conflict analysis and session summaries. Everything works deterministically
without it.

### Releasing

`npm run verify:package` proves the artifact end-to-end (pack → clean install → real two-machine
`up` flow), then `npm run package` stages and packs `dist-release/<name>-<version>.tgz` for
`npm publish --access public`. The public name/version live in `release.config.json`.

## Architecture Shape

```text
apps/
  cli/          local daemon, CLI commands, and MCP stdio adapter
  server/       websocket fanout server + durable StateStore (SQLite)
packages/
  analyzer-ts/ TypeScript contract extraction
  analyzer-py/ Python contract extraction + dependency graph (tree-sitter +
               jedi sidecar, driven over JSON-RPC/stdio)
  protocol/     shared wire, state, and symbol types
  conflict-engine/
                pure conflict evaluator
```

## Local Development

Prerequisites: Node.js 20+ and npm. Python 3.10+ is required only for analyzing
`.py` files; without it, Python files degrade gracefully to file-level detection.

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

Write local command defaults for a repo:

```bash
npm run dev --workspace @synapse/cli -- join --member alice --session alice --port 4011 --server ws://localhost:4010
npm run dev --workspace @synapse/cli -- daemon
npm run verify:join-config
```

`synapse join` writes `.synapse/config.json`. Daemon and CLI commands read it as defaults, using this
precedence: explicit flags, environment variables, `.synapse/config.json`, the committed
`.synapse/team.json`, the git-derived repo id, then built-in defaults.

## Seamless Multi-Machine Setup (`synapse up` + `synapse doctor`)

Two machines coordinate only if their daemons use the **same `repoId`** against the **same server**.
Synapse now makes that line up by itself:

- **Git-derived identity.** When no `repoId` is set explicitly, it is derived from the git remote
  (`git@github.com:acme/widgets.git` → `github.com/acme/widgets`), so two clones of the same repo share
  a coordination room with zero configuration. Branch is intentionally **not** part of the key — you
  still get warned about a teammate editing the same symbol on another branch.
- **Committable team config.** `.synapse/team.json` (the one file under `.synapse/` that is **not**
  gitignored) carries the shared, non-secret server URL (and an optional `repoId`), so a teammate
  inherits it on checkout. Secrets never go here — the auth token is env-only.

`synapse up` is one command per machine: it resolves identity, joins (config + Claude Code hooks +
Python venv), runs a `synapse doctor` preflight, then starts the daemon — aborting with a clear message
instead of silently reconnecting forever.

Host (runs the server and exposes it over a public `wss://` tunnel — cloudflared or ngrok):

```bash
synapse up --serve --tunnel
# → starts the server, opens a tunnel, writes the wss URL into .synapse/team.json,
#   and prints the exact teammate command + a generated auth token (share it out-of-band).
```

Commit the updated `.synapse/team.json`, share the token over Slack/1Password (never in git), then each
teammate pulls and runs:

```bash
SYNAPSE_AUTH_TOKEN=<token> synapse up
```

`synapse doctor` diagnoses a setup without starting anything — it prints the resolved identity, warns
loudly when `repoId` is `"local"` (the #1 reason two machines don't see each other), checks that the
server is reachable, distinguishes a 401 auth failure from an unreachable server, compares protocol
versions, and lists the live peers in your room:

```bash
synapse doctor
npm run verify:up        # two daemons, one git-derived room, mutual visibility
npm run verify:doctor    # health/auth/peer checks, including the failure messages
```

## Claude Code Hooks (automatic checks)

`synapse join` also installs Claude Code hooks into the repo's `.claude/settings.json`, so Synapse
fires automatically — no manual tool calls. It merges into existing settings idempotently and never
disturbs hooks you already have:

- **`PreToolUse`** on `Edit|Write|MultiEdit` → `synapse hook pre`: runs `synapse_check` for the target
  file. On a conflict it returns a Claude Code `ask` decision so the developer sees the heads-up and
  decides (proceed / adjust / coordinate) — "agents query, humans decide," never an auto-block.
- **`PostToolUse`** on `Edit|Write|MultiEdit` → `synapse hook post`: runs `synapse_report` for the
  changed file so the contract delta fans out to the team.
- **`SessionStart`** (`startup|resume|clear`) → `synapse hook session-start`: injects a Layer II
  catch-up — recent pushes, teammates' unpushed contract changes, and recent session summaries —
  as context, excluding your own work. Silent when there is nothing new.

The `synapse hook` entrypoint reads Claude Code's hook JSON on stdin, maps the edited file to a
repo-relative path, and talks to the local daemon. It is defensive by design: a missing daemon, an
out-of-tree file, or any error exits cleanly without ever interrupting or failing the edit. Set
`SYNAPSE_HOOK_NONBLOCKING=1` to inject the heads-up as context and proceed without a prompt instead of
asking.

```bash
npm run verify:hooks   # dogfoods join + `hook pre`/`hook post` exactly as Claude Code invokes them
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

When `--symbol` is omitted for a TypeScript/JavaScript file, the daemon reads the file, extracts
contracts locally, compares against its previous snapshot, and reports only public contract changes.

Check the same symbol from Bob:

```bash
npm run dev --workspace @synapse/cli -- check --port 4012 --file src/auth/token.ts --symbol ts:src/auth/token.ts#TokenValidator.validate
```

Expected result: Bob receives a `warn` verdict for `same_symbol_unpushed`.

Ask Bob's daemon for the current team-state briefing:

```bash
npm run dev --workspace @synapse/cli -- whatsup --port 4012
npm run verify:whatsup
```

The briefing summarizes active sessions, unpushed contract deltas, edit locks, recent pushes, shared
contract resolutions, and ended-session summaries. It is deterministic and reads from the daemon's
local warm cache.

### Session summaries (Layer II)

When a session ends (`synapse session --action end`), the daemon distills what that session changed
into a durable `SessionSummary` — a short narrative of its contract deltas plus the task — and
publishes it so teammates can catch up. It is deterministic by default (a structured list of the
session's changes); with `OPENROUTER_API_KEY` set it is upgraded to 2-3 prose sentences. Summaries are
stored in team state (so they survive a restart) and surfaced in `whatsup`. This never runs in the
edit hot path — only on session end. Set `SYNAPSE_LLM_SUMMARY=0` to force the deterministic summary
even with a key.

```bash
npm run verify:session-summary   # deterministic, no key required
```

On the other end, a starting session gets a **catch-up briefing**: the `SessionStart` hook
(`synapse hook session-start`) digests recent pushes, recent GitHub PR/review/comment activity,
teammates' unpushed contract changes, and recent session summaries from `whatsup` and injects them as
context — your own work filtered out — so an agent resumes with the team's current picture. It is
silent when nothing has changed.

```bash
npm run verify:session-start     # deterministic, no key required
```

Verify the automatic TypeScript report path:

```bash
npm run verify:daemon-ts-report
```

Verify that a check with only a TypeScript file path can still find symbol-level conflicts:

```bash
npm run verify:file-only-ts-check
```

Benchmark the same file-only pre-edit path used by Claude Code hooks:

```bash
npm run verify:hot-path-latency
npm run verify:large-repo-latency
npm run verify:repo-latency
```

This synthetic local benchmark starts a server plus Alice/Bob daemons in separate one-file
worktrees, disables OpenRouter, measures no-conflict and warning checks, and asserts p95 <= 50ms and
max <= 150ms for both paths.

The large-repo variant generates 181 TypeScript source files, records the cold first-check time, then
enforces the same warm p95/max budgets for no-conflict checks and dependency-warning checks. It is a
synthetic guardrail.

The repo-latency variant snapshots the tracked Synapse repo with `git archive HEAD`, runs two daemons
against separate temp worktrees, records the cold first-check time, then enforces the same warm
p95/max budgets for no-conflict checks and a real same-symbol warning on `deterministicAnalysis`.
External production-repo profiling remains a separate validation step.

Verify that a checked TypeScript file warns when it depends on another file's unpushed contract
change:

```bash
npm run verify:dependency-ts-check
```

## Python Analysis (tree-sitter + jedi sidecar)

Python files are analyzed by a long-lived sidecar process that the daemon drives
over newline-delimited JSON-RPC on stdio. It uses **tree-sitter** for
deterministic contract extraction (module functions, classes, public methods,
dataclass/annotated fields, and annotated module constants) and **jedi** for
accurate cross-file reference resolution in the dependency graph. The sidecar
emits the same language-neutral `CodeSymbol` shapes (`py:path#name` ids) the
TypeScript analyzer does, so Python changes flow through the identical conflict
engine, compatibility classifier, and resolver. Detection is never the LLM.

The sidecar runs in a per-package virtualenv with pinned dependencies. Create or
refresh it (idempotent — a stamp file skips reinstalls until `requirements.txt`
changes):

```bash
npm run setup:analyzer-py
```

`synapse join` runs this automatically. The base interpreter can be overridden
with `SYNAPSE_PYTHON_BASE`, and the daemon can be pointed at a specific
interpreter with `SYNAPSE_PYTHON`. If no Python is found, Python files fall back
to file-level detection instead of breaking the daemon.

Inspect Python contracts from a file:

```bash
npm run dev --workspace @synapse/cli -- analyze --file packages/analyzer-py/python/synapse_analyzer/extract.py
```

Run the analyzer-py unit tests (contract extraction, stable sigHash, signature
diffing, and jedi cross-file edges):

```bash
npm run verify:analyzer-py
```

Verify the full realtime Python loop — two daemons in separate worktrees rewrite
the same Python symbol to incompatible return types, and the daemon detects the
`contract_divergent` conflict and attaches a resolution (fully deterministic, no
API key):

```bash
npm run verify:python-check
```

Run the recorded conflict eval suite:

```bash
npm run eval:conflicts
```

The eval fixtures cover the current warning/no-warning contract: no overlap, same-symbol breaking,
same-symbol compatible, direct dependency, divergent contracts, stale base, and same-file low-noise.

Notify Synapse that pushed files should leave live unpushed state:

```bash
npm run dev --workspace @synapse/cli -- push --port 4011 --file src/auth/token.ts --sha abc123 --summary "Pushed auth token changes"
npm run verify:push-state-reset
```

The server accepts GitHub webhooks at `POST /webhooks/github`. `push` events clear matching live
state and record a recent push. `pull_request`, `pull_request_review`, and `issue_comment` events are
stored as recent repo activity and surfaced in `whatsup` and `SessionStart` catch-ups. For local/dev
repos, pass `?repoId=local`; otherwise the webhook uses `repository.full_name` as the Synapse repo id.
Set `SYNAPSE_GITHUB_WEBHOOK_SECRET` to require GitHub's `X-Hub-Signature-256` HMAC check.

```bash
npm run verify:github-webhook
npm run verify:github-briefing
```

## Durable Server State

The server holds each repo's live `TeamState` (sessions, unpushed contract deltas, recent pushes,
edit locks, and resolutions) in an in-memory cache for the hot path and persists every mutation
through a `StateStore` so a restart resumes where it left off. The store is selected by
`SYNAPSE_DB_PATH`:

- **unset** — in-memory SQLite. Ephemeral, identical to the pre-persistence behavior. This keeps the
  verify scripts and tests hermetic.
- **a file path** — file-backed SQLite (WAL). State survives a restart.

```bash
SYNAPSE_DB_PATH=.synapse-server/state.db npm run dev --workspace @synapse/server
```

The `StateStore` interface (`apps/server/src/store.ts`) is storage-agnostic: a future Postgres/Redis
implementation for multi-instance fan-out satisfies the same contract without changing server logic.

Verify that state survives a restart (creates state over HTTP, kills the server, restarts against the
same database, and asserts the state resumed from disk):

```bash
npm run verify:persistence
```

## Ship to a Machine (Docker server + per-project keys)

Ship the **server** to a machine and have a team "just work" with two inputs: a project key (auth) and
a project identity (`repoId`, auto-derived from the git remote). The server is the one always-on piece;
the per-dev daemon stays a local CLI, since it needs your working tree and writes Claude Code hooks.

```bash
# 1. On the host: bring up the Dockerized server with project-key auth.
cp .env.example .env          # set SYNAPSE_MASTER_SECRET to a long random string
docker compose up -d          # starts just the server; state persists in a named volume

# 2. Mint a per-project key (resolves repoId from the git remote, like `up`):
SYNAPSE_MASTER_SECRET=<secret> synapse keygen
# → prints base64url(HMAC-SHA256(secret, repoId)); share it out-of-band (Slack/1Password).

# 3. Each teammate, in their clone, points at the server and connects with the key:
#    (commit .synapse/team.json with the server URL so the URL is inherited)
SYNAPSE_PROJECT_KEY=<key> synapse up
```

The image builds the server (and only its `@synapse/protocol` + `@synapse/conflict-engine` deps) in a
`node:20` builder and runs it on `node:20-slim`, so `better-sqlite3`'s native binding matches the
runtime. Point `SYNAPSE_DB_PATH` at the mounted volume (compose does this) for durable state.

```bash
npm run verify:docker   # builds the image, boots it, drives one edit→report (skipped if no daemon)
```

## Server Auth (open / shared-token / project-key)

The daemon↔server channel resolves one of three modes at server startup. In every mode `/health` stays
open, the GitHub webhook keeps its own HMAC, and the credential is sent via `?token=` /
`Authorization: Bearer` (flag/env only — never written to `.synapse/config.json`, so secrets stay off
disk) and compared in constant time.

- **project-key** (`SYNAPSE_MASTER_SECRET` set) — **real tenancy.** A key is
  `base64url(HMAC-SHA256(master secret, repoId))`; it authorizes *its* project only. The server
  recomputes the HMAC for the requested `repoId` at the handshake **and** rejects any per-message
  payload that targets a different repo (`forbidden_repo`). Mint keys with `synapse keygen`.
- **shared-token** (`SYNAPSE_AUTH_TOKEN` set, no master secret) — the original all-or-nothing token: any
  valid token reads/writes any project.
- **open** (neither set) — no auth; keeps local/dev and the verify scripts hermetic.

DB-backed API keys / a GitHub-OAuth-minted JWT carrying `allowedRepoIds` are the intended multi-tenant
upgrade, reusing the same two checkpoints (handshake + per-message repo binding).

```bash
# project-key mode
SYNAPSE_MASTER_SECRET=secret npm run dev --workspace @synapse/server
SYNAPSE_MASTER_SECRET=secret npm run dev --workspace @synapse/cli -- keygen --repo-id github.com/acme/app
npm run dev --workspace @synapse/cli -- daemon --key <key> --repo-id github.com/acme/app
npm run verify:tenancy

# shared-token mode
SYNAPSE_AUTH_TOKEN=secret npm run dev --workspace @synapse/server
npm run dev --workspace @synapse/cli -- daemon --token secret
npm run verify:auth
```

Expose the same daemon tools to MCP-capable agents:

```bash
npm run dev --workspace @synapse/cli -- mcp --port 4012
npm run verify:mcp-adapter
```

The MCP adapter is intentionally thin. It runs over stdio, registers `synapse_check`,
`synapse_report`, `synapse_feedback`, `synapse_push`, `synapse_session`, `synapse_whatsup`, and
`synapse_why`, then forwards each call to the local daemon. The daemon remains the single place that
owns contract extraction, conflict detection, LLM analysis, resolution, briefing, feedback, and memory
search.

## Memory Search (Layer III seed)

`synapse why` is the first deterministic slice of Layer III. It searches the daemon's warm team-state
cache — session summaries, GitHub PR/review/comment events, recent pushes, shared resolutions,
conflict feedback, unpushed contract deltas, and active sessions — and returns a short answer with
cited sources. It is not vector/RAG yet; pgvector and Slack/Notion ingestion remain the planned memory
backend.

```bash
npm run dev --workspace @synapse/cli -- why --port 4012 --question "why did auth validation change?"
npm run verify:why
```

## Contract-Level Conflict Classification

A check no longer just reports that two agents touched the same symbol — it compares the
actual `before`/`after` signatures and classifies whether the change is really a conflict:

- The deterministic comparator (`compareSignatures` in `@synapse/conflict-engine`) labels each
  change `breaking`, `compatible`, `identical`, or `unknown` and lists concrete reasons.
- Each `Conflict` carries a structured `change` (the real before -> after) and an `analysis` —
  an actionable, both-sides verdict: an `assessment`, a `recommendation`
  (`block`/`warn`/`info`/`proceed`), and `actions` addressed to each side (`you` /
  `counterpart` / `both`). Backward-compatible changes are demoted to `info`; breaking and
  unclassifiable changes stay `warn`.
- When both agents have an unpushed change to the same symbol with different resulting shapes, the
  engine raises `contract_divergent` — the strongest "you two must agree" signal.

```bash
npm run verify:contract-compat
```

## Conflict Feedback Telemetry

Every emitted `Conflict` carries a deterministic `id`, so an agent or developer can record whether a
surfaced warning was acted on or dismissed. This is telemetry only: it does not change verdicts or
auto-tune thresholds yet. Feedback is stored in the durable team state, surfaced in `whatsup`, and
available through the CLI/daemon/MCP path.

```bash
npm run dev --workspace @synapse/cli -- feedback --port 4012 --conflict-id conflict:abc123 --outcome acted --note "Adjusted caller"
npm run verify:feedback
```

## Contract Resolution (converging two agents on one contract)

Beyond *advice*, a `contract_divergent` conflict carries a `resolution` (`ProposedResolution`) — a
concrete merged contract both agents adopt so their edits converge:

- **Deterministic baseline (always present, no key).** `contract_divergent` resolves to an
  *escalate* (`reconciled:false`, `recommendation:"block"`) naming both sides' contracts — it never
  guesses a merge. `same_symbol_unpushed` resolves to *adopt-the-counterpart* (`reconciled:true`),
  since only one side changed the symbol.
- **Canonical & converged.** A computed resolution is stored once in the server's `TeamState`, keyed
  by `symbol + inputsHash` (a symmetric hash of both diffs), first-writer-wins, and broadcast — so
  both agents read the *same* object. Any new delta or push for the symbol invalidates it.
- **Optional LLM resolver (with a key).** For `contract_divergent` only, the daemon asks the model
  (temperature 0, symmetric A/B prompt, caller-aware via the file + dependency-graph neighbors) to
  synthesize one signature. The proposed contract must parse via the real analyzer or it falls back
  to the deterministic escalate. Unreconcilable intents return `block` with a reason.

```bash
npm run verify:resolution   # fully deterministic, no key required
```

### Optional LLM analysis (OpenRouter)

Detection stays fully deterministic. An optional layer turns the conflict — including the **code
diffs from both sides** — into a richer, task-aware actionable analysis. It runs through
[OpenRouter](https://openrouter.ai) (any chat model) over plain HTTP, so there is no extra SDK
dependency and it never affects the verdict.

Set the key in one place (`.env`, see `.env.example`) and start the daemon with Node's env-file
support:

```bash
cp .env.example .env   # then paste your OPENROUTER_API_KEY
node --env-file=.env apps/cli/dist/index.js daemon --member bob --session bob --port 4012
```

The model defaults to `anthropic/claude-haiku-4.5` (per the build plan) and is overridable via
`SYNAPSE_LLM_MODEL`. The same key enables the contract resolver (above); `SYNAPSE_LLM_EXPLAIN=0` and
`SYNAPSE_LLM_RESOLVE=0` disable each layer independently. With no key set, the daemon runs fully
offline on the deterministic analysis and resolution.

To verify the OpenRouter path locally:

```bash
set -a
source .env
set +a

npm run verify:contract-compat
npm run verify:resolution
```

When OpenRouter is used, the output's `analysis.source` or `analysis.resolution.source` is the model
slug. If the model fails or times out, Synapse falls back to `source:"deterministic"`. The model can
raise a recommendation, but it cannot downgrade a deterministic warning into `info` or `proceed`.

## Decisions In Force

These are already resolved in the planning docs and should guide implementation unless we explicitly revise them:

- Single repo first.
- Self-hosted first.
- TypeScript server/daemon with polyglot analyzers (TypeScript in-process,
  Python in a tree-sitter + jedi sidecar).
- Local daemon keeps raw code local.
- Agents query; agents decide. Synapse warns inline, never auto-blocks.
- TypeScript/JS and Python analyzers are the first language targets.
- Python analysis runs in a long-lived sidecar over JSON-RPC/stdio, parsing with
  tree-sitter and resolving cross-file references with jedi, in a pinned venv.
- Dependency-graph-grade conflict detection is the moat.

## Open Decisions

Before changing these, ask the project owner:

- Exact session lifecycle and idle timeout.
- Edit lock granularity for v1: symbol-level only, file-level fallback, or both.
- Graph cache format and acceptable initial index time.
- Self-host packaging of the Python sidecar venv (shipped venv, container, or
  on-join `pip install` — currently on-join install).
- Whether to keep the sidecar warm across the hot path or accept jedi's cost only
  on the post-edit report path.
- Wire-protocol auth and token rotation.

## Roadmap

- Milestone 0: runnable skeleton and realtime stub loop.
- Milestone 1: TS/Python contract extraction, contract delta diffing, durable live state (SQLite now; Postgres/Redis later), severity scoring.
- Milestone 2: dependency graph, MCP adapter, GitHub webhooks, cross-agent support.
- Milestone 3: team briefings.
- Milestone 4: persistent memory (`synapse why` deterministic seed now; pgvector/RAG later).

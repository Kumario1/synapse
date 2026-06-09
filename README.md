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
6. Stdio MCP adapter so MCP-capable agents can call the same daemon tools without shell-specific
   integration code.
7. Durable server state via a `StateStore` (SQLite): live sessions, unpushed deltas, recent pushes,
   edit locks, and resolutions survive a server restart.
8. Automatic Claude Code hooks installed by `synapse join`: `PreToolUse` checks before an edit and
   `PostToolUse` reports after, via the `synapse hook` entrypoint.
9. A deterministic hot-path latency verifier for the file-only pre-edit check path: two daemons,
   separate worktrees, no external network or LLM calls, with p95 and max latency budgets enforced.

The server is single-process with an in-memory hot path backed by a durable store. Postgres/Redis
(for multi-instance fan-out) can implement the same `StateStore` later without touching server logic.
The daemon↔server channel supports optional shared-token auth; GitHub OAuth is the planned upgrade.

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
precedence: explicit flags, environment variables, `.synapse/config.json`, then built-in defaults.

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
```

This synthetic local benchmark starts a server plus Alice/Bob daemons in separate one-file
worktrees, disables OpenRouter, measures no-conflict and warning checks, and asserts p95 <= 50ms and
max <= 150ms for both paths.

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

## Server Auth (shared token)

The daemon↔server channel can require a shared token. Set `SYNAPSE_AUTH_TOKEN` to the **same** value
on the server and on each daemon (`--token`, or the `SYNAPSE_AUTH_TOKEN` env — it is never written to
`.synapse/config.json`, so the secret stays off disk). When set, the server rejects WSS connections
and `GET /state` that don't present it (via `?token=` or `Authorization: Bearer`), using a constant-time
comparison. `/health` stays open, and the GitHub webhook keeps its own HMAC. Unset = open, which keeps
local/dev and the verify scripts hermetic. GitHub OAuth + per-connection JWT is the intended upgrade.

```bash
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
`synapse_report`, `synapse_push`, `synapse_session`, and `synapse_whatsup`, then forwards each call
to the local daemon. The daemon remains the single place that owns contract extraction, conflict
detection, LLM analysis, resolution, and briefing.

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
- Milestone 4: persistent memory.

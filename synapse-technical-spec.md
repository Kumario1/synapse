# Synapse — Technical Specification

> v0.1 · 2026-06-05 · Companion to `synapse-build-plan.md` (roadmap) and `synapse-context.md` (vision).
> This is the engineering contract: data structures, protocols, algorithms. Detailed enough to
> implement from. Decisions are locked per the build plan's Decisions Log.

## Contents
1. Process & Component Topology
2. Identity & Auth
3. The Symbol Model (language-neutral)
4. Contract Extraction (per language)
5. The Dependency Graph
6. Contract Deltas
7. Live State Model
8. Wire Protocols (agent↔daemon, daemon↔server)
9. The Conflict Engine (severity algorithm)
10. The Hot Path, Step by Step
11. Privacy Boundary
12. Distillation & LLM Usage
13. Storage Schemas
14. Failure Modes & Edge Cases
15. Open Spec Questions

---

## 1. Process & Component Topology

### On each developer machine
```
┌──────────────────────────────────────────────────────────────┐
│ Coding agents                                                  │
│  • Claude Code  → PreToolUse/PostToolUse hooks → local socket  │
│  • Cursor/Cline/Aider → MCP tools → daemon's local MCP server  │
└───────────────┬────────────────────────────────────────────────┘
                │ localhost (HTTP+unix socket / MCP stdio)
┌───────────────▼────────────────────────────────────────────────┐
│ SYNAPSE DAEMON  (Node/TS, long-lived)                           │
│  • Local MCP server (tools agents call)                         │
│  • Local hook endpoint (Claude Code shells into this)           │
│  • Warm cache: replica of team live-state                       │
│  • Git watcher (chokidar + simple-git)                          │
│  • TS analyzer IN-PROCESS (ts-morph)                            │
│  • WSS client → server                                          │
└───────────────┬───────────────────────────┬────────────────────┘
                │ JSON-RPC over localhost      │ WSS (authenticated)
┌───────────────▼─────────────┐               │
│ PYTHON ANALYZER SIDECAR      │               │
│  (Python, long-lived)        │               │
│  • tree-sitter + pyright/jedi│               │
│  • Python contract extract   │               │
│  • Python sub-graph build    │               │
└──────────────────────────────┘               │
                                               ▼
                                   ┌────────────────────────┐
                                   │   SYNAPSE SERVER         │
                                   └────────────────────────┘
```

**Why two analyzer homes:** Node owns TS analysis (ts-morph wraps the TS compiler — the only way to
get real TS symbol resolution). Python owns Python analysis (pyright/jedi). The daemon speaks a single
**Analyzer Protocol** (§4) to both, so the rest of the system is language-agnostic.

### On the server (self-hosted, Docker Compose)
```
node-server:  WSS gateway + REST API + GitHub webhook receiver + conflict-fanout
postgres:     durable state (+ pgvector for Layer III)
redis:        live sessions, edit locks (TTL), pub/sub fan-out
```

---

## 2. Identity & Auth

- **`synapse login`** → browser OAuth against the team's GitHub OAuth App (client id/secret in server
  env). Returns a Synapse session token (JWT) stored in `~/.synapse/credentials`.
- Identity = GitHub login → `Member`. This maps cleanly to commit authorship and PR authorship.
- **GitHub App** (separate from the OAuth App) is installed on the org's repos to deliver webhooks
  (`push`, `pull_request`, reviews) and read commit metadata. It does **not** grant Synapse the right
  to read working-tree code — that stays local (see §11).
- **`synapse join`** (run inside a cloned repo): verifies login, links `repo → team`, confirms the
  working tree is synced to a known commit, installs Claude Code hooks, registers the local MCP
  server, and starts the daemon. Target <5s.

Current implementation: `synapse join` writes `.synapse/config.json` with `repoId`, `serverUrl`,
`daemonPort`, `member`, `sessionId`, `agentType`, and `worktreeRoot`. The daemon and local CLI
commands read that file as defaults, with precedence `flags > environment > .synapse/config.json >
built-ins`.

---

## 3. The Symbol Model (language-neutral)

Everything downstream (graph, deltas, conflicts) speaks `Symbol`, not language syntax.

```ts
type SymbolKind =
  | "function" | "method" | "class" | "interface" | "type"
  | "field" | "enum" | "const" | "route" | "schema";

interface SymbolId {        // stable, deterministic, language-prefixed
  // e.g. "ts:src/auth/token.ts#TokenValidator.validate"
  //      "py:src/auth/token.py#TokenValidator.validate"
  raw: string;
}

interface Signature {
  params: { name: string; type: string | null; optional: boolean }[];
  returns: string | null;
  generics?: string[];
  raw: string;              // normalized human-readable form
}

interface Symbol {
  id: SymbolId;
  kind: SymbolKind;
  name: string;             // fully-qualified within file
  visibility: "exported" | "public" | "internal";
  signature: Signature | null;   // null for fields w/o type, etc.
  sigHash: string;          // hash(normalized signature) — change detection
  span: { path: string; startLine: number; endLine: number };
  lang: "ts" | "py";
}
```

**`sigHash` is the linchpin:** a change with an identical `sigHash` is an implementation-only change
and is *never* a contract conflict (honors "minor implementation changes don't trigger a warning").

---

## 4. Contract Extraction (per language)

Each analyzer exposes the same **Analyzer Protocol** (JSON-RPC over localhost):

```
analyzer.index(repoRoot, files[])      -> { symbols: Symbol[], edges: Edge[] }
analyzer.extractFile(path, source)     -> { symbols: Symbol[] }
analyzer.resolveRefs(symbolId)         -> { dependents: SymbolId[], dependencies: SymbolId[] }
analyzer.diffContract(before, after)   -> { changes: SymbolChange[] }   // structural, deterministic
analyzer.health()                      -> { ok, version, lang }
```

### TS/JS analyzer (Node, in-process via ts-morph)
Extracts: exported functions (params+types+return+generics), exported classes (public methods/fields),
`interface`/`type` shapes, exported `const`/`enum`, and — phase 2 — framework route definitions
(Next.js route handlers, Express/Hono routes). Uses the TS compiler's type checker for real types.
The dependency graph resolves relative named, aliased, default, and namespace imports to exported
symbol ids, so `dependency_changed` warnings survive common TypeScript import styles.

### Python analyzer (Python sidecar, pyright/jedi + tree-sitter)
Extracts: module-level `def` (params + annotations + return annotation), class public methods &
attributes, dataclass/Pydantic model fields, and — phase 2 — FastAPI/Flask route decorators.
tree-sitter gives fast structural parse; pyright/jedi give cross-file reference resolution.

**Detection is deterministic AST/signature diffing — never the LLM.** The optional LLM layer only
upgrades already-detected conflicts into richer, side-addressed action plans (§12).

---

## 5. The Dependency Graph

### Shape
Directed multigraph. Nodes = `Symbol`. Edge kinds:
```
calls         A invokes B
references    A names B (type position, import, etc.)
extends       A extends/implements B
imports       file-level import (coarse fallback)
defines       container → member (class → method)
```

### Two layers, computed locally
1. **Base graph** — built from the latest *pushed* commit (everyone has this code via git, so it's
   identical across the team and deterministic from the commit SHA). Built once on `synapse join` and
   rebuilt on pull/branch-switch.
2. **Working overlay** — the diff the local agent has introduced but not pushed. Incrementally
   re-indexes only changed files + their immediate dependents on every edit (ts-morph and jedi both
   support incremental reanalysis).

### Conflict-relevant queries (answered locally, <50ms target)
- `dependentsOf(symbolId, maxHops)` → who breaks if this symbol's contract changes.
- `dependenciesOf(symbolId, maxHops)` → what this symbol relies on.
- `symbolsInFile(path)` and `symbolAtLine(path, line)` → map an about-to-edit location to a symbol.

**Privacy note:** the graph is built locally; only **symbol IDs + signatures + dependent ID lists**
are ever sent to the server — never edges' source code, never bodies.

---

## 6. Contract Deltas

The unit Synapse shares about a change.

```ts
type ChangeKind =
  | "added" | "removed" | "renamed" | "moved"
  | "signature_changed" | "visibility_changed";

interface ContractDelta {
  id: string;
  repoId: string;
  sessionId: string;             // who/which session produced it
  symbolId: SymbolId;
  changeKind: ChangeKind;
  before: Signature | null;
  after: Signature | null;
  summary: string;               // short human summary, not trusted for detection
  filePath: string;
  baseSha: string;               // commit the change is relative to
  dependents: SymbolId[];        // from local graph — who is affected (IDs only)
  createdAt: string;             // ISO
  pushedAt: string | null;       // set on git push → triggers state clear
}
```

A `signature_changed` with equal `before.sigHash`/`after.sigHash` is impossible by construction; if the
hashes match we emit no delta at all.

---

## 7. Live State Model

What the server holds about the *present* (cleared as work is pushed). Mirrors `synapse-context.md` §5
but typed.

```ts
interface Session {
  id: string; repoId: string; memberId: string;
  agentType: "claude-code" | "cursor" | "cline" | "aider" | "other";
  filesOpen: string[]; filesEditing: string[];
  lastTask: string | null;
  startedAt: string; lastSeen: string;
  status: "active" | "idle" | "ended";
}

interface EditLock {            // Redis, TTL ~ 90s, renewed by heartbeat
  sessionId: string; symbolId: SymbolId; filePath: string;
  acquiredAt: string; ttlSec: number;
}

interface RecentPush {
  id: string; repoId: string; memberId: string;
  summary: string; filesAffected: string[]; sha: string; pushedAt: string;
}

interface RecentRepoEvent {
  id: string; repoId: string;
  kind: "pull_request" | "pull_request_review" | "issue_comment";
  action: string; actor: string;
  title: string; number?: number; url?: string;
  summary: string; createdAt: string;
}

interface TeamState {           // what a daemon's warm cache replicates
  repoId: string;
  sessions: Session[];
  editLocks: EditLock[];
  unpushedDeltas: ContractDelta[];   // pushedAt === null
  recentPushes: RecentPush[];        // last 24h
  recentRepoEvents: RecentRepoEvent[];// PR/review/comment activity for Layer II
  resolutions: ContractResolution[]; // shared merged contracts (implemented)
  sessionSummaries: SessionSummary[];// Layer II, on session end (implemented)
  conflictFeedback: ConflictFeedback[];// explicit acted/dismissed warning feedback
}
```

> Current implementation: `TeamState` also carries `resolutions` (shared contract resolutions, keyed
> by `symbol + inputsHash`), `sessionSummaries` (Layer II narratives produced on session end), and
> `conflictFeedback` (explicit acted/dismissed telemetry). The server holds it in memory and persists
> it through a `StateStore` (SQLite) so a restart resumes it.

---

## 8. Wire Protocols

### 8a. Agent ↔ Daemon (localhost)

**MCP tools** the daemon exposes (works for any MCP-capable agent):
```
synapse_check        { files: string[], symbols?: SymbolId[], task?: string }
                     -> { verdict: "none"|"info"|"warn", conflicts: Conflict[] }
synapse_report       { filePath: string }   // daemon reads tree+git, extracts delta locally
                     -> { ok: true, delta?: ContractDeltaSummary }
synapse_push         { sha, summary, files[], symbols?: SymbolId[] }
                     -> { ok: true, sha, files[] }
synapse_feedback     { conflictId, outcome: "acted"|"dismissed", note?, rule?, targetSymbol? }
                     -> { ok: true, feedback }
synapse_whatsup      { limit?: number }      -> SynapseWhatsupResponse        // Layer II
synapse_why          { question: string, limit?: number } -> SynapseWhyResponse // Layer III seed
synapse_session      { action: "start"|"heartbeat"|"end", task?: string } -> { sessionId }
```

Current implementation: `synapse mcp` starts a stdio MCP adapter for Cursor/Cline/Aider-style
clients. The adapter does not duplicate Synapse logic; it forwards tool calls to the local daemon's
HTTP endpoints so the daemon remains the owner of extraction, conflict detection, analysis, and
resolution. `synapse_feedback` records explicit acted/dismissed telemetry for a surfaced conflict but
does not change verdicts. `synapse_whatsup` is deterministic today: it reads the daemon's warm cache
and returns active sessions, unpushed deltas, edit locks, recent pushes, shared resolutions, and
recent feedback. `synapse_why` is also deterministic today: it ranks matching session summaries, repo
events, pushes, resolutions, conflict feedback, unpushed deltas, and active sessions by question terms,
then returns a source-cited answer. When `SYNAPSE_DATABASE_URL` (Postgres + pgvector) and an
OpenAI-compatible embeddings endpoint are configured, `synapse_why` additionally ranks by vector
recall on top of the deterministic floor (`rag: true`); without embeddings, `/recall` reports
`degraded: true` and the floor answers alone.

**Claude Code hooks** (the first-class automatic path) — installed into the repo's settings:
- `PreToolUse` on `Edit|Write|MultiEdit`: shells into the daemon's local endpoint = `synapse_check`
  for the target file. On `warn`, the hook returns context that Claude surfaces inline before editing
  (per "warn inline, dev decides" — it does **not** block). For file-based checks, the daemon also
  snapshots the current contract symbols locally so the next post-edit report can diff against the
  pre-edit state.
- `PostToolUse` on `Edit|Write|MultiEdit`: calls `synapse_report` for the changed file.

### 8b. Daemon ↔ Server (WSS, authenticated, per-repo room)

Envelope: `{ v: 1, type, id, ts, payload }`. Bidirectional.

Client → Server:
```
session.start | session.heartbeat | session.end
edit.intent          { symbolId, filePath }      // acquire/renew an EditLock
contract.delta       { delta: ContractDelta }     // raw code NOT included
push.notify          { sha, summary, files[] }    // local detected a git push
repo.event           { kind, action, actor, title, number?, url?, summary }
resolution.propose   { resolution }               // shared merged contract (implemented)
session.summary      { summary: SessionSummary }   // Layer II, on session end (implemented)
conflict.feedback    { feedback: ConflictFeedback }// explicit acted/dismissed telemetry
query.briefing       { since? }
```
Server → Client (implemented subset):
```
state.snapshot       { teamState: TeamState }     // on connect / resync AND after each mutation
state.delta          { teamState: TeamState }     // accepted by daemon, reserved for incremental fan-out
ack                  { forId, ok, error? }
```
(`state.delta` incremental fan-out and proactive `conflict.alert` remain on the design board; today the
server re-broadcasts a full `state.snapshot` after every mutation.)

Runtime validation is bidirectional at process boundaries. The server validates every inbound
client message with the shared zod wire schemas before mutation; the daemon parses server frames
with the matching server-message schema and ignores malformed frames with a warning instead of
crashing or poisoning the warm cache. The daemon's local HTTP tool endpoints also cap JSON bodies at
1MB before concatenation, answer malformed JSON with 400, and answer oversized JSON with 413.

> Auth (current): when `SYNAPSE_AUTH_TOKEN` is set, the WSS handshake and `GET /state` require a
> matching token (`?token=` or `Authorization: Bearer`, constant-time compared). Unset = open. GitHub
> OAuth + per-connection JWT is the planned upgrade (§15.6).

The warm cache means `synapse_check` is normally answered **locally** against the replica + local
graph. The server is the fan-out hub + source of truth, not in the hot path.

### 8c. GitHub → Server Webhook

Current implementation accepts GitHub events at `POST /webhooks/github`.

- `push`: converts changed files into the existing `push.notify` state mutation, records a
  `RecentPush`, clears matching live deltas/locks, and broadcasts a fresh `state.snapshot`.
- `pull_request`, `pull_request_review`, `issue_comment`: converts the payload into `repo.event`,
  records recent repo activity, and surfaces it in `whatsup` / `SessionStart` catch-ups.

Local/dev verification may pass `?repoId=local`; production defaults to `repository.full_name`. When
`SYNAPSE_GITHUB_WEBHOOK_SECRET` is set, the route requires a valid `X-Hub-Signature-256` HMAC.

---

## 9. The Conflict Engine (severity algorithm)

Pure function, runs locally in the daemon. Output ∈ `{none, info, warn}` (we chose no auto-block).

```
function evaluate(target: {symbolId, filePath}, state: TeamState, graph): Conflict[] {
  results = []
  deps = graph.dependenciesOf(target.symbolId, maxHops=2)   // what I rely on

  for each otherSession (≠ me) in state.sessions:
    // R1 — same symbol, actively edited elsewhere
    if otherSession holds EditLock on target.symbolId        -> WARN  (same_symbol_active)
    // R2 — same symbol has an unpushed contract change elsewhere
    if ∃ unpushedDelta(symbol=target.symbolId, session=other) -> WARN (same_symbol_unpushed)

  for each unpushedDelta d in state.unpushedDeltas (session ≠ me):
    // R3 — I directly depend on a contract that changed elsewhere, unpushed
    if d.symbolId ∈ deps[hop=1]                              -> WARN  (dependency_changed)
    // R4 — transitive dependency (2 hops)
    else if d.symbolId ∈ deps[hop=2]                         -> INFO  (transitive_dependency)

  for each push p in state.recentPushes not yet pulled locally:
    // R5 — a pushed change touches my target or a direct dep, I'm on a stale base
    if (target.symbolId ∈ p.symbols) or (p.symbols ∩ deps[hop=1] ≠ ∅) -> WARN (stale_base)

  // R6 — same file, different symbol, no dep relation
  if otherSession editing same file, no symbol/dep overlap   -> INFO  (same_file_no_overlap)

  // R7 — implementation-only change (sigHash unchanged)      -> NONE  (never emitted as delta)
  return dedupe(results)
}
```

**Verdict = max severity across results.** `none` → proceed silently (≈95% of edits, per principle #4).

### Fatigue controls
- Dedup key: `(targetSymbol, counterpartSession, deltaHash)` — don't re-warn within a session unless it
  changes.
- Current telemetry: every emitted conflict carries a deterministic `id`, and `synapse_feedback`
  records whether a surfaced `warn` was *acted on* (dev adjusted/pinged) vs. dismissed. Adaptive
  severity uses this telemetry to demote chronically-dismissed `warn` rules to `info` (deterministic,
  one-directional — `info` never gets promoted, and detection itself is untouched).

### `Conflict` payload
```ts
interface Conflict {
  id: string;                           // deterministic feedback key
  severity: "info" | "warn";
  rule: string;                        // e.g. "dependency_changed"
  targetSymbol: SymbolId;
  counterpart: { memberLogin: string; sessionId: string; agentType: string };
  detail: string;                      // short deterministic explanation
  change?: {
    changeKind: ChangeKind;
    before: Signature | null;
    after: Signature | null;
    compatibility: "identical" | "compatible" | "breaking" | "unknown";
    breakingReasons: string[];
  };
  analysis?: {
    assessment: string;
    recommendation: "block" | "warn" | "info" | "proceed";
    actions: { audience: "you" | "counterpart" | "both"; step: string }[];
    source: "deterministic" | string;  // model id when OpenRouter upgraded it
  };
}
```

---

## 10. The Hot Path, Step by Step

```
1. Agent is about to Edit src/auth/login.ts:42
2. Claude Code PreToolUse hook → daemon local endpoint (synapse_check)
3. Daemon: graph.symbolAtLine("src/auth/login.ts", 42)  -> "ts:...#login"
4. Daemon: conflictEngine.evaluate({login}, warmCache, graph) and snapshot current file contracts
   for the next report   ← all local, no network
5a. verdict none  -> hook returns {} -> agent edits silently
5b. verdict warn  -> hook returns context block -> Claude surfaces inline:
       "⚠ Heads up: alice's agent changed TokenValidator.validate() this morning (unpushed) —
        now returns Result<Token,AuthError>. login.ts:42 calls it. Proceed, adjust, or ping alice?"
6. Dev decides. Agent edits.
7. PostToolUse hook → daemon (synapse_report)
8. Daemon: re-extract contract for the file (TS analyzer), diff vs. pre-check/report snapshot,
   compute ContractDelta
9. If sigHash changed -> daemon emits a deterministic contract.delta over WSS
10. Server fans out state.delta to every other daemon in the repo room -> their warm caches update
11. On `git push`: daemon sends push.notify or GitHub sends a push webhook -> server clears matching
    unpushedDeltas
```

Latency budget: steps 2–5 ≈ <50ms p95 (no network). Steps 8–10 are off the critical path
(post-edit). `npm run verify:hot-path-latency` enforces the current synthetic local budget for the
file-only PreToolUse path: two daemons, separate one-file worktrees, OpenRouter disabled, p95 <= 50ms
and max <= 150ms for both no-conflict and warning checks. `npm run verify:large-repo-latency` repeats
the same warm-budget enforcement against 181 generated TypeScript files and records cold first-check
time separately. `npm run verify:repo-latency` snapshots the tracked Synapse repo with
`git archive HEAD`, then enforces the same warm budget for no-conflict checks and a real same-symbol
warning while recording cold first-check time separately.
When `OPENROUTER_API_KEY` is set, the daemon may upgrade a conflict's deterministic `analysis` by
sending the relevant self/counterpart contract-change payloads to OpenRouter. Failure, timeout, or a
missing key keeps the deterministic analysis.

---

## 11. Privacy Boundary

| Leaves the machine by default | Never leaves the machine by default |
|-------------------------------|------------------------------------|
| Symbol IDs (path + name) | Function/method bodies |
| Normalized signatures (param names/types, returns) | Full file contents |
| Human-readable contract summaries and deterministic actions | Raw implementation diffs |
| Commit SHAs, file paths | Business logic / comments |
| Session metadata (task description, agent type) | Anything not in a public contract |

- All detection and compatibility analysis runs locally (daemon + Python sidecar). The server is a
  coordination hub, not a code store.
- The optional OpenRouter layer is explicit opt-in via `OPENROUTER_API_KEY`. When enabled, the daemon
  can send the relevant self/counterpart contract-change payloads and deterministic baseline to the
  model provider to improve `ConflictAnalysis`; no key means fully offline deterministic output.
- **`privacy.redactSignatures` config**: for maximum-paranoia teams, send only `{symbolId, changeKind}`
  — no param names/types. Reduces conflict detail but keeps same-symbol/dependency detection working.
- Self-hosted means even the coordination metadata stays on the team's own infra.

---

## 12. Distillation & LLM Usage

The LLM layer is optional and non-authoritative. The current implementation uses OpenRouter's
OpenAI-compatible endpoint over plain `fetch` with no provider SDK dependency:

```env
OPENROUTER_API_KEY=
SYNAPSE_LLM_MODEL=anthropic/claude-haiku-4.5
```

`OPENROUTER_API_KEY` is the one place to enable the model path (`.env.example` -> `.env`, then run
the daemon with `node --env-file=.env ...`). With no key, timeout, malformed response, or
`SYNAPSE_LLM_EXPLAIN=0`, Synapse keeps the deterministic analysis.

Allowed non-authoritative uses:
1. **ConflictAnalysis upgrade**: compare the already-detected counterpart change with your current
   contract and your own unpushed change, then return `{ assessment, recommendation, actions, source }`.
2. **Session summary** (Layer II, on session end): batch-summarize the session's deltas + task into 2-3
   sentences.
3. **Memory answers** (Layer III): deterministic state search always; hybrid pgvector RAG with
   provenance when Postgres + embeddings are configured.

Never for detection or compatibility classification. Detection is always deterministic, which keeps the
hot path cheap, fast, and free of hallucinated contracts.

---

## 13. Storage Schemas

> **Current implementation (2026-06-11):** the server persists through a storage-agnostic `StateStore`
> (`apps/server/src/store.ts`). SQLite stores per-entity rows when `SYNAPSE_DB_PATH` is set
> (unset = in-memory); Postgres is selected by `SYNAPSE_DATABASE_URL` for shared deployments.
> Postgres table creation and pgvector memory setup are serialized with session advisory locks, and
> failed DDL still attempts unlock before the pooled connection is released. Redis is optional fan-out
> only; durable live state remains in the selected `StateStore`.

### Postgres (durable)
```sql
team(id, name, plan, created_at)
member(id, team_id, github_login, github_id, role, created_at)
repo(id, team_id, github_full_name, default_branch, created_at)
session(id, repo_id, member_id, agent_type, last_task, started_at, ended_at, status)
contract_delta(id, repo_id, session_id, symbol_id, change_kind, before_sig jsonb,
               after_sig jsonb, summary, file_path, base_sha, dependents jsonb,
               created_at, pushed_at)              -- pushed_at set on push; live = NULL
recent_push(id, repo_id, member_id, summary, files jsonb, sha, pushed_at)
-- Layer III
decision_memory(id, repo_id, kind, text, embedding vector(1024), source_url, created_at)
```

### Redis (ephemeral, with TTL)
```
session:{id}                 hash  (status, lastSeen, filesEditing)   TTL renewed by heartbeat
lock:{repoId}:{symbolId}     -> sessionId                              TTL ~90s
room:{repoId}                pub/sub channel for fan-out
```

The split: Redis wakes other instances after writes; Postgres is the durable record that survives
restarts and feeds Layer II/III. Once a delta's `pushed_at` is set, it's out of live state.

---

## 14. Failure Modes & Edge Cases

- **Server unreachable** → daemon serves from warm cache (possibly stale); marks results
  `degraded: true`; never blocks the agent. Reconnect → `state.snapshot` resync.
- **Analyzer crash / unsupported language** → fall back to **file-level** detection for that file
  (same-file editing = info), so we degrade gracefully instead of going silent.
- **Two daemons race on the same symbol** → EditLock is advisory + last-writer-wins; both get a `warn`,
  the humans coordinate (by design — we don't orchestrate).
- **Rebase / force-push / branch switch** → `baseSha` mismatch triggers a base-graph rebuild and a
  state resync; stale deltas (wrong baseSha) are dropped.
- **Long-overnight session** → idle after N minutes of no edits (status `idle`), released locks, but
  session not ended until daemon stops or explicit `session end`. (Session-definition open Q, §15.)
- **Monorepo accidentally joined as single repo** → works, but graph spans the whole repo (slower).
  Flagged for the monorepo-aware milestone.

---

## 15. Open Spec Questions (status as of 2026-06-09)

1. **Session lifecycle precision** — ⬜ open. Session starts on daemon `session.start` and ends on
   `session.end` (which now also emits a Layer II summary). Precise idle-timeout semantics still TBD;
   affects locks and briefings.
2. **EditLock granularity** — ✅ symbol-level for v1 (`edit.intent` acquires a per-symbol lock, TTL 90s).
3. **Python resolver** — ✅ resolved: **jedi** in the sidecar (with tree-sitter for parsing). pyright
   remains an option if cross-file accuracy bites. See `packages/analyzer-py`.
4. **Graph rebuild cost** — 🟡 partial. The daemon keeps an mtime/size-based in-memory cache for file
   symbols and the merged dependency graph, so unchanged hot-path checks avoid fresh analyzer work.
   Synthetic one-file and 181-file latency verifiers cover the current hot path, and a tracked Synapse
   repo snapshot verifier covers the actual codebase shape. A persisted on-disk graph cache and
   external production-repo profiling are still open.
5. **Self-host packaging** — 🟡 partial: the Python sidecar uses a **shipped venv created on `join`**
   (`setup-venv.mjs`, pinned deps). A container/binary bundle is a later option.
6. **Wire-protocol auth** — 🟡 partial: an **optional shared token** gates WSS + `/state` (PR #21).
   Short-lived per-connection JWT via GitHub OAuth (with rotation) is the planned upgrade.
```

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

### Python analyzer (Python sidecar, pyright/jedi + tree-sitter)
Extracts: module-level `def` (params + annotations + return annotation), class public methods &
attributes, dataclass/Pydantic model fields, and — phase 2 — FastAPI/Flask route decorators.
tree-sitter gives fast structural parse; pyright/jedi give cross-file reference resolution.

**Detection is deterministic AST diffing — never the LLM.** The LLM only writes the human summary (§12).

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
  summary: string;               // LLM-written, e.g. "validate() now returns Result<Token,AuthError>"
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

interface TeamState {           // what a daemon's warm cache replicates
  repoId: string;
  sessions: Session[];
  editLocks: EditLock[];
  unpushedDeltas: ContractDelta[];   // pushedAt === null
  recentPushes: RecentPush[];        // last 24h
}
```

---

## 8. Wire Protocols

### 8a. Agent ↔ Daemon (localhost)

**MCP tools** the daemon exposes (works for any MCP-capable agent):
```
synapse_check        { files: string[], symbols?: SymbolId[], task?: string }
                     -> { verdict: "none"|"info"|"warn", conflicts: Conflict[] }
synapse_report       { filePath: string }   // daemon reads tree+git, extracts delta locally
                     -> { ok: true, delta?: ContractDeltaSummary }
synapse_whatsup      { since?: string }      -> { briefing: string }          // Layer II
synapse_why          { question: string }    -> { answer: string, sources: [] } // Layer III
synapse_session      { action: "start"|"end", task?: string } -> { sessionId }
```

**Claude Code hooks** (the first-class automatic path) — installed into the repo's settings:
- `PreToolUse` on `Edit|Write|MultiEdit`: shells into the daemon's local endpoint = `synapse_check`
  for the target file. On `warn`, the hook returns context that Claude surfaces inline before editing
  (per "warn inline, dev decides" — it does **not** block).
- `PostToolUse` on `Edit|Write|MultiEdit`: calls `synapse_report` for the changed file.

### 8b. Daemon ↔ Server (WSS, authenticated, per-repo room)

Envelope: `{ v: 1, type, id, ts, payload }`. Bidirectional.

Client → Server:
```
session.start | session.heartbeat | session.end
edit.intent          { symbolId, filePath }      // acquire/renew an EditLock
contract.delta       { delta: ContractDelta }     // raw code NOT included
push.notify          { sha, summary, files[] }    // local detected a git push
query.briefing       { since? }
```
Server → Client:
```
state.snapshot       { teamState: TeamState }     // on connect / resync
state.delta          { add?, remove?, update? }   // incremental fan-out of others' activity
conflict.alert       { conflict: Conflict }       // proactive (someone started touching your area)
ack                  { forId, ok, error? }
```

The warm cache means `synapse_check` is normally answered **locally** against the replica + local
graph. The server is the fan-out hub + source of truth, not in the hot path.

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
- Telemetry: record whether a surfaced `warn` was *acted on* (dev adjusted/pinged) vs. dismissed. Use
  this to tune thresholds (e.g. demote chronically-dismissed rules to `info`).

### `Conflict` payload
```ts
interface Conflict {
  severity: "info" | "warn";
  rule: string;                        // e.g. "dependency_changed"
  targetSymbol: SymbolId;
  counterpart: { memberLogin: string; sessionId: string; agentType: string };
  detail: string;                      // human, e.g. "alice's agent changed TokenValidator.validate()
                                       //   (now returns Result<...>), which login.ts:42 calls"
  suggestion: string;                  // e.g. "pull alice's branch, or coordinate on the new contract"
}
```

---

## 10. The Hot Path, Step by Step

```
1. Agent is about to Edit src/auth/login.ts:42
2. Claude Code PreToolUse hook → daemon local endpoint (synapse_check)
3. Daemon: graph.symbolAtLine("src/auth/login.ts", 42)  -> "ts:...#login"
4. Daemon: conflictEngine.evaluate({login}, warmCache, graph)   ← all local, no network
5a. verdict none  -> hook returns {} -> agent edits silently
5b. verdict warn  -> hook returns context block -> Claude surfaces inline:
       "⚠ Heads up: alice's agent changed TokenValidator.validate() this morning (unpushed) —
        now returns Result<Token,AuthError>. login.ts:42 calls it. Proceed, adjust, or ping alice?"
6. Dev decides. Agent edits.
7. PostToolUse hook → daemon (synapse_report)
8. Daemon: re-extract contract for the file (TS analyzer), diff vs. previous, compute ContractDelta
9. If sigHash changed -> LLM writes one-line summary (Haiku) -> send contract.delta over WSS
10. Server fans out state.delta to every other daemon in the repo room -> their warm caches update
11. On `git push`: daemon detects, sends push.notify -> server clears matching unpushedDeltas
```

Latency budget: steps 2–5 ≈ <50ms (no network). Steps 8–10 are off the critical path (post-edit).

---

## 11. Privacy Boundary

| Leaves the machine | Never leaves the machine |
|--------------------|--------------------------|
| Symbol IDs (path + name) | Function/method bodies |
| Normalized signatures (param names/types, returns) | Full file contents |
| Human-readable contract summaries | Raw diffs |
| Commit SHAs, file paths | Business logic / comments |
| Session metadata (task description, agent type) | Anything not in a public contract |

- All analysis runs locally (daemon + Python sidecar). The server is a coordination hub, not a code store.
- **`privacy.redactSignatures` config**: for maximum-paranoia teams, send only `{symbolId, changeKind}`
  — no param names/types. Reduces conflict detail but keeps same-symbol/dependency detection working.
- Self-hosted means even the coordination metadata stays on the team's own infra.

---

## 12. Distillation & LLM Usage

LLM (Claude Haiku via Vercel AI Gateway) is used in exactly three non-hot-path places:
1. **Delta summary** (post-edit): turn a structural `SymbolChange` into one human sentence. Input is the
   before/after **signature** only — not the body.
2. **Session summary** (Layer II, on session end): batch-summarize the session's deltas + task into 2–3
   sentences.
3. **Memory answers** (Layer III): RAG over pgvector with provenance.

Never in the PreToolUse path. Detection is always deterministic. This keeps the hot path cheap, fast,
and free of hallucinated contracts.

---

## 13. Storage Schemas

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

The split: Redis answers "what is happening *right now*" fast; Postgres is the durable record that
survives restarts and feeds Layer II/III. Once a delta's `pushed_at` is set, it's out of live state.

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

## 15. Open Spec Questions (need answers before/while building)

1. **Session lifecycle precision** — when exactly does a session start/end/idle? (Daemon start? First
   agent prompt? Idle timeout value?) Affects locks and briefings.
2. **EditLock granularity** — lock at the symbol level (precise, more churn) or file level (coarse,
   simpler) for v1? (Spec currently assumes symbol-level.)
3. **Python resolver** — pyright (most accurate, heavier, Node-based LSP) vs. jedi (pure-Python, embeds
   cleanly in the sidecar, slightly less accurate). Lean jedi for the sidecar; revisit if accuracy bites.
4. **Graph rebuild cost** — acceptable base-graph build time on `join` for, say, a 50k-LOC repo? Sets
   whether we need a persisted graph cache on disk (likely yes).
5. **Self-host packaging** — bundle the Python sidecar via a shipped venv, a container, or PyOxidizer
   binary? Affects `synapse join` install weight.
6. **Wire-protocol auth** — short-lived JWT per daemon connection refreshed via REST; confirm rotation
   strategy.
```


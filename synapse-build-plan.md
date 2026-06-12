# Synapse — Engineering Build Plan & Technical Outline

> Working draft v0.1 · 2026-06-05
> Companion to `synapse-context.md` (product vision). This document is the *engineering* outline:
> what we build, with what technology, in what order, and why.
>
> Design stance: **robust over scrappy.** The context doc describes a $0 SQLite shell-script MVP.
> This plan proposes the production-grade architecture instead, and marks where the cheap path
> diverges so we can consciously choose per-component.

---

## Build Status (updated 2026-06-09)

The core agent-coordination loop is implemented and runs as an installed tool. Status by area:

| Area | Status | Notes / PRs |
|------|--------|-------------|
| Skeleton, wire protocol, daemon↔server realtime loop | ✅ Done | M0 |
| TS contract extraction + delta diffing + conflict engine (severity, compatibility) | ✅ Done | M1, ts-morph |
| LLM analysis upgrade + contract resolver (OpenRouter, deterministic fallback) | ✅ Done | optional, gated |
| Dependency graph (TS) + transitive conflicts | ✅ Done | M2 |
| Python analyzer (tree-sitter + jedi sidecar) — same engine | ✅ Done | PR #16 |
| MCP adapter (Cursor/Cline/Aider) + GitHub push webhook | ✅ Done | M2 |
| Durable server state — SQLite `StateStore` (survives restart) | ✅ Done | PR #17 |
| Claude Code hooks installed by `join` (Pre/PostToolUse, SessionStart) | ✅ Done | PR #18, #20 |
| Briefings Layer II — `whatsup`, session-end summaries, session-start catch-up | ✅ Done | PR #19, #20 |
| Daemon↔server auth — optional shared token (constant-time) | ✅ Done | PR #21 |
| Hot-path latency benchmark — file-only pre-edit path | ✅ Done | `verify:hot-path-latency`, `verify:large-repo-latency`, `verify:repo-latency` |
| **Redis** live state + pub/sub (multi-instance fan-out) | ✅ Done | optional via `SYNAPSE_REDIS_URL`; `StateStore` (SQLite/Postgres) remains the durable record, Redis is purely the wake-up signal |
| **Postgres** durable store (multi-instance) | ✅ Done | optional via `SYNAPSE_DATABASE_URL`; implements the same `StateStore` interface as SQLite, with advisory-locked schema init |
| **GitHub OAuth + per-connection JWT** | ⬜ Planned | shared-token is the interim |
| PR / review ingestion into briefings | ✅ Done | `pull_request`, `pull_request_review`, and `issue_comment` webhooks |
| Memory Layer III — `synapse_why` + pgvector RAG | ✅ Done | deterministic state search always; hybrid pgvector recall when `SYNAPSE_DATABASE_URL` + an embeddings endpoint are configured, degrades cleanly otherwise |
| Telemetry / acted-on feedback | ✅ Done | explicit `synapse_feedback` capture, plus adaptive severity demotes chronically-dismissed warning rules to `info` |
| Go analyzer | ✅ Done | tree-sitter + warm `go/parser` sidecar, same conflict engine |
| SCIP-grade indexing | ⬜ Not started | — |

Verification: every implemented area has a `npm run verify:*` script (25 total) plus unit tests and
`npm run eval:conflicts`; all green. See the README for the per-feature commands.

---

## 0. The One Sentence

> A real-time coordination substrate that every coding agent plugs into, so before an agent edits
> code it knows — at the *contract* level, not just the file level — what the rest of the team's
> agents are doing, and can avoid colliding with them.

The hard, defensible engineering problem is **contract-level conflict detection across machines in
real time**. Everything else (briefings, memory) is built on the data this produces. We should build
the hard part *well*, because that is the moat — a file-name string-match collision detector is a
weekend toy and copyable in an afternoon.

---

## 1. System Architecture (Robust Version)

```
┌───────────────────────────────────────────────────────────────────────┐
│  DEVELOPER MACHINES (N developers, each steering 1+ agents)             │
│                                                                         │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐                    │
│  │ Claude Code │   │   Cursor    │   │  Cline /    │   ... any agent     │
│  │  (hooks)    │   │ (MCP tools) │   │  Aider      │                     │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘                     │
│         │                 │                 │                           │
│  ┌──────▼─────────────────▼─────────────────▼──────┐                    │
│  │           SYNAPSE LOCAL AGENT (CLI daemon)        │                   │
│  │  • installs/owns hooks                            │                   │
│  │  • watches git working tree (chokidar/fswatch)    │                   │
│  │  • runs LOCAL contract extraction (tree-sitter)   │                   │
│  │  • talks to server over WSS, keeps a warm cache   │                   │
│  └──────────────────────┬────────────────────────────┘                  │
└─────────────────────────┼───────────────────────────────────────────────┘
                          │  authenticated WebSocket / SSE + REST
                          ▼
┌───────────────────────────────────────────────────────────────────────┐
│                      SYNAPSE SERVER (the shared brain)                  │
│                                                                         │
│  ┌────────────────┐  ┌──────────────────┐  ┌────────────────────────┐  │
│  │  MCP Gateway   │  │ Conflict Engine  │  │ Analysis Pipeline       │  │
│  │ (tools agents  │  │ • dependency     │  │ • diff → contract delta │  │
│  │  call directly)│  │   graph          │  │ • deterministic AST     │  │
│  │                │  │ • symbol overlap │  │ • optional OpenRouter   │  │
│  └───────┬────────┘  │ • severity score │  └───────────┬─────────────┘  │
│          │           └────────┬─────────┘              │                │
│  ┌───────▼────────────────────▼──────────────────────▼─────────────┐   │
│  │                     STATE & EVENT CORE                            │   │
│  │  Redis (Upstash): live sessions, locks, pub/sub fan-out          │   │
│  │  Postgres (Neon): durable team/repo/session, contract deltas     │   │
│  │  pgvector: Layer III decision/memory embeddings                  │   │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌────────────────┐  ┌──────────────────┐  ┌────────────────────────┐  │
│  │ GitHub Webhooks│  │ Briefing Service │  │ Memory / RAG Service    │  │
│  │ (PR/push/merge)│  │ (Layer II)       │  │ (Layer III)             │  │
│  └────────────────┘  └──────────────────┘  └────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
              ┌───────────────────────────┐
              │  Web Dashboard (optional)  │  Next.js — team-level view,
              │  read-only team awareness  │  NOT required for core loop
              └───────────────────────────┘
```

### Why a local daemon (the key robustness decision)

The context doc imagines hooks as a "single shell script." That works for a demo but caps us at
file-level detection and Claude-Code-only support. A **persistent local agent** instead:

- Runs contract extraction **locally** (privacy: raw code never leaves the machine — only contract
  deltas do), satisfying the "zero-trust / privacy-paranoid" principle.
- Keeps a **warm cache** of team state so the PreToolUse hook answers in <50ms (no network in the
  hot path → satisfies "silent on no-conflict" without adding latency devs will notice).
- Is **agent-agnostic**: Claude Code drives it via hooks; Cursor/Cline/others drive it via MCP tools.
- Watches the git tree continuously, so we capture in-flight state even between agent edits.

---

## 2. Component Breakdown

### 2.1 Synapse Local Agent (CLI + daemon)
- **`synapse join`** — one command: authenticates, links repo→team, installs Claude Code hooks,
  registers the MCP server endpoint, starts the daemon. Target: <5s, zero manual config.
  Current local implementation writes `.synapse/config.json`; daemon and CLI commands read it as
  defaults after explicit flags and environment variables.
- **Daemon** — long-running local process. Responsibilities: git working-tree watch, local contract
  extraction, WSS connection to server, warm-cache of team state, hook RPC endpoint.
- **Hook adapters** — translate each agent's hook/extension model into Synapse calls.
  - Claude Code: native `PreToolUse` / `PostToolUse` hooks (shell out to the daemon over a local socket).
  - Cursor / Cline / Aider: MCP tools (`synapse_check`, `synapse_report`) the agent calls, plus
    optional editor rules that nudge the agent to call them.
  - Current MCP adapter: `synapse mcp` runs a stdio server that forwards those tool calls to the
    already-running local daemon, keeping daemon HTTP as the single implementation path.
- **Distribution**: npm package (`npx @synapse/cli join`) and a standalone binary (so non-Node users
  aren't blocked). Cheap-path fallback: a thin shell script for Claude-Code-only early adopters.

### 2.2 Contract Extraction (the high-signal core)
This is what separates Synapse from a filename-collision toy.
- **tree-sitter** parses each changed file in its language; we extract the **public contract**:
  exported functions + signatures, types/interfaces, class methods, API route definitions, DB
  schema/migrations, env/config keys.
- Diff the *before* and *after* contract → a structured **contract delta** (e.g.
  `auth.TokenValidator.validate: (str) -> Optional[Token]  ⇒  (str) -> Result[Token, AuthError]`).
- Detection and compatibility classification are deterministic AST/signature diffing. The optional
  LLM layer (OpenRouter over plain HTTP) only upgrades the already-computed conflict analysis into
  side-addressed actions; with no key configured, the deterministic action plan is the final output.
- Languages at launch (proposal): TypeScript/JS, Python, Go. Extensible via tree-sitter grammars.

### 2.3 Dependency / Symbol Graph
- Build a per-repo **import + symbol-reference graph** so "related contracts" is precise, not guessed.
  When agent A is about to edit symbol `X`, we know which other in-flight changes touch `X` or things
  that depend on `X`.
- Build options (decision needed): tree-sitter queries (lightweight, language-by-language) vs. SCIP /
  language-server indexing (heavier, much more accurate cross-file resolution).
- The graph is what powers **transitive** conflict detection — "you're editing a function whose caller
  was just changed in someone's unpushed branch."

### 2.4 Conflict Engine
- Inputs: the symbol(s) an edit will touch + current live state (active edits, unpushed contract
  deltas, recent pushes) + the dependency graph.
- Output: a **severity-scored** verdict, not a binary. e.g. `none` (proceed silently) /
  `info` / `warn` (surface inline) / `block-suggest` (recommend the agent pause & coordinate).
- Every conflict carries a structured `change` plus `analysis`: an assessment, recommendation
  (`block` / `warn` / `info` / `proceed`), and concrete actions for `you`, the `counterpart`, or
  `both`.
- Severity rules (initial): same-symbol concurrent edit = high; dependent-symbol contract change
  unpushed = high; same-file different-symbol = low; reads = none.
- **Tunable + learns**: track whether surfaced warnings were acted on, to fight alarm fatigue
  (principle #4: noisy = uninstalled).

### 2.5 State & Event Core
- **Redis (Upstash)** — ephemeral live state: active sessions, soft "editing" locks with TTL,
  and **pub/sub** so a contract delta on machine A is pushed to machine B's warm cache in real time.
- **Postgres (Neon)** — durable: teams, repos, members, auth, session history, contract-delta log
  (kept until pushed, then cleared per the "Synapse clears itself" principle — but we keep an
  *audit trail* table for Layer III, separate from live state).
- **pgvector** — Layer III decision/memory embeddings (defer; same DB, no new infra).

### 2.6 GitHub Integration
- GitHub App with webhooks: `push`, `pull_request`, `pull_request_review`, `issue_comment`.
- On push/merge: clear the corresponding in-flight contract deltas (state reset).
- Current push webhook path: `POST /webhooks/github` ingests GitHub `push` payloads, optionally
  verifies `X-Hub-Signature-256`, and reuses the same `push.notify` state mutation as the daemon.
- On PR thread / review: candidate signal for Layer III decision capture.

### 2.7 Briefing Service (Layer II)
- Current deterministic `synapse whatsup`: CLI + MCP tool that summarizes the daemon's warm cache
  (active sessions, unpushed deltas, edit locks, recent pushes, shared resolutions).
- Later: proactive session-start push.
- Batch summarization (optional OpenRouter model) on session end — never in the edit hot path.

### 2.8 Memory / RAG Service (Layer III)
- Current deterministic `synapse why`: CLI + MCP tool that searches existing team state (session
  summaries, repo events, pushes, resolutions, conflict feedback, live deltas, sessions) and returns
  an answer with cited sources.
- Later: ingest distilled session summaries, PR decisions, flagged Slack threads → embed → pgvector.

### 2.9 Web Dashboard (optional, later)
- Next.js read-only team-awareness view. Explicitly **not** required for the core agent loop and
  **not** a management/surveillance tool (principle #6).

---

## 3. Proposed Technology Stack

| Concern              | Proposed choice                                  | Cheap-path fallback           |
|----------------------|--------------------------------------------------|-------------------------------|
| Language (server)    | TypeScript (Node 24, Fluid Compute)              | same                          |
| Language (analysis)  | TypeScript + tree-sitter WASM bindings           | Python + tree-sitter          |
| MCP                  | `@modelcontextprotocol/sdk`                      | same                          |
| Local daemon         | TypeScript / Bun, local Unix socket for hooks    | shell script (CC-only)        |
| Live state + pub/sub | Redis (Upstash, Vercel Marketplace)              | in-memory / SQLite            |
| Durable store        | Postgres (Neon, Vercel Marketplace) + pgvector   | SQLite                        |
| Code parsing         | tree-sitter (TS/JS, Python, Go grammars)         | filename match only           |
| Dep graph            | tree-sitter queries → SCIP later                 | none (file-level)             |
| LLM (analysis/brief) | OpenRouter over plain `fetch` (`SYNAPSE_LLM_MODEL`, default Claude Haiku) | deterministic offline analysis |
| GitHub               | GitHub App + Octokit + webhooks                  | poll API                      |
| Realtime transport   | WebSocket (WSS) + SSE fallback                   | HTTP polling                  |
| Hosting              | Vercel (server + dashboard, Fluid Compute)       | Fly.io / Railway              |
| Auth/multi-tenancy   | Clerk or Sign-in-with-GitHub + org/team model    | API keys                      |
| CLI distribution     | npm + standalone binary                          | curl-pipe shell script        |
| Monorepo             | Turborepo (cli / server / shared-types / web)    | single package                |

Shared TypeScript types between daemon, server, and dashboard (one source of truth for the wire
protocol) is a big robustness win — hence TS-end-to-end as the default proposal.

---

## 4. Data Model (initial sketch)

```
Team(id, name, plan)
Member(id, team_id, github_login, role)
Repo(id, team_id, github_full_name, default_branch)
Session(id, repo_id, member_id, agent_type, started_at, last_seen, status, last_task)
EditLock(session_id, file_path, symbol, acquired_at, ttl)            # Redis
ContractDelta(id, repo_id, session_id, file_path, symbol,
              before_sig, after_sig, summary, created_at, pushed_at) # Postgres; cleared on push
RecentPush(id, repo_id, member_id, summary, files[], sha, pushed_at)
DecisionMemory(id, repo_id, kind, text, embedding, source_url, created_at)  # Layer III, pgvector
```

---

## 5. Phased Roadmap (engineering milestones, mapped to product layers)

**Milestone 0 — Skeleton & protocol (week 1)** — ✅ **Done**
Turborepo scaffold; shared wire-protocol types; MCP server with stub `synapse_check`/`synapse_report`;
local daemon connects over WSS; `synapse join` installs a Claude Code hook that pings the daemon.
*Exit test:* one machine reports an edit, a second machine sees it in `synapse_check`.

**Milestone 1 — Contract-level conflict prevention (Layer I) (weeks 2–4)** — ✅ **Done**
(except Redis warm cache — single-process in-memory + SQLite for now)
tree-sitter contract extraction (TS + Python first); contract-delta diffing; ~~Redis live state +
pub/sub warm cache~~; conflict engine with severity scoring; inline warning surfaced in Claude Code via
the installed `PreToolUse` hook. *Exit test:* the "Contract Collision" scenario (auth refactor vs.
login feature) is caught **before** the second agent starts — see `verify:resolution` / `verify:hooks`.

**Milestone 2 — Dependency graph & multi-agent (weeks 4–6)** — ✅ **Done**
Symbol/import graph for transitive conflicts (TS + Python); Cursor/Cline support via MCP tools; GitHub
push webhook for state reset on push. Explicit acted/dismissed feedback capture is in place; severity
tuning from that telemetry remains ahead.

**Milestone 3 — Briefings (Layer II) (weeks 6–9)** — ✅ **Done for current local scope**
Session-end summarization (deterministic + optional OpenRouter) ✅; `synapse whatsup` ✅; morning push
on session start (`SessionStart` hook) ✅; PR/review/comment ingestion into briefings ✅.

**Milestone 4 — Memory (Layer III) (when validated)** — 🟡 **Partial**
Deterministic `synapse_why` over existing team state ✅; pgvector decision store, RAG ranking, Slack
ingestion, and onboarding mode remain ahead.

**Cross-cutting (start early):** auth/multi-tenancy (✅ optional shared-token auth, PR #21; GitHub
OAuth + JWT still ahead), self-host packaging (Docker compose — not yet), explicit feedback telemetry
capture ✅, and a tiny eval harness for "did we correctly flag/ignore this conflict?" on recorded
scenarios.
Current eval harness: `npm run eval:conflicts` runs recorded JSON scenarios through the deterministic
conflict engine and asserts verdicts, rules, recommendations, compatibility, and resolutions.
Current latency harnesses: `npm run verify:hot-path-latency` measures the file-only PreToolUse path
in a synthetic two-worktree repo, `npm run verify:large-repo-latency` repeats that flow across 181
generated TypeScript source files, and `npm run verify:repo-latency` snapshots the tracked Synapse
repo with `git archive HEAD` before measuring no-conflict and same-symbol-warning checks. All enforce
warm p95 <= 50ms / max <= 150ms with OpenRouter disabled; the large-repo and repo-snapshot verifiers
also record cold first-check time.

---

## 6. Key Technical Risks & Open Decisions

1. Hot-path latency vs. accuracy — local warm cache + deterministic AST diff in place; TS analysis is
   in-process, Python runs in a warm sidecar. Synthetic one-file and 181-file hot-path benchmarks are
   in place, plus a tracked Synapse repo snapshot benchmark; external production-repo profiling
   remains open.
2. Cross-agent support — ✅ Claude Code via installed hooks; Cursor/Cline/Aider via the MCP adapter.
3. Dep-graph accuracy vs. cost — ✅ resolved for v1: ts-morph (TS, in-process) + jedi (Python,
   sidecar). SCIP-grade indexing remains a later option.
4. Privacy boundary — ✅ raw code stays local; only contract deltas + summaries + symbol ids leave the
   machine. The one relaxation (LLM resolver sends a file for context) is opt-in and documented.
5. Self-hosted vs. SaaS — ✅ self-hosted first: SQLite persistence (no infra), optional shared-token
   auth, runs with zero external services. SaaS/multi-instance (Postgres/Redis) is a later swap.
6. Alarm fatigue — severity model (none/info/warn), non-blocking `ask` hook, and explicit
   acted/dismissed feedback capture are in place; using that telemetry to tune thresholds is still
   TODO.

(Open product questions from the context doc — conflict granularity, friction point, session
definition, multi-repo, pricing, name — are tracked in `synapse-context.md` §13.)

---

## 7. Decisions Log (resolved 2026-06-05)

| # | Decision | Choice | Implication |
|---|----------|--------|-------------|
| 1 | Conflict detection depth | **Dependency-graph from day one** | Transitive, contract-level detection is the moat; heaviest build path |
| 2 | Hosting | **Self-hosted first** | Ship Docker Compose; SaaS later. Privacy-first packaging from day one |
| 3 | Agent support | **Agent-agnostic from start** | Universal MCP tools + Claude Code native hooks as the first-class path |
| 4 | Stack | **Hybrid: TS server + polyglot analyzers** | TS server/daemon/realtime; analyzer layer is Node-for-TS + Python-for-Python |
| 5 | Languages first | **TypeScript/JS + Python** | Two analyzers at launch (ts-morph; pyright/jedi) |
| 6 | Intervention model | **Warn inline, dev decides** | No auto-block; severity levels none/info/warn. "Agents query, agents decide" |
| 7 | Analysis location | **Local daemon** | Raw code never leaves the machine; only contract deltas + symbol IDs do |
| 8 | Repo topology | **Single repo first** | Simplest graph scope; monorepo/multi-repo later |
| 9 | Graph engine | **Language-server grade** | ts-morph (TS), pyright/jedi (Python) for real cross-file resolution |
| 10 | Auth | **GitHub OAuth** | Identity = GitHub login; pairs with the GitHub App for webhooks |
| 11 | Collaboration mode | User codes some, owns vision; I own architecture + hard parts | — |
| 12 | Immediate next step | **Write deep technical spec, then scaffold** | See `synapse-technical-spec.md` |

> Note on #4/#5: "language-server-grade" forces the analyzer layer to be polyglot — accurate TS
> resolution needs Node tooling, accurate Python needs Python tooling. So the analyzer layer is
> native-tool-per-language behind one uniform JSON-RPC protocol; Python remains the home for the
> shared graph model and future ML/embeddings. This is the correct reading of "robust," not a deviation.
```

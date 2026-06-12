# Synapse — Product Context Document

> The coordination layer for AI coding agents  
> Last updated: June 2026 | Status: Pre-launch, building toward early access

-----

## Table of Contents

1. [The Core Insight](#1-the-core-insight)
1. [The Problem](#2-the-problem)
1. [What Synapse Is](#3-what-synapse-is)
1. [What Synapse Is Not](#4-what-synapse-is-not)
1. [Architecture](#5-architecture)
1. [Feature Breakdown](#6-feature-breakdown)
1. [The Three Layers (Roadmap)](#7-the-three-layers-roadmap)
1. [Target User](#8-target-user)
1. [Differentiation](#9-differentiation)
1. [The Pitch](#10-the-pitch)
1. [Build Strategy](#11-build-strategy)
1. [Constraints and Principles](#12-constraints-and-principles)
1. [Open Questions](#13-open-questions)

-----

## 1. The Core Insight

When humans wrote all the code, team coordination happened in Slack, standups, and PR reviews. Slow, but it worked — because humans naturally ask each other questions and notice when they’re about to step on someone’s work.

When AI agents write most of the code, three things break simultaneously:

1. **Agents don’t ask each other questions.** They just edit files.
1. **Agents work fast enough** that conflicts emerge in hours, not days.
1. **A single human steering 3–4 agents** can’t manually keep them aligned — there’s too much happening in parallel.

The entire rhythm of how software teams stay in sync was built around humans. It falls apart when most of the typing is done by machines.

**The gap:** coding agents are powerful for one developer in one IDE. They have zero awareness of what a teammate’s agent is doing in a different IDE right now. This is not a limitation that will be fixed by making coding agents smarter — it’s a structural gap that requires a separate coordination layer.

**The opportunity:** build that layer. Not another coding agent. The substrate that every coding agent plugs into — a shared brain that gives each agent awareness of what the rest of the team is doing.

-----

## 2. The Problem

### The Four Scenarios

These are the canonical failure modes that Synapse is built to prevent. They are not hypothetical — every team running multiple coding agents will recognize at least one of these.

**Scenario 01 — The Contract Collision**  
One agent refactors `auth.py` and introduces a new token contract. Meanwhile, another agent spends the morning building a login feature on top of the old auth contract. Both agents pass their tests. Neither one knows about the other. The conflict surfaces at PR review — two hours of wasted work, at minimum.

**Scenario 02 — The Schema Drift**  
One agent adds a field to the user model. A second agent writes a migration that drops it. A third agent writes a test suite against a schema that no longer exists. All three are operating in good faith. None of them can see what the others are doing.

**Scenario 03 — The Stale Context Decision**  
A product decision gets made in Slack at 4pm. By the next morning, two agents have spent the night implementing the rejected version — because their context window never received the update. The decision lived in Slack. The agents live in the IDE. There was no bridge.

**Scenario 04 — The Onboarding Void**  
A new developer joins the team. Their agent reads the codebase. It sees the code, but it cannot see the reasoning — why the codebase is structured the way it is, what was tried and abandoned, what the team decided in a PR thread six months ago. That context lives in PR comments nobody reads anymore, Slack threads that have scrolled away, and the heads of people who are too busy to explain it.

### The Structural Root Cause

The problem is not that the agents are bad at writing code. They’re excellent at writing code. The problem is that **agents work in parallel ignorance** — each one has full context about its own session and zero context about every other session happening simultaneously.

A coding agent sees:

- The codebase (as of the last pull)
- Its own conversation history with the developer
- The files currently open

A coding agent cannot see:

- What a teammate’s agent is editing right now
- What contracts have changed locally but haven’t been pushed yet
- What decisions were made in Slack this morning
- Why a particular architectural choice was made six months ago

Synapse is built specifically to close that gap.

-----

## 3. What Synapse Is

Synapse is a **coordination layer** — a shared brain that every developer’s coding agent plugs into. It sits between the coding agents and the shared codebase, maintaining a real-time picture of what the whole team is doing.

### The One-Liner

> Coding agents write the code. We make sure they’re not writing the same code twice.

### The System in Plain Language

Every developer on the team installs a lightweight hook on their machine (one CLI command). The hook does two things:

1. **Before any agent edits a file** (PreToolUse): it queries Synapse for the current state of that file’s activity. Is anyone else editing it? Have recent unpushed changes affected related contracts? If there’s a real collision incoming, the agent receives that information inline and surfaces it to the developer before the work begins.
1. **After any agent edits a file** (PostToolUse): it captures the diff, distills it into a contract-level summary (what changed at the interface level, not the implementation level), and sends that summary to Synapse. The shared state updates. Every other agent querying Synapse now sees the change.

That’s the core loop. Everything else is built on top of it.

-----

## 4. What Synapse Is Not

This distinction is the most important conceptual move in the pitch. Getting it wrong means being positioned as a worse version of an existing product.

### Not a coding agent

Synapse does not write code. It does not autocomplete, it does not suggest edits, it does not open PRs. Cursor writes code. Claude Code writes code. Copilot writes code. Synapse is what those tools plug into.

### Not competing with Cursor, Claude Code, or Copilot

These are partners, not competitors. A team using Cursor and Synapse together gets more value from Cursor than they would without Synapse. The relationship is additive, not substitutive. The positioning is explicit: **we make every coding agent better**.

### Not a knowledge management tool

Notion, Confluence, and Linear are where teams store documentation and decisions deliberately. Synapse captures knowledge that teams never deliberately wrote down — the reasoning embedded in agent sessions, the contract changes that happened locally before they were pushed, the decisions that lived only in Slack. Synapse is ambient capture, not structured documentation.

### Not a project management tool

Synapse does not assign tasks, track tickets, or manage sprints. It is a coordination layer, not a management layer.

### Not a central orchestrator

Synapse does not make decisions for agents. It does not tell Agent A to stop what it’s doing because Agent B is working in the same area. It gives Agent A the information, and Agent A (and the developer behind it) decides what to do. Intelligence stays in each agent. Synapse is a fast, dumb store that any agent can query.

### The architecture metaphor

> “Coding agents are the muscles. Synapse is the nervous system that lets them work together.”

-----

## 5. Architecture

### Two Sources of Truth

The architecture is built around a clean separation between two layers, each owning what it’s best at:

|Layer                   |Owns                                       |Does Not Own                        |
|------------------------|-------------------------------------------|------------------------------------|
|**GitHub**              |Canonical code, version history            |Real-time state                     |
|**Synapse (MCP server)**|Live work-in-progress metadata             |Actual code, long-term history      |
|**Hooks**               |Capturing changes locally, querying Synapse|Decisions about what to do          |
|**Agent**               |All reasoning and decisions                |Knowing about teammates without help|

**GitHub** holds the durable source of truth — what the code is. Agents push to it after every completed feature, not every micro-edit.

**Synapse** holds ephemeral coordination state — what’s actively happening right now that GitHub doesn’t know about yet. It only ever tracks in-flight work. Once something is pushed to GitHub, GitHub owns it and Synapse clears it.

### The Four Components

```
┌─────────────────────────────────────────────────┐
│                   DEVELOPERS                     │
│        (humans steering agents, reviewing)       │
└─────────────────┬───────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────┐
│              CODING AGENTS                       │
│   Cursor · Claude Code · Copilot · Cline · Aider │
│           (they write the code)                  │
└────────┬─────────────────────────────┬───────────┘
         │ PreToolUse hook             │ PostToolUse hook
         │ (query before edit)         │ (update after edit)
         ▼                             ▼
┌─────────────────────────────────────────────────┐
│                SYNAPSE LAYER                     │
│  CONFLICT         BRIEFING     MEMORY   PROTOCOL │
│  prevention    team awareness  why we   open mcp │
│  edits·diffs   prs·sessions   built it  any agent│
│  ·locks        ·slack         decisions ·any model│
└────────┬──────────────┬──────────────┬───────────┘
         │              │              │
┌────────▼──────────────▼──────────────▼───────────┐
│                    SUBSTRATE                      │
│    REPO      PRs & ISSUES   SLACK/DISCUSSION      │
│                             DOCS / SPECS          │
└───────────────────────────────────────────────────┘
```

### The Signal Flow

**Inbound to Synapse (signals it reads):**

- Git diffs (via hooks on each developer’s machine)
- GitHub webhooks (PR open, merge, comment, review)
- Slack / Discord messages in relevant channels (later)
- Notion / Linear / Jira updates (later)
- Meeting transcripts (later)

**Outbound from Synapse (what agents receive):**

- File-level activity state (who’s editing what, right now)
- Contract-level change summaries (what interfaces changed locally, not yet pushed)
- Agent session summaries (what each dev’s agent was asked to build recently)
- Conflict warnings (inline, in the agent’s context, before the edit happens)
- Team briefings (on request: “what’s the team on?”)

### What Synapse Stores

The MCP server maintains a JSON document (backed by SQLite) describing the live state:

```json
{
  "active_sessions": [
    {
      "dev": "alice",
      "agent": "cursor",
      "files_open": ["src/auth/token.py", "src/auth/middleware.py"],
      "files_editing": ["src/auth/token.py"],
      "last_task": "refactoring token validation to use new JWT library",
      "session_started": "2026-06-05T09:04:00Z",
      "last_update": "2026-06-05T09:47:00Z"
    }
  ],
  "unpushed_changes": [
    {
      "dev": "alice",
      "file": "src/auth/token.py",
      "contract_summary": "TokenValidator.validate() signature changed — now returns Result<Token, AuthError> instead of Optional<Token>",
      "changed_at": "2026-06-05T09:44:00Z",
      "last_commit_sha": "a3f7c9d"
    }
  ],
  "recent_pushes": [
    {
      "dev": "bob",
      "summary": "added rate limiting middleware to auth endpoints",
      "files_affected": ["src/auth/middleware.py", "src/auth/rate_limit.py"],
      "pushed_at": "2026-06-05T08:30:00Z",
      "commit_sha": "b8e1d4a"
    }
  ]
}
```

**Key principle:** Synapse stores distillations, not raw content. A contract-level summary, not the full diff. A session description, not the full conversation history. This keeps the state legible and the server lean.

### The Hook System

Hooks are Claude Code’s PreToolUse and PostToolUse callbacks. They run on each developer’s machine. They are the nerve endings of the system — capturing what’s happening locally and reporting it to the shared brain.

**PreToolUse hook flow:**

```
agent about to edit file
       ↓
hook fires
       ↓
query Synapse: "who's touching [file] or its related contracts?"
       ↓
Synapse responds with current state
       ↓
no conflict → proceed silently (agent never surfaces this to dev)
conflict detected → agent receives warning in context, surfaces to dev inline
       ↓
dev decides: proceed, adjust approach, or ping teammate
```

**PostToolUse hook flow:**

```
agent successfully edits file
       ↓
hook fires
       ↓
capture: file snapshot before, file snapshot after
       ↓
distill via lightweight LLM call: what changed at the contract level?
       ↓
send contract-level summary + metadata to Synapse
       ↓
Synapse updates shared state
       ↓
other agents querying Synapse now see the change
```

**What triggers a conflict warning (not everything does):**

- Another dev’s agent is actively editing the same file right now
- A related contract changed locally (unpushed) that affects the file being edited
- A recently pushed change affects a function/type/endpoint the agent is about to modify

**What does NOT trigger a warning:**

- Two agents reading the same file (reads are fine)
- Minor implementation changes with no contract impact
- Changes in files with no dependency relationship

-----

## 6. Feature Breakdown

### Feature 1: Session Join

A developer joins a session with a single CLI command from inside their cloned repo. The command:

- Registers them with the Synapse MCP server
- Confirms they’re synced to the latest GitHub commit
- Installs the PreToolUse and PostToolUse hooks automatically

Target: five seconds, no manual configuration, immediately ready to work.

### Feature 2: GitHub as Canonical Codebase

GitHub remains the source of truth for actual code. Agents push to it after every completed feature — not every micro-edit, but every meaningful unit of work. When Synapse needs to know what the “current” code looks like, it references the latest pushed state on GitHub.

### Feature 3: Live Work-in-Progress Tracking

Synapse maintains a real-time JSON document describing what’s happening across the team right now:

- Which files are actively being edited and by whom
- What contracts have changed locally but haven’t been pushed yet
- What each developer’s agent was most recently tasked with

This represents the delta between what’s on GitHub and what’s actually happening across all local environments simultaneously.

### Feature 4: Pre-Edit Conflict Prevention

The PreToolUse hook fires before any agent edit, queries Synapse, and surfaces conflicts inline. This is the moment of intervention — the point where wasted work is actually prevented, before it happens.

### Feature 5: Post-Edit State Updates

The PostToolUse hook fires after successful edits, distills the diff to a contract-level summary, and updates the shared state. Raw diffs are not stored — only meaningful metadata about what changed at the interface level.

### Feature 6: Push Checkpoints and State Reset

When a feature is completed and pushed to GitHub, Synapse clears the relevant unpushed-changes entries. The MCP server only ever tracks what’s in flight — it never accumulates history. GitHub owns history; Synapse owns the present.

### Feature 7: Context Awareness for Other Agents

When any agent starts a new task, it can query Synapse for team context — what others are actively building, what unpushed changes affect the area it’s about to touch. This is what prevents “agents working in parallel ignorance” without requiring a central orchestration agent making decisions on behalf of the whole team.

### Feature 8: Team Briefings (Layer II)

Developers can ask their agent “what’s the team on?” and receive a distilled summary of:

- Active sessions and what each agent is building
- Recent PRs merged in the last 24 hours
- Contract changes currently in flight
- Any unresolved conflicts flagged

This is what makes Synapse a daily tool rather than a once-a-week collision preventer.

### Feature 9: Persistent Memory (Layer III — implemented, deepens over time)

Every decision, every reasoning thread, every “why did we build it this way” — captured and stored, queryable in plain language. New hires ask their agent about the codebase and get answers that include the reasoning, not just the code. `synapse_why` and `synapse onboard` answer this deterministically from team state today, with hybrid pgvector recall layered on top when Postgres + an embeddings endpoint are configured. Deeper ingestion sources (Slack, Notion, meeting transcripts) remain future work.

-----

## 7. The Three Layers (Roadmap)

Synapse is designed as a progressive capability system. Each layer builds on the previous one and adds a meaningfully different category of value.

### Layer I — Conflict Prevention

**What it is:** Before any agent makes a meaningful edit, it checks the shared state. Collisions are caught at the source, before the work happens.

**Why it’s first:** It’s the most concrete, demonstrable, and immediately valuable capability. You can demo it in 30 seconds. The value is unambiguous — it prevents wasted work. It’s also the simplest to build and the cheapest to operate (no LLM calls in the hot path, just fast state reads).

**The wedge:** This is the foot in the door. Once a team has installed Synapse for conflict prevention, every other capability is one update away.

### Layer II — Team Briefings

**What it is:** Distilled summaries of every active session and recent PR, on demand. Your agent knows what the team is doing without you having to ask anyone. Proactive push on session start: “here’s what happened since yesterday.”

**Why it matters:** Conflict prevention is a once-a-week event. Briefings are a daily touch. This is what makes Synapse sticky — people open their terminal every morning and check in before they start work.

**What it requires:** A lightweight LLM summarization step (Claude Haiku, GPT-4o-mini) that runs on a batch cycle — not on every edit, but on session end. Cheap per-team, fast enough that it doesn’t block anything.

### Layer III — Persistent Memory

**What it is:** A vector database of every decision, architectural choice, and reasoning thread the team has ever made. Queryable in plain language. “Why does the auth module use JWT instead of sessions?” returns an answer drawn from the actual PR discussion where that decision was made.

**Why it’s the moat:** This is what no other tool builds automatically. Other tools ask you to write down your decisions. Synapse captures them as a byproduct of the work itself — agent sessions generate summaries, PR threads get distilled, Slack decisions get flagged and stored. The knowledge base grows without anyone maintaining it.

**What it requires (implemented):** pgvector on the existing Postgres `StateStore` plus an OpenAI-compatible embeddings endpoint — no separate vector database. PR-thread distillation feeds the memory; deeper ingestion (Slack/Notion integrations) is the remaining infrastructure investment.

-----

## 8. Target User

### Primary: Small startup engineering teams running AI agents

**Size:** 3–10 engineers  
**Shape:** Most or all developers using a coding agent (Cursor, Claude Code, Cline, Copilot, Aider)  
**Pace:** Fast-moving — shipping daily or multiple times per week  
**Pain:** They’ve felt the collision. Two agents committing conflicting changes in the same morning. A migration that broke a teammate’s branch. They know the problem.

**The specific moment of highest pain:** A solo developer steering 3–4 agents simultaneously. This person is the new unit of productivity in an agent-heavy team — they’re not writing most of the code anymore, they’re directing it. The bottleneck has shifted from typing speed to coordination. They need Synapse the most because they’re running the most parallel work.

### Why this segment specifically

1. **They already run agents heavily** — they feel the pain acutely and understand the product immediately
1. **They’re small enough** to make buying decisions fast and install new tools quickly
1. **They’re early adopters** — they tolerate rough edges and give fast feedback
1. **They’re the future** — every engineering team will look like this within 2–3 years

### Who is NOT the target (yet)

- Solo developers (no coordination problem to solve)
- Large enterprises (too slow to adopt, too complex to install)
- Teams that don’t yet run agents (they don’t feel the pain yet — the pitch lands as future-proofing, not urgent relief)
- Teams that use agents only for inline completion, not agentic workflows (less exposure to the parallel-ignorance problem)

### The Self-Identification Test

A target user reads this and nods:

> “If you’ve ever had two agents commit conflicting changes in the same morning, this is for you.”

-----

## 9. Differentiation

### The Three Gaps Coding Agents Don’t Fill

**Gap 1 — Cross-developer awareness**  
A coding agent sees your IDE and your git history. It has zero idea what your teammate is doing in their IDE right now. This is the structural gap — not “knowing the codebase” (coding agents do that) but knowing the *team*.

**Gap 2 — Non-code signals**  
A coding agent reads code. It doesn’t read Slack, it doesn’t read meeting transcripts, it doesn’t read the decision someone made in a Linear ticket this morning. A huge fraction of “what’s going on” in a team lives outside the repo.

**Gap 3 — Temporal continuity across people**  
A coding agent forgets between sessions, and even when it remembers (via memory features), it only remembers *your* sessions. It doesn’t carry “Dev A decided X three weeks ago, then Dev B revised it in a Slack thread, then Dev C built on top of that decision” — that thread of reasoning is invisible to any single-developer agent.

### The Comparison Table

|Dimension           |Coding Agents                         |Synapse                                 |
|--------------------|--------------------------------------|----------------------------------------|
|**Scope**           |One developer, one IDE                |Whole team, all sessions                |
|**Signals**         |Code only — repo, diffs, tests, errors|Code + conversations + decisions + PRs  |
|**Memory**          |Per-developer, per-session. Resets.   |Shared across people and time           |
|**Timing**          |Reactive — you query, it answers      |Proactive — warns you before you collide|
|**What it replaces**|Nothing — it augments coding agents   |Nothing — it augments the whole team    |

### Positioning Statement

Synapse is not competing with Cursor or Claude Code. It is the layer that makes Cursor and Claude Code work better in a team context. The relationship is:

- **Coding agents** = developer-level intelligence
- **Synapse** = team-level awareness

Neither is useful without the other in an agent-heavy team. Together, they form a complete picture: agents that can write excellent code *and* know what their teammates’ agents are doing.

-----

## 10. The Pitch

### One-Liner

> Coding agents write the code. We make sure they’re not writing the same code twice.

### 30-Second Elevator

> Small teams running AI coding agents have a new problem nobody’s solved yet: the agents don’t talk to each other. One agent refactors auth while another builds a feature on top of the old auth. One agent adds a database field while another writes a migration that wipes it. Cursor and Claude Code are incredibly powerful for one developer, but they have zero awareness of what the rest of the team’s agents are doing.
> 
> We’re building the coordination layer. A shared brain that every developer’s agent plugs into, so before any agent edits a file, it knows what the rest of the team is working on. No more parallel ignorance. No more wasted work.
> 
> We’re not competing with coding agents. We’re making every coding agent better.

### Landing Page Pitch (Full)

**Hero:**  
*Coding agents write the code. We make sure they’re not writing the same code twice.*  
A shared brain that gives every developer’s agent awareness of what the rest of the team is doing.

**The problem:**  
When three developers each run a coding agent on the same codebase, the agents don’t know about each other. They don’t ask each other questions. They don’t see each other’s work. They just edit files and push commits as if they’re the only one in the repo.

The merge conflict at PR time isn’t the problem. The wasted work that led there is.

**What Synapse does:**  
Before any agent makes a meaningful edit, it queries the shared state — who’s editing what right now, recent commits, contracts that changed locally but haven’t shipped yet. If a real collision is incoming, the agent surfaces it inline, before the work happens.

Over time, the brain becomes the team’s persistent memory. Decisions, context, the reasoning behind why things were built the way they were — none of which lives in the code, all of which gets lost in Slack threads and PR comments. Your agents stop forgetting across people and across time.

**The differentiation:**  
We’re not a coding agent. We make every coding agent better. Cursor, Claude Code, Copilot, whatever you’re running — they all plug into the same brain. We don’t write your code. We make sure the agents writing it know what their teammates’ agents just did.

**Who this is for:**  
When agents do most of the typing, the bottleneck isn’t typing speed anymore — it’s coordination. A solo developer steering three agents is the new unit of productivity, and the coordination problems that used to take a week to surface now surface in a day. Slack standups and async docs weren’t built for that pace. Synapse was.

### The Quote

> “Coding agents are the muscles. Synapse is the nervous system that lets them work together.”

### User Interview Script (Opening)

> “Quick question first — how many of your devs are using Cursor or Claude Code or something similar right now?”
> 
> [Let them answer. Follow up:]
> 
> “And are you running agents in the background too, like async work, or mostly just inline assistance?”
> 
> [Get them talking about their setup. Then:]
> 
> “Here’s what I’m trying to figure out. When you’ve got 3 or 4 people all running agents at the same time, do you ever get into situations where two agents are basically working on overlapping stuff and nobody realizes until PR time?”
> 
> [Wait for the story. There will be a story. Then:]
> 
> “Yeah, that’s exactly the thing. So I’m building something pretty simple: it’s a shared awareness layer that sits between all your devs’ coding agents. Before any agent makes a meaningful edit, it checks a shared state — who’s editing what, what just got merged, what contracts changed locally but haven’t been pushed yet. If there’s a real collision incoming, the agent surfaces it inline before the work happens.
> 
> Long term it becomes a kind of team brain — your agents stop forgetting things across people and across time. New hires onboard by talking to it. But the wedge is just: stop your agents from stepping on each other.”

**Key principle for user interviews:** Lead with the wedge (conflict prevention), not the vision (team brain). The wedge is concrete and immediately understood. The vision is abstract and harder to evaluate. Once they’re nodding at the wedge, unfold the vision.

-----

## 11. Build Strategy

### Phase 0 — Validation (Weeks, No Code)

**Goal:** Prove the pain is real before building anything.

**Actions:**

- Talk to 8–10 small teams running agents (Reddit r/cursor, Cursor Discord, Twitter/X, Indie Hackers, r/ChatGPTCoding, YC startup directory)
- Ask: “tell me about a time two of your agents collided.” Look for specific stories with details.
- Success criterion: 3 written user stories from real people with real scenario descriptions.
- Failure criterion: Nobody can tell you a story. If nobody has felt the pain yet, the timing is early.

**What to send before the call:** The Synapse landing page URL. Their reaction to it tells you whether the pitch lands before you get on the call.

### Phase 1 — The Wedge MVP (4–6 Weeks)

**Goal:** Ship the conflict-prevention tool, nothing more.

**Scope (ruthlessly constrained):**

- MCP server on a free tier (Fly.io, Railway, or Cloudflare Workers — $0)
- Claude Code PreToolUse + PostToolUse hooks, distributed as a single shell script
- State stored in SQLite — no vector database, no LLM in the hot path
- Session join: one CLI command, auto-installs hooks
- Conflict detection: contract-level (implemented) — file-level was the MVP starting point
- No dashboard, no web UI, no analytics — everything surfaces inline in the agent’s context

**Infrastructure cost:** $0–$5/month until you have real users.

**The test:** Can one team, in one morning, prevent one real collision they would otherwise have hit?

### Phase 2 — The Briefing Layer (6–8 Weeks After Phase 1)

**Goal:** Prove the brain has daily value beyond conflict prevention.

**New capabilities:**

- `synapse whatsup` — agent queries brain, returns 2–3 sentence summary of team activity
- Session end summarization — lightweight LLM (Claude Haiku) distills each session into a summary before it closes
- GitHub PR webhook ingestion — free, structured, high-signal
- Morning briefing push — on session start, agent receives “here’s what happened since you were last here”

**Why this matters:** Conflict prevention is a once-a-week event. Briefings make Synapse a daily tool. Daily use = retention = the foundation for everything else.

### Phase 3 — The Memory Layer (When Funded)

**Goal:** Become the team’s persistent knowledge graph.

**New capabilities:**

- Vector database (Chroma self-hosted to start, Pinecone when budget allows)
- Slack ingestion pipeline
- Decision tracking (“this PR thread contains a architectural decision — flagging for memory”)
- Plain-language queries: “why did we build auth this way?”
- Onboarding mode: new hire’s agent gets briefed in one conversation

**Why this is the moat:** Every other Layer III capability can be copied. But the knowledge graph built from *your team’s actual agent sessions and decisions* — that’s yours. It grows with every push, every PR, every session. The longer a team uses Synapse, the more valuable their memory layer becomes, and the harder it is to replace.

### The Rule: Don’t Skip Phases

Layer III is the most exciting. Layer I is what makes Layer III possible.

The progression matters because:

- Layer I earns trust and installs (teams let you run hooks on their machines)
- Layer II earns daily engagement (teams open Synapse every morning)
- Layer III earns retention and word-of-mouth (teams can’t imagine working without it)

You cannot sell Layer III to a team that hasn’t experienced Layer I.

-----

## 12. Constraints and Principles

### The Money Constraint

Synapse needs to be built for near-zero infrastructure cost until there are paying users. This is a forcing function, not just a limitation — it keeps the scope correct.

**What costs nothing (or nearly nothing):**

- MCP server on Fly.io / Railway / Cloudflare Workers free tiers
- SQLite for state storage
- GitHub webhooks (free API)
- Claude Haiku for summarization (~$0.001 per session summary)
- Shell script hook distribution (GitHub release, no server needed)

**What gets deferred until revenue:**

- Vector database at scale
- Slack ingestion
- Web dashboard / analytics
- Mobile notifications

**Target infrastructure cost at launch:** < $20/month for the first 20 teams.

### Design Principles

**1. Agents query, agents decide.**  
Synapse does not make decisions on behalf of agents. It surfaces information. The agent (and the developer behind it) decides what to do. No central orchestrator. No second LLM second-guessing the first one.

**2. Store distillations, not raw content.**  
Contract-level summaries, not full diffs. Session descriptions, not conversation histories. This keeps the state legible, the queries fast, and the storage cheap.

**3. Synapse clears itself.**  
The MCP server is not a history store. Once a change is pushed to GitHub, it’s cleared from Synapse. Synapse only ever knows about what’s in flight right now. GitHub owns history.

**4. Silent on no-conflict, loud on conflict.**  
Every PreToolUse hook fires, but 95% of the time the agent hears nothing and continues working. Only real conflicts surface. If the system is noisy, developers will turn it off.

**5. Zero-trust install.**  
Synapse should be installable as a self-hosted MCP server on the team’s own infrastructure. Agent-heavy startup teams are privacy-paranoid about their code. The self-hosted option removes the trust barrier. SaaS (running on Synapse’s servers) comes later, once trust is established.

**6. No surveillance framing.**  
The agent works *for you*, not *on you*. Synapse surfaces team context *to you*, not reports about you *to management*. The mental model is: “my agent is now aware of my teammates’ agents.” Not: “the system is tracking what I’m doing.”

-----

## 13. Open Questions

These are the unresolved product and business questions as of June 2026. They should be answered through user interviews and early-access feedback, not through assumption.

### Product Questions

1. **Granularity of conflict detection.** Should Phase 1 detect conflicts at the file level (same file being edited simultaneously) or the contract level (changed function signatures, types, endpoints)? File-level is simpler and faster to build. Contract-level is higher signal with fewer false positives.
1. **The right friction point.** When a conflict is detected, does the agent: (a) surface a warning and wait for the developer to decide, (b) surface a warning and ask the agent to adjust its approach autonomously, or (c) just log it and continue? Too much friction = developers disable the hooks. Too little = conflicts still happen.
1. **How do agents query Synapse?** Does it happen on every file touch (expensive, frequent) or only on files above a certain complexity/dependency threshold (harder to define, fewer interruptions)?
1. **Session definition.** When does a “session” start and end? When Claude Code opens? When a developer types their first prompt? What if they leave it running overnight?
1. **Multi-repo support.** How does Synapse handle teams working across multiple repos? Does each repo get its own Synapse instance, or is there a team-level Synapse that spans repos?

### Business Questions

1. **Distribution: self-hosted vs SaaS?** For agent-heavy startup teams who are privacy-paranoid about their code, a self-hosted MCP server is a lower-trust-barrier install. But SaaS is easier to monetize and update. The answer might be: self-hosted for early access, SaaS with a self-hosted option later.
1. **Pricing model.** Per-seat (like most dev tools)? Per-team? Usage-based (per agent-session or per query)? The pricing model signals who the buyer is — per-seat implies individual adoption, per-team implies company adoption.
1. **Where do users discover this?** The likely early channels: Cursor Discord, Claude Code Discord/forums, Twitter/X developer community, Indie Hackers, r/ChatGPTCoding, r/cursor, YC/startup community. Need to find the specific communities where 3–10 person agent-heavy teams congregate.
1. **The name.** Synapse is the working name. The domain landscape is competitive. Alternatives to investigate: `trysynapse.dev`, `synapse.coop`, `getsynapse.io`, `syn.app`. The name should feel like infrastructure (short, lowercase, vaguely technical) rather than a product (evocative, consumer-facing).

-----

## Appendix: The Full System Flow

```
Dev joins session, syncs to latest GitHub commit
              ↓
    ─── normal Claude Code workflow ───
              ↓
    Dev's agent prepares to edit a file
              ↓
    PreToolUse hook → Synapse query
         ├── Anyone editing this file?
         └── Any unpushed changes affecting related contracts?
              ↓
    No conflict → proceed silently (95% of cases)
    Conflict → warning inline, dev decides
              ↓
         Agent edits file
              ↓
    PostToolUse hook captures diff
              ↓
    Diff distilled to contract-level summary
              ↓
    Synapse updates "work in progress" state
              ↓
    Other agents querying Synapse now see the change
              ↓
    ─── repeat until feature complete ───
              ↓
    Agent pushes feature to GitHub
              ↓
    Synapse clears related in-progress entries
              ↓
    Canonical codebase on GitHub is fresh again
```

-----

## Appendix: Key Vocabulary

|Term                     |Definition                                                                                                                                              |
|-------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------|
|**Coordination layer**   |The infrastructure between coding agents that gives them team-level awareness. What Synapse is.                                                         |
|**Parallel ignorance**   |The state where multiple agents are working simultaneously with no awareness of each other. The problem Synapse solves.                                 |
|**Contract-level change**|A change to the interface of a component — function signatures, model fields, API endpoints — as opposed to implementation changes. What Synapse tracks.|
|**In-flight work**       |Code that has been written locally but not yet pushed to GitHub. The gap Synapse operates in.                                                           |
|**Hook**                 |A Claude Code callback (PreToolUse or PostToolUse) that fires before or after an agent action. How Synapse integrates with coding agents.               |
|**Distillation**         |The process of converting a raw diff into a contract-level summary. What Synapse does before storing a change.                                          |
|**Session**              |A continuous period of a developer and their agent working together on a task. The unit of activity Synapse tracks and summarizes.                      |
|**Team brain**           |The long-term vision for Synapse — a persistent, queryable knowledge graph of everything the team has built, decided, and reasoned through.             |

-----

*Synapse · the coordination layer · built in Texas, 2026*
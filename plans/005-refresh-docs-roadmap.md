# Plan 005: Refresh roadmap and status documentation

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a STOP condition occurs, stop and report instead of improvising. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 3a0b685..HEAD -- README.md synapse-build-plan.md synapse-technical-spec.md synapse-context.md`
> If any in-scope file changed since this plan was written, compare the current-state excerpts below against the live docs before proceeding.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `3a0b685`, 2026-06-11

## Why this matters

The README and planning docs are the repo's source of truth for users and future implementers. They currently disagree with implemented features: the README says Postgres/Redis and pgvector/RAG are both implemented in operations sections, but earlier status and roadmap text still says they are later. That creates bad handoffs and can lead future agents to re-plan already shipped work.

## Current state

- `README.md` is the primary user-facing doc.
- `synapse-build-plan.md` is the engineering roadmap/status doc.
- `synapse-technical-spec.md` is the detailed design contract.
- `synapse-context.md` is product/vision; it may intentionally describe later-stage ideas, so update it only where statements are now plainly contradicted by implementation.

Relevant excerpts:

```md
<!-- README.md:54 -->
<td><b>Durable state</b></td>
<td>Server state persists through a storage-agnostic <code>StateStore</code> (SQLite now; Postgres/Redis later) and survives restarts.</td>
```

```md
<!-- README.md:233 -->
**State store** - persisted per entity ... `SYNAPSE_DATABASE_URL` -> Postgres ...

<!-- README.md:235 -->
**Multi-instance** - set `SYNAPSE_REDIS_URL` ... several server instances ...

<!-- README.md:253 -->
**RAG memory** - with `SYNAPSE_DATABASE_URL` (Postgres + pgvector) and an OpenAI-compatible embeddings endpoint ...
```

```md
<!-- README.md:336 -->
| **4** | Persistent memory (`synapse why` deterministic seed now; pgvector/RAG later) |
```

```md
<!-- synapse-build-plan.md:30 -->
| **Redis** live state + pub/sub (multi-instance fan-out) | Deferred | in-memory + SQLite today; `StateStore` is the swap seam |
| **Postgres** durable store (multi-instance) | Deferred | SQLite implements the same `StateStore` interface |
| Memory Layer III - `synapse_why` + pgvector target | Partial | deterministic state search now; vector memory later |
```

```md
<!-- synapse-technical-spec.md:495 -->
Memory answers (Layer III): deterministic state search today; later RAG over pgvector

<!-- synapse-technical-spec.md:511 -->
### Postgres (durable) - planned, not yet implemented
```

Repo conventions to match:

- README uses concise feature/ops sections plus a verification table.
- Planning docs can retain future architecture, but status labels must be current.
- Keep docs factual and avoid marketing rewrites.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Find stale claims | `rg -n "Postgres|Redis|pgvector|RAG|later|Deferred|planned, not yet implemented" README.md synapse-build-plan.md synapse-technical-spec.md synapse-context.md` | no stale implementation-status claims remain |
| Typecheck sanity | `npm run typecheck` | exit 0 |
| README verify table sanity | `npm run verify:why-rag` | exits 0 or documented SKIP |
| Multi-instance sanity | `npm run verify:multi-instance` | exits 0 or documented SKIP |

## Scope

**In scope**:

- `README.md`
- `synapse-build-plan.md`
- `synapse-technical-spec.md`
- `synapse-context.md` only for stale "not implemented yet" statements that are no longer true.

**Out of scope**:

- New product promises not backed by code or tests.
- Large narrative rewrite of the product vision.
- Changing badges, license, or install commands unless directly stale.

## Git workflow

- Branch: `advisor/005-refresh-docs-roadmap`
- Suggested commit: `docs(plan): refresh implemented feature status`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Make README internally consistent

Update `README.md` so:

- The feature table says durable state supports SQLite and optional Postgres, with Redis fanout for multi-instance deployments.
- Memory Search mentions deterministic search plus optional RAG when Postgres/pgvector and embeddings are configured.
- The roadmap no longer says pgvector/RAG is later. Either mark milestone 4 complete/current or replace the roadmap with a concise "Current status / Next" table.
- Keep the existing verification script table entries for `verify:persistence-pg`, `verify:multi-instance`, and `verify:why-rag`.

**Verify**: `rg -n "Postgres/Redis later|pgvector/RAG later" README.md` -> no matches.

### Step 2: Refresh engineering build-plan status

Update `synapse-build-plan.md` status rows for:

- Redis live state/pub-sub multi-instance fanout.
- Postgres durable store.
- Memory Layer III / `synapse_why` + pgvector/RAG.
- Go analyzer if the status table still says not started; current README and package structure show Go analyzer exists.
- Feedback/adaptive severity if the status still says threshold tuning later but README lists adaptive severity as implemented.

Use precise language such as "Done for self-hosted env vars; SaaS provisioning still later" if there is still future work.

**Verify**: `rg -n "Redis.*Deferred|Postgres.*Deferred|vector memory later|Go analyzer; SCIP-grade indexing.*Not started" synapse-build-plan.md` -> no stale matches.

### Step 3: Update technical spec status without erasing future architecture

In `synapse-technical-spec.md`, change "planned, not yet implemented" and "later RAG over pgvector" statements that are false today. Keep sections that describe intended production architecture, but mark current implementation accurately:

- SQLite remains local/default.
- Postgres is implemented behind `SYNAPSE_DATABASE_URL`.
- Redis fanout is implemented behind `SYNAPSE_REDIS_URL`.
- pgvector RAG is implemented when Postgres and embeddings are configured; it degrades cleanly otherwise.

**Verify**: `rg -n "planned, not yet implemented|later RAG over pgvector|Postgres.*planned|Redis.*planned" synapse-technical-spec.md` -> no stale implementation-status matches.

### Step 4: Touch context doc only where necessary

Review `synapse-context.md` search results. If a statement is a product-layer future vision, leave it. If it says current Synapse lacks something already implemented, update that local sentence and avoid a broad rewrite.

**Verify**: `rg -n "Persistent Memory .*later|contract-level later|file-level first" synapse-context.md` -> either no stale matches or remaining matches are clearly historical/future-vision context.

### Step 5: Run lightweight verification

Docs do not need a full build, but run a typecheck to catch accidental repo edits and optional verifiers that correspond to the docs if services are configured.

**Verify**:

- `npm run typecheck` -> exit 0.
- `npm run verify:why-rag` -> exit 0 or documented SKIP.
- `npm run verify:multi-instance` -> exit 0 or documented SKIP.

## Test plan

- Search-based stale-claim checks are the primary doc test.
- Typecheck confirms no accidental code/config breakage.
- Existing optional verifiers anchor the claims if external services are available.

## Done criteria

- [ ] README no longer claims implemented Postgres/Redis/RAG work is later.
- [ ] Build-plan status rows match implemented features and remaining future work.
- [ ] Technical spec marks current storage, fanout, and RAG behavior accurately.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run verify:why-rag` exits 0 or documented SKIP.
- [ ] `npm run verify:multi-instance` exits 0 or documented SKIP.
- [ ] `plans/README.md` status row for Plan 005 is updated.

## STOP conditions

Stop and report if:

- The code no longer contains the claimed Postgres, Redis, or RAG implementation.
- The docs have already been fully refreshed and the cited stale lines are gone.
- You need product decisions about a new roadmap beyond correcting stale status.

## Maintenance notes

When major features land, update README feature text, verification table, build-plan status, and technical spec status in the same PR. Reviewers should reject feature PRs that add verification scripts but leave the roadmap saying the feature is future work.


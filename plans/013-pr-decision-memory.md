# Plan 013: Carry distilled PR-thread prose into repo events and vector memory

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c46a61..HEAD -- apps/server/src/github.ts apps/server/src/index.ts apps/server/src/memory.ts packages/protocol/src/index.ts packages/protocol/src/wire-schema.ts`
> If any of these changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> Known drift (verified post-review): plan 004 (daemon input hardening)
> MERGED after this plan was stamped (PR #52, commit `776a717`), so the
> drift check WILL report `packages/protocol/src/wire-schema.ts` (+84 lines,
> `parseServerMessage`) — expected, not a STOP. The `repo.event` payload
> schema is unchanged (a looseObject at ~line 217 — the "z.unknown()" STOP
> below will not fire); all `github.ts`, `memory.ts`, and `indexMemory`
> citations were re-verified post-merge and match. Re-anchor by
> schema/symbol names if lines shift further.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (touches the privacy boundary — what prose leaves GitHub and gets embedded; mitigated by deterministic distillation that strips code)
- **Depends on**: none
- **Category**: direction (C3 slice — decision tracking from PR threads)
- **Planned at**: commit `8c46a61`, 2026-06-11

## Why this matters

Synapse's memory layer promises answers to "why did we build auth this way?"
with citations. The ingestion exists — GitHub `pull_request`,
`pull_request_review`, and `issue_comment` webhooks become repo events, and
repo events are embedded into pgvector — but the conversion functions **drop
the body text**. A review comment that says "we chose project keys over
OAuth because self-host must work with zero third-party deps" reaches memory
as only `"GitHub comment created on PR #5: <title>"`. The decision itself is
discarded at the door, so `synapse why` and the onboarding briefing
(plan 011) can cite that a conversation happened but never what was decided.
This plan carries a **distilled, code-stripped excerpt** of the body into
the repo event and therefore into vector memory — deterministically, no LLM.

## Current state

- `apps/server/src/github.ts` (323 lines) — webhook payload conversion.
  `issueCommentToNotify` (lines ~208–238) reads `comment.comment.html_url`
  but never `comment.comment.body`; its output summary is the one-liner:

  ```ts
  summary: `GitHub comment ${action} on ${subject} #${number ?? "?"}: ${title}`
  ```

  `pullRequestReviewToNotify` (lines ~174–207) likewise uses only the review
  `state` — `review.review.body` is dropped. The payload type stubs at the
  top of the file (`GitHubIssueCommentPayload` has `comment?: {...}` at
  line ~57) currently declare only the fields read today; you will extend
  them with `body?: unknown`.

- `packages/protocol/src/index.ts:298–310` — the entity both the wire and
  the store carry:

  ```ts
  export interface RecentRepoEvent {
    id: string;
    repoId: string;
    kind: RepoEventKind;
    action: string;
    actor: string;
    title: string;
    number?: number;
    url?: string;
    summary: string;
    createdAt: string;
  }
  ```

  You will add `detail?: string` (additive — optional fields on entities are
  the established compatibility pattern; see the optional `branch` field
  added by M6.5 on `Session`/`RecentPush`).

- `packages/protocol/src/wire-schema.ts` — zod ingress schemas, built as
  **loose objects for forward compatibility** (see the file's own comments).
  Find the `repo.event` payload schema and add the optional `detail` string
  with a max length.

- `apps/server/src/index.ts:527–561` — `indexMemory` is where the prose
  reaches pgvector. The repo-event branch:

  ```ts
  } else if (message.type === "repo.event") {
    memory.index(repoId, {
      id: `event:${message.id}`,
      kind: "repo_event",
      title: message.payload.title,
      summary: message.payload.summary,
      reference: message.payload.url,
      createdAt: new Date().toISOString()
    });
  }
  ```

  The doc comment above it states the privacy contract you must preserve:
  "Only prose (titles, summaries, rationales) is embedded — never raw code."

- `apps/server/src/github.test.ts` — existing unit tests for the conversion
  functions; extend them, matching their style.

- `scripts/verify-github-webhook.mjs` — end-to-end webhook verify (POSTs
  signed payloads at a live server); `scripts/verify-why-rag.mjs` — the
  PG-gated RAG verify with a stub embedding provider. Both are exemplars.

- Privacy conventions: README has a dedicated **Privacy** section; the spec
  principle is "store distillations, not raw content" (`synapse-context.md`
  §12). The distiller below enforces it deterministically.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | all pass |
| Webhook verify | `npm run verify:github-webhook` | exit 0 |
| RAG verify (PG-gated) | `npm run verify:why-rag` | exit 0; a printed SKIP line (no Postgres) **also counts as success** — set `SYNAPSE_VERIFY_PG_URL` only if you have a local pgvector Postgres |

## Scope

**In scope**:
- `apps/server/src/github.ts` — distiller + body threading
- `apps/server/src/github.test.ts` — unit tests
- `packages/protocol/src/index.ts` — `detail?: string` on `RecentRepoEvent` + the `repo.event` payload
- `packages/protocol/src/wire-schema.ts` (+ its test) — schema field
- `apps/server/src/index.ts` — `indexMemory` embeds `detail`
- `apps/server/src/store.ts` / `store-pg.ts` — ONLY if repo events are
  persisted column-by-column rather than as JSON (check `appendRepoEvent`;
  if rows store a JSON blob of the entity, nothing to do)
- `scripts/verify-github-webhook.mjs` — extend assertions
- `README.md` — one sentence in the Privacy section

**Out of scope** (do NOT touch):
- Any LLM distillation (the `SummaryProvider` seam) — deliberately deferred;
  this slice is deterministic.
- Slack or any non-GitHub ingestion.
- Daemon/briefing rendering (`apps/cli/**`) — `detail` flows into memory
  server-side; client surfaces pick it up via recall summaries without code
  changes.
- Webhook signature/rate-limit logic in `apps/server/src/index.ts` (G4 —
  already shipped; do not refactor around it).

## Git workflow

- Branch: `advisor/013-pr-decision-memory`
- Conventional commits, e.g. `feat(server): distill PR-thread prose into repo events + memory (C3 slice)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: The distiller (pure function in `github.ts`)

Add `distillProse(body: unknown, maxChars = 500): string | undefined`:

1. Non-string or blank → `undefined`.
2. Strip fenced code blocks (``` … ```) and inline code spans (`` ` … ` ``)
   entirely — replace with `[code omitted]` at most once per block. This is
   the privacy guarantee: never embed code.
3. Strip markdown image/link URLs (keep link text), collapse all whitespace
   runs to single spaces, trim.
4. Truncate to `maxChars` at a word boundary with a trailing `…`.
5. Return `undefined` if what remains is under ~12 characters (noise like
   "+1", "LGTM" carries no decision content — drop it).

Unit-test it directly (see Test plan).

**Verify**: `npm test --workspace @synapse/server 2>/dev/null || npm test` →
new distiller tests pass.

### Step 2: Thread bodies through the converters

1. Extend the payload type stubs: `comment?: { html_url?: unknown; body?: unknown }`
   on `GitHubIssueCommentPayload`; `review?: { state?: unknown; html_url?: unknown; body?: unknown }`
   on `GitHubPullRequestReviewPayload`; `pull_request?: { ...; body?: unknown }`
   on `GitHubPullRequestPayload`.
2. In `issueCommentToNotify`, `pullRequestReviewToNotify`, and
   `pullRequestToNotify` (PR description on `opened`/`merged` only), set
   `detail: distillProse(<body>)` on the returned payload. The existing
   one-line `summary` stays exactly as-is — UI surfaces keep their short line.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Protocol + wire schema

1. `packages/protocol/src/index.ts` — add `detail?: string` to
   `RecentRepoEvent` (line ~298) and to the `repo.event` client-message
   payload type (grep `"repo.event"` in the `ClientMessage` union).
2. `packages/protocol/src/wire-schema.ts` — add `detail` as an optional
   string capped at 2000 chars (`z.string().max(2000).optional()`) to the
   repo-event payload schema. Note: the neighboring fields (`title`,
   `summary`, `action`) carry no max length — the cap on `detail` is a
   deliberate new guard, not a convention to mirror (the distiller already
   caps at 500; the wire cap is belt-and-braces against non-distilled
   senders). Add a schema test case in `wire-schema.test.ts` mirroring its
   neighbors (valid with/without `detail`; over-cap rejected).

**Verify**: `npm test --workspace @synapse/protocol` → all pass.

### Step 4: Embed it

**4a — feed the vector index.** In `apps/server/src/index.ts`
`indexMemory`, repo-event branch: embed the detail when present —

```ts
summary: message.payload.detail
  ? `${message.payload.summary} — ${message.payload.detail}`
  : message.payload.summary,
```

Then two follow-on tasks, kept distinct:

**4b — thread `detail` onto the stored entity.** Find where the
`RecentRepoEvent` entity is built from the webhook notify payload (grep
`recentRepoEvents` in `apps/server/src/state.ts`) and copy `detail` onto
it. Purpose: the stored entity stays a complete record — visible in
`GET /state`, available to future UI. This is NOT redundant with 4a: 4a
feeds the vector index, 4b preserves the record.

**4c — design decision (already made; apply it, state it in the commit
body):** the entity `summary` stays the short one-liner; prose lives only
in `detail` and in the memory entry's embedded text. Accepted consequence:
the *lexical* `why` floor scores `summary` only (see `whySources` in
`apps/cli/src/briefings.ts`), so it does not search `detail` in this slice
— vector recall does. Do not widen lexical scoring here.

**Verify**: `npm run build && npm test` → exit 0.

### Step 5: End-to-end verification

Extend `scripts/verify-github-webhook.mjs`: POST a signed `issue_comment`
payload whose body contains a decision sentence plus a fenced code block;
assert via `GET /state` that the stored repo event's `detail` contains the
sentence and does NOT contain the code-block content. If the script
currently only tests `push` events, add the `issue_comment` case following
its existing request helpers.

Optionally (only if `SYNAPSE_VERIFY_PG_URL` is available locally) run
`verify:why-rag` to confirm memory indexing still passes — the stub
provider there exercises `indexMemory`.

**Verify**: `npm run verify:github-webhook` → exit 0.

### Step 6: README privacy note

Add one sentence to the README Privacy section: PR/issue comment prose is
distilled (code blocks stripped, capped) before being stored or embedded;
raw bodies are never persisted.

**Verify**: `grep -n 'distill' README.md` → 1 match.

## Test plan

In `apps/server/src/github.test.ts` (match its existing test style):

1. distiller: fenced block stripped, inline code stripped, whitespace
   collapsed, word-boundary truncation at 500, short-noise → `undefined`,
   non-string → `undefined`.
2. `issue_comment` payload with body → `detail` present; without body →
   `detail` absent (not `""`).
3. `pull_request_review` with body → `detail`; review with empty body
   (approve-with-no-comment) → no `detail`.
4. `pull_request` `opened` with description → `detail`.

Plus the wire-schema test (Step 3) and the webhook verify (Step 5).
Verification: `npm test` → all pass including new cases.

## Done criteria

- [ ] `npm run build`, `npm run typecheck`, `npm test` exit 0
- [ ] `npm run verify:github-webhook` exits 0 including the new `issue_comment` body assertion
- [ ] `grep -c 'distillProse(' apps/server/src/github.ts` → ≥ 4 (definition + three converter call sites)
- [ ] `grep -c 'detail:' apps/server/src/github.ts` → 3, and `grep -cE 'detail: distillProse' apps/server/src/github.ts` → 3 — every `detail` assignment goes through the distiller
- [ ] Code-block content provably absent from stored events (the Step 5 assertion)
- [ ] No files outside the in-scope list modified (`git status --porcelain`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `appendRepoEvent` in the stores persists entities column-by-column AND
  adding a column requires a migration framework that doesn't exist — report
  the store shape rather than inventing migrations (expected shape: JSON or
  per-field columns with an obvious additive path; the M8 SQLite store
  auto-migrated once before, see `plan-future.md` §6 M8 entry).
- The wire-schema's repo-event payload turns out to be `z.unknown()`/absent
  (i.e., webhook-originated events bypass ingress validation) — that's a
  security-relevant discovery; report it, don't quietly add validation.
- You find yourself wanting to send the body to an LLM — out of scope.

## Maintenance notes

- This is the substrate for the vision doc's "decision tracking" — a later
  slice can classify which details are *decisions* (LLM-assisted, via the
  existing optional-provider seam) instead of embedding all of them.
- Plan 011 (`synapse onboard`) benefits automatically: its recall query
  surfaces these memories once indexed. If both land, the onboard verify's
  RAG section is a good place to assert a decision excerpt shows up.
- Reviewer focus: the distiller's code-stripping (privacy boundary) and that
  `detail` is absent—not empty-string—when there's no body (looseObject
  forward-compat patterns treat `""` as present).

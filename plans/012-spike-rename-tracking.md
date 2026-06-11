# Plan 012: Spike TypeScript rename tracking — emit `renamed` instead of `removed`+`added`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c46a61..HEAD -- packages/analyzer-ts/src packages/conflict-engine/src/compare.ts apps/cli/src/daemon.ts packages/protocol/src/index.ts`
> If any of these changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> Known in-flight drift: plan 004 (daemon input hardening) was being executed
> in this worktree when this plan was written — it shifts
> `apps/cli/src/daemon.ts` line numbers by roughly +14. The differ dispatch
> and change→delta mapping survive unchanged. Re-anchor by symbol names
> (`diffTypeScriptContracts`, `summarizeSymbolChange`); that change alone is
> NOT a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (heuristic detection — a false pairing produces a misleading delta; mitigated by a strict unambiguity rule and an opt-out)
- **Depends on**: none
- **Category**: direction (F5 first slice — rename tracking, deferred backlog in `plan-future.md` Phase D)
- **Planned at**: commit `8c46a61`, 2026-06-11

## Why this matters

When an agent renames an exported symbol, the TypeScript analyzer reports it
as two unrelated changes — `removed` + `added` — because the differ keys
strictly on symbol id. Teammates whose code depends on the old name get a
"symbol removed" delta with no pointer to the new name, and the
"contract-level, not file-level" pitch leaks exactly where it matters most:
renames are among the most common breaking edits agents make. The wire
protocol has been ready for this since day one — `ChangeKind` includes
`"renamed"` (`packages/protocol/src/index.ts:119–125`), the daemon's
summarizer already has a `case "renamed"` (`apps/cli/src/daemon.ts:991`),
and the MCP schema enumerates it (`apps/cli/src/mcp.ts:101`) — but **no
analyzer ever emits it**. This spike makes the TS differ detect unambiguous
same-file renames. Python/Go follow in a later plan if the heuristic proves
out.

## Current state

- `packages/analyzer-ts/src/index.ts:145–197` — `diffTypeScriptContracts(before, after)`:
  exact-id matching; a rename falls through to the `removed` branch (155–162)
  plus the `added` branch (185–193):

  ```ts
  for (const [raw, beforeSymbol] of beforeById) {
    const afterSymbol = afterById.get(raw);
    if (!afterSymbol) {
      changes.push({ symbolId: beforeSymbol.id, changeKind: "removed", before: beforeSymbol, after: null });
      continue;
    }
    ...
  }
  for (const [raw, afterSymbol] of afterById) {
    if (!beforeById.has(raw)) {
      changes.push({ symbolId: afterSymbol.id, changeKind: "added", before: null, after: afterSymbol });
    }
  }
  return changes.sort((a, b) => a.symbolId.raw.localeCompare(b.symbolId.raw));
  ```

- **The name is baked into the signature**, so `sigHash` CANNOT be the
  rename-matching key: `toCodeSymbol` hashes the normalized signature
  (`packages/analyzer-ts/src/index.ts:547–558`), and `callableSignature`
  builds `signature.raw` from the label + **name** + params + return
  (lines 564+). A renamed function has a different `sigHash` by
  construction. The matching key must be a *name-independent* shape derived
  from the structured fields: `kind` + ordered `params` (`name`,`type`,`optional`)
  + `returns` + type params. Note param *names* are part of `SignatureParam`
  — decide deliberately: include param names in the shape key (stricter,
  fewer false pairs — RECOMMENDED for the spike) and document it.

- `packages/protocol/src/index.ts:143–148` — `SymbolChange { symbolId, changeKind, before, after }`:
  `before`/`after` are full `CodeSymbol`s, so a `renamed` change can carry
  the old symbol in `before` and the new one in `after` with
  `symbolId = after.id` (the surviving identity). No protocol change needed.

- `apps/cli/src/daemon.ts:902–907` — the daemon picks the per-language
  differ; TS path calls `diffTypeScriptContracts(previous, current)` and
  maps each change into a `ContractDelta` (with `dependents` computed from
  the dependency graph). Find the exact mapping function around line 907
  (`toContractChanges`/`buildDelta` area, lines ~900–940) and confirm where
  `dependents` are looked up — for a rename, dependents must be computed
  from the **old** symbol id (that's who breaks).

- `packages/conflict-engine/src/compare.ts` — consumes deltas via
  `changeKind` (line 106 passes it through). Grep `changeKind` in
  `packages/conflict-engine/src/*.ts` (excluding tests) and verify how rule
  classification treats unknown kinds — `renamed` must trigger at least the
  same severity path as `removed` for dependents (a rename IS a removal from
  the dependent's perspective until they update imports). If the engine
  switches exhaustively on kinds and would silently drop `renamed`, the
  engine mapping is in scope (one mapping entry, not a new rule).

- Conventions: detection behavior changes ship on-by-default with an env
  opt-out (`SYNAPSE_BRANCH_AWARE_SEVERITY=0`, `SYNAPSE_FILE_WATCHER=0`
  precedents). Use `SYNAPSE_RENAME_TRACKING=0`. The differ is a pure
  function with no env access — thread the toggle as an options parameter
  defaulted on, read the env in the daemon (`apps/cli/src/daemon.ts:902–907`).
- Test conventions: `node --test`, colocated `*.test.ts` —
  `packages/analyzer-ts/src/index.test.ts` already exists (9 tests); extend it.
- Verify-script conventions: hermetic `scripts/verify-*.mjs` +
  root `package.json` alias; `scripts/verify-dependency-ts-check.mjs` and
  `scripts/verify-tsx-check.mjs` are the closest exemplars (they drive two
  daemons over fixture worktrees and assert on emitted deltas/conflicts).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Analyzer unit tests | `npm test --workspace @synapse/analyzer-ts` | all pass |
| All unit tests | `npm test` | all pass |
| New verify | `npm run verify:rename-tracking` | PASS lines, exit 0 |
| Regression verifies | `node scripts/ci-verify-all.mjs --only dependency-ts-check,tsx-check` | exit 0 |

## Scope

**In scope**:
- `packages/analyzer-ts/src/index.ts` — rename pairing inside `diffTypeScriptContracts`
- `packages/analyzer-ts/src/index.test.ts` — unit tests
- `apps/cli/src/daemon.ts` — thread `SYNAPSE_RENAME_TRACKING`, dependents-from-old-id, summary text
- `packages/conflict-engine/src/compare.ts` — ONLY if `renamed` would otherwise be dropped (see Current state)
- `scripts/verify-rename-tracking.mjs` (create) + root `package.json` alias
- `README.md` — one line in the features/analyzers row or the severity table

**Out of scope** (do NOT touch):
- `packages/analyzer-py`, `packages/analyzer-go` — explicitly later slices.
- `"moved"` (cross-file) detection — much weaker precision; explicitly deferred.
- `packages/protocol` — `ChangeKind` already has `renamed`; no wire change.
- Resolution/LLM paths (`resolution.ts`, OpenRouter) — renames flow through
  existing rules only.

## Git workflow

- Branch: `advisor/012-rename-tracking`
- Conventional commits, e.g. `feat(analyzer-ts): detect unambiguous same-file renames (F5 slice)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pairing pass in `diffTypeScriptContracts`

Add an options parameter: `diffTypeScriptContracts(before, after, options?: { detectRenames?: boolean })`,
default `detectRenames: true` (callers that pass nothing get the new
behavior; the daemon will pass the env-derived value).

Algorithm — run AFTER the existing loops compute the would-be
`removed`/`added` sets but BEFORE pushing them into `changes`
(restructure minimally; keep the existing matched-id branches untouched):

1. Build `shapeKey(symbol)`: `JSON.stringify([symbol.kind, params.map(p => [p.name, p.type, p.optional]), returns, typeParams])`
   from the structured `signature` fields — never from `signature.raw` or
   `sigHash` (both embed the name). Symbols whose signature lacks structure
   (e.g. kinds without params/returns) get key `null` → never paired.
2. Group removed and added candidates by `(filePath, shapeKey)` — same-file
   only; `filePath` is available on the symbol id/span.
3. Pair ONLY when a group has exactly one removed and exactly one added
   (the unambiguity rule). Emit for each pair:
   `{ symbolId: added.id, changeKind: "renamed", before: removedSymbol, after: addedSymbol }`.
4. Everything unpaired keeps its `removed`/`added` change as today.
5. Sort stays as-is (the final `.sort` line).

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Unit tests (write these to lock the heuristic)

Extend `packages/analyzer-ts/src/index.test.ts`, following its existing
extract-then-diff test style:

1. rename a function, identical params/return → one `renamed`, zero
   `removed`/`added`; `before.name` old, `after.name` new.
2. rename + signature change in the same edit → stays `removed` + `added`
   (shape differs; correct and honest).
3. ambiguity: two same-shape functions removed, two added → four changes,
   no `renamed` (unambiguity rule).
4. cross-file: symbol deleted in a.ts, identical shape added in b.ts → no
   pairing (same-file rule).
5. `detectRenames: false` → old behavior (`removed` + `added`).
6. zero-arg `(): void` rename still pairs when unambiguous — document in
   the test name that trivial shapes are allowed *because* of the
   one-to-one rule.

**Verify**: `npm test --workspace @synapse/analyzer-ts` → all pass (9 old + 6 new).

### Step 3: Daemon threading

In `apps/cli/src/daemon.ts:902–907`, pass
`{ detectRenames: process.env.SYNAPSE_RENAME_TRACKING !== "0" }` to
`diffTypeScriptContracts` (py/go differs keep their signatures). Then:

1. In the change→delta mapping (lines ~907–940), make a `renamed` delta's
   `dependents` come from the **old** symbol id's graph entry (dependents
   reference the old name). Read how `dependents` is resolved for `removed`
   and mirror it with `change.before.id`.
2. `summarizeSymbolChange` (line 979) — confirm the existing
   `case "renamed"` text mentions both names; if it only has the raw id,
   improve it to `"<old> renamed to <new>"` using `before`/`after` (check
   the function's inputs; extend them only if it already receives the
   symbols — otherwise leave the text as-is and note it in the report).
3. Add metric label coverage: `synapse_deltas_emitted_total{changeKind="renamed"}`
   works automatically (lines 244/442 use `delta.changeKind`) — nothing to do,
   just confirm.

**Verify**: `npm run build && npm test` → exit 0.

### Step 4: Conflict-engine handling (conditional)

Per "Current state", grep `changeKind` usage in
`packages/conflict-engine/src/compare.ts`. If `renamed` deltas already flow
through the same rules as any other delta (kind-agnostic matching on
symbolId), do nothing and record that in your report. If a kind switch would
drop them, add `renamed` to the branch that handles `removed` (a dependent's
import breaks either way) — smallest possible diff, plus one unit test in
`packages/conflict-engine/src/compare.test.ts` modeled on its existing cases.

**Verify**: `npm test --workspace @synapse/conflict-engine` → all pass.

### Step 5: `scripts/verify-rename-tracking.mjs`

Model on `scripts/verify-dependency-ts-check.mjs` (two daemons, fixture
worktrees, real server). Scenario:

1. Worktree with `export function area(w: number, h: number): number` and a
   second file importing and calling `area`.
2. Alice's daemon reports the baseline, then the file is rewritten with
   `area` renamed to `computeArea` (same params/return) and re-reported.
3. Assert: the emitted delta has `changeKind === "renamed"`; bob's
   `synapse_check` against the importing file surfaces a conflict naming
   the symbol (dependents flowed from the old id).
4. Opt-out leg: repeat with `SYNAPSE_RENAME_TRACKING=0` in the daemon env →
   the same edit emits `removed` + `added`.

Add `"verify:rename-tracking": "npm run build && node scripts/verify-rename-tracking.mjs"`
to root `package.json` next to `verify:tsx-check`.

**Verify**: `npm run verify:rename-tracking` → exit 0;
`node scripts/ci-verify-all.mjs --only dependency-ts-check,tsx-check` → exit 0.

### Step 6: README line

Add a sentence to the Polyglot analyzers feature row (README.md features
table): unambiguous same-file renames are tracked as `renamed` deltas (TS
first; `SYNAPSE_RENAME_TRACKING=0` opts out).

**Verify**: `grep -n 'RENAME_TRACKING' README.md` → 1 match.

## Test plan

Covered by Steps 2/4/5: six analyzer unit tests (pairing, ambiguity,
cross-file, opt-out), conditional conflict-engine test, and the end-to-end
verify with an opt-out leg. Full gate: `npm test` and
`npm run verify:rename-tracking` both exit 0, plus the two regression
verifies (`dependency-ts-check`, `tsx-check`) stay green.

## Done criteria

- [ ] `npm run build`, `npm run typecheck`, `npm test` exit 0
- [ ] 6 new analyzer tests exist and pass
- [ ] `npm run verify:rename-tracking` exits 0 (including the opt-out leg)
- [ ] `node scripts/ci-verify-all.mjs --only dependency-ts-check,tsx-check` exits 0
- [ ] `grep -rn '"renamed"' packages/analyzer-ts/src/index.ts` → at least one emit site
- [ ] No files outside the in-scope list modified (`git status --porcelain`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `diffTypeScriptContracts` at `packages/analyzer-ts/src/index.ts:145` no
  longer matches the excerpt (drift — e.g. someone restructured the differ).
- The change→delta mapping in `daemon.ts` computes `dependents` in a way
  that cannot be keyed by the old symbol id without touching the dependency
  graph builder in `apps/cli/src/analysis.ts` — analysis.ts is not in scope;
  report the coupling instead.
- The conflict engine requires a *new rule* (not a one-branch mapping) to
  surface rename conflicts — new rules need their own design; report.
- Step 5's verify can't reuse the existing fixture harness pattern and
  starts requiring server changes.

## Maintenance notes

- The unambiguity rule (exactly 1↔1 per file+shape) is the precision
  guarantee; reviewers should reject any loosening (similarity scoring,
  cross-file pairing) without a measured false-positive budget — that's the
  F5 phase-2 conversation, informed by `conflictFeedback` dismiss rates on
  `renamed` conflicts once this is live.
- Python/Go parity: the same pairing belongs in their sidecars' diff
  functions (`diffPythonContracts`, `diffGoContracts`); shapes differ per
  language (Go: receiver+params+results). Write those plans only after this
  spike's heuristic survives real usage.
- If `eval:conflicts` fixtures (`evals/conflict-scenarios.json`) include
  remove/add sequences that are actually renames, their expected verdicts
  may shift — check `npm run eval:conflicts` and report any diff rather
  than editing expectations silently.

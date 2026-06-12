# Plan 015: Build a detection-quality benchmark (per-rule precision/recall with a ratchet)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c46a61..HEAD -- scripts/eval-conflicts.mjs evals packages/conflict-engine/src packages/analyzer-ts/src`
> If any of these changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (If plan 012 landed, the analyzer
> emits `renamed` changes — that is expected drift; add rename scenarios in
> Step 2 rather than stopping.)

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW (new eval assets + a new script; production code untouched)
- **Depends on**: none (plan 012 landing first is a bonus, not a requirement)
- **Category**: direction (quality measurement for the core differentiator)
- **Planned at**: commit `8c46a61`, 2026-06-11

## Why this matters

Synapse's product claim is detection *judgment* — warning when it matters,
staying silent when it doesn't. That judgment now has many moving parts
(seven rules, adaptive severity, branch awareness, three language analyzers,
renames arriving via plan 012), but its only quality gate is
`evals/conflict-scenarios.json`: **seven** hand-written scenarios that feed
synthetic state directly into the conflict engine. Nothing measures
false-positive/false-negative behavior, nothing exercises the
analyzer→diff→engine pipeline end-to-end on real source text, and a change
that shifts verdicts subtly can pass every verify. This plan grows the
corpus (~25 scenarios including true negatives), adds analyzer-level
fixtures (real before/after source run through extraction + diff), computes
per-rule precision/recall, and gates CI with a committed baseline that can
only ratchet up.

## Current state

- `evals/conflict-scenarios.json` — array of 7 scenarios:
  `no_overlap_stays_silent`, `same_symbol_breaking_warns`,
  `same_symbol_compatible_is_info`, `direct_dependency_change_warns`,
  `same_symbol_divergent_warns_and_blocks_resolution`,
  `recent_push_marks_stale_base`, `same_file_without_symbol_overlap_is_info`.
  Scenario shape (abridged): `{ name, description, selfSessionId, sessions,
  targets: [{filePath, symbol}], dependencies: {symbolRaw: [{symbol, hops}]},
  deltas: [...], recentPushes: [...], expected: { verdict, rules,
  conflicts: [{rule, severity, compatibility?, recommendation?, resolution?}] } }`.

- `scripts/eval-conflicts.mjs` (~180 lines) — loads the corpus, builds
  `TeamState` via local `stateFor`/`sessionFor`/`deltaFor`/`graphFor`
  helpers, calls:

  ```js
  import { evaluateConflicts, verdictFor } from "@synapse/conflict-engine";
  const conflicts = evaluateConflicts({ selfSessionId, targets, state, graph });
  const verdict = verdictFor(conflicts);
  assert.equal(verdict, scenario.expected.verdict, `${scenario.name}: verdict`);
  assert.deepEqual(conflicts.map(c => c.rule), scenario.expected.rules, ...);
  ```

  Every mismatch is a hard `assert` — it is a regression gate, not a
  measurement. Keep that behavior for the existing 7 (they are exact
  contracts); the new measurement layer is a separate script.

- `packages/analyzer-ts/src/index.ts` — `extractTypeScriptContracts` and
  `diffTypeScriptContracts(before, after)` (line 145) are pure and
  importable from a script; `packages/analyzer-ts/src/index.test.ts` shows
  the extract-then-diff call pattern to copy for fixture scenarios.

- `scripts/ci-verify-all.mjs` — the CI aggregate runner. Check how
  `eval:conflicts` is included (grep `eval` in that file): mirror whatever
  mechanism it uses for the new script (it discovers `scripts/verify-*.mjs`
  automatically; eval scripts may be listed explicitly — match what you
  find).

- Root `package.json` — alias style: `"eval:conflicts": "npm run build && node scripts/eval-conflicts.mjs"`.

- Severity passes live in `packages/conflict-engine/src/adaptive.ts` and
  `branch-aware.ts` — `evaluateConflicts` may or may not apply them
  internally; check `packages/conflict-engine/src/index.ts` exports before
  deciding what the benchmark exercises, and document in the report what is
  and is not covered.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Build | `npm run build` | exit 0 |
| Existing eval (must stay green) | `npm run eval:conflicts` | exit 0, `passed: 7` |
| New benchmark | `npm run eval:detection` | report printed, exit 0 |
| Unit tests | `npm test` | all pass |

## Scope

**In scope**:
- `evals/detection-corpus/` (create) — scenario JSON + source fixture files
- `evals/detection-baseline.json` (create) — committed per-rule metrics
- `scripts/eval-detection.mjs` (create)
- `scripts/ci-verify-all.mjs` — wire the new eval in, mirroring `eval:conflicts`
- Root `package.json` — `"eval:detection"` alias
- `evals/conflict-scenarios.json` — additive new scenarios ONLY (existing 7 untouched)
- `README.md` — short "Detection quality" subsection with the metrics table

**Out of scope** (do NOT touch):
- `packages/conflict-engine/src/**`, `packages/analyzer-*/src/**`,
  `apps/**` — this plan MEASURES; if measurement reveals a judgment bug,
  report it as a finding, do not fix it here.
- `scripts/eval-conflicts.mjs` — the strict gate stays as-is.
- Python/Go sidecar fixtures — TS-only in this slice (the sidecars need
  their runtimes; keep the benchmark hermetic). Note this as future work.

## Git workflow

- Branch: `advisor/015-detection-benchmark`
- Conventional commits, e.g. `test(evals): detection-quality benchmark with per-rule precision/recall ratchet`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Corpus schema + harness skeleton

The seven rule names (confirm with
`grep -rno '"[a-z_]*"' packages/conflict-engine/src/compare.ts | sort -u`
filtered to rule-looking strings, and read each rule's preconditions in
`compare.ts` BEFORE authoring scenarios — writing a positive requires
knowing what state triggers it): `contract_divergent`, `dependency_changed`,
`same_file_no_overlap`, `same_symbol_active`, `same_symbol_unpushed`,
`stale_base`, `transitive_dependency`.

`scripts/eval-detection.mjs` supports two scenario types from
`evals/detection-corpus/*.json`. Each corpus file is a JSON array of
objects with this exact schema:

```jsonc
{
  "name": "snake_case_unique",
  "description": "what real-world situation this encodes",
  "type": "state",            // or "source"
  "skip": null,               // or a string reason — harness counts skips, never fails them
  // type "state": same state-building fields as evals/conflict-scenarios.json
  // (selfSessionId, sessions, targets, dependencies, deltas, recentPushes)
  // — copy stateFor/sessionFor/deltaFor/graphFor from eval-conflicts.mjs verbatim.
  // type "source":
  "files": { "src/a.ts": { "before": "<source text>", "after": "<source text>" } },
  "checkTarget": { "filePath": "src/b.ts", "symbol": "ts:src/b.ts#fn" },
  "dependencies": { "ts:src/b.ts#fn": [ { "symbol": "ts:src/a.ts#g", "hops": 1 } ] },
  // expected — BOTH types use exactly this; nothing else:
  "expected": { "rules": ["dependency_changed"] }   // [] = true negative
}
```

For `"type": "source"` the harness runs `extractTypeScriptContracts` on
each file's before/after, `diffTypeScriptContracts` on the results, and
builds minimal deltas in the exact shape `deltaFor` in `eval-conflicts.mjs`
produces (sessionId `"alice"`, `dependents: []`, signatures from the
diffed symbols), with the scenario's `dependencies` map as the graph — do
not import daemon code.

Scoring — exact semantics, implement precisely this:

- Per scenario: `flagged` = set of rule names on `evaluateConflicts(...)`
  output; `expected` = the scenario's `expected.rules` as a set.
- Per rule R over the whole corpus: TP += 1 if R in both; FP += 1 if R in
  flagged only; FN += 1 if R in expected only. A true-negative scenario
  (`"rules": []`) contributes nothing unless something IS flagged — then
  each flagged rule takes one FP.
- precision(R) = TP/(TP+FP) — **defined as 1.0 when TP+FP = 0**;
  recall(R) = TP/(TP+FN) — **defined as 1.0 when TP+FN = 0**.
- Output: a table row per rule (rule, TP, FP, FN, precision, recall) plus
  micro-averaged totals (sum counts first, then compute).

**Verify**: with 2 seed scenarios (one positive, one negative),
`node scripts/eval-detection.mjs` prints the table, exit 0.

### Step 2: Grow the corpus to ≥ 25 scenarios

Author them in `evals/detection-corpus/`, one file per theme for
reviewability (`same-symbol.json`, `dependency.json`, `negatives.json`,
`source-ts.json`, …). Required coverage:

- **True negatives** (the underrepresented class — at least 8): different
  symbols same file; same symbol, identical contract (no-op edit); dependency
  changed but compatibly (widened param, added optional param); teammate's
  delta already pushed and pulled; expired/ended sessions.
- **Positives across all seven rules** (the list is in Step 1). First diff
  the rule set against what `conflict-scenarios.json` already exercises
  (`grep -o '"rules": \[[^]]*\]' evals/conflict-scenarios.json`) —
  `transitive_dependency` at minimum has no existing positive; author
  positives for every uncovered rule, reading each rule's trigger
  conditions in `packages/conflict-engine/src/compare.ts` first.
- **Source-type scenarios** (at least 6): re-exported symbol changed; type
  alias change rippling to a function signature; default-export component
  prop change (M11 territory); `.mjs` helper in the graph; namespace import
  edge (plan 003 territory); if `renamed` exists in the analyzer by the time
  you run (see drift note), one rename scenario — otherwise add it as
  `"skip": "until-rename-tracking"` and have the harness report skips.
- Every scenario: `description` saying what real-world situation it encodes.

**Verify**: `node scripts/eval-detection.mjs` → table covers all 7 rules,
total scenarios ≥ 25, exit 0.

### Step 3: Baseline ratchet

Write `evals/detection-baseline.json` in exactly this shape (generated via
a `--write-baseline` flag, then committed):

```json
{
  "generatedAt": "<ISO timestamp>",
  "corpusSize": 25,
  "rules": {
    "dependency_changed": { "tp": 4, "fp": 0, "fn": 0, "precision": 1, "recall": 1 }
  }
}
```

On normal runs the script exits non-zero if any rule's precision or recall
drops below its baseline value (tolerance 0; metrics only move via
deliberate `--write-baseline` commits). Comparison rules: a rule present in
the run but **absent from the baseline** → exit non-zero with the message
"new rule <R>: run --write-baseline deliberately"; a rule in the baseline
but absent from the run (corpus shrank) → same treatment. Print a clear
per-rule diff on any failure.

If Step 2's corpus reveals the engine scoring below 1.0 on some rule —
i.e., you found a real false positive/negative — DO NOT tune the corpus to
hide it: baseline the true number, and report the gap prominently in your
final report (that discovery is half this plan's value).

**Verify**: `npm run eval:detection` → exit 0 against the committed
baseline; temporarily editing the baseline upward → exit non-zero with a
readable diff (then restore it).

### Step 4: CI wiring + README

Wire the new eval into `scripts/ci-verify-all.mjs`: the runner
auto-discovers `scripts/verify-*.mjs` and **explicitly pushes
`eval-conflicts.mjs`** (one line, around line 78 — confirm with
`grep -n 'eval-conflicts' scripts/ci-verify-all.mjs`). Add the matching
explicit push for `eval-detection.mjs` next to it. `--only` matches script
names with prefixes stripped, so `--only detection` selects it. Add a
README subsection "Detection quality" with the metrics table (static
snapshot, regenerate command noted) under the verification-scripts section.

**Verify**: `node scripts/ci-verify-all.mjs --only detection` → runs
exactly the detection benchmark, exit 0; `npm run eval:conflicts` → still
exits 0 untouched.

## Test plan

The benchmark is itself a test asset; its own correctness checks:

1. Harness self-test inside `eval-detection.mjs` (run first, cheap): a
   hardcoded scenario pair where flagged==expected and one where it isn't —
   assert the TP/FP/FN math (3 cases: perfect, one FP, one FN).
2. The ratchet check from Step 3 (baseline violation → non-zero exit).
3. `npm run eval:conflicts` unchanged at `passed: 7`.

No `*.test.ts` files — this is script-land, matching how `eval-conflicts`
and the verify scripts are structured (self-asserting `.mjs`).

## Done criteria

- [ ] `evals/detection-corpus/` holds ≥ 25 scenarios incl. ≥ 8 true negatives and ≥ 6 source-type
- [ ] `npm run eval:detection` prints per-rule precision/recall for all 7 rules and exits 0 against the committed baseline
- [ ] Baseline ratchet provably fails on regression (Step 3 check performed)
- [ ] `npm run eval:conflicts` still exits 0 with `passed: 7`
- [ ] CI runner includes the new eval (same mechanism as `eval:conflicts`)
- [ ] Any sub-1.0 baseline metric is called out in the final report with the offending scenario named
- [ ] No files outside the in-scope list modified (`git status --porcelain`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `evaluateConflicts`'s exported signature differs materially from the
  excerpt (engine API drift) — the harness depends on it.
- Building deltas from `SymbolChange`s requires daemon-private logic that
  cannot be reproduced in ~30 lines (e.g. dependent computation needs the
  full project graph machinery) — scope the source-type scenarios down to
  what `indexGraph`/public analyzer APIs support and report the cut.
- You found a judgment bug and feel the urge to fix the engine — out of
  scope; baseline it, name it, stop.

## Maintenance notes

- The corpus is the long-term asset: every future false positive reported
  by real users (the `conflictFeedback` dismissals are a mining source)
  should become a scenario before it's fixed — fix-then-ratchet.
- Python/Go source-type scenarios are the natural next slice once the
  benchmark proves useful; the harness's `type: "source"` schema should
  gain a `lang` field then (design for it now: default `"ts"`).
- Plans 012 (renames) and any severity-pass change should update the
  baseline deliberately in their own PRs — reviewers should treat an
  unexplained `detection-baseline.json` diff as a red flag.

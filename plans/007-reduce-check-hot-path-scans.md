# Plan 007: Avoid full source-tree scans on warm pre-edit checks

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a STOP condition occurs, stop and report instead of improvising. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 3a0b685..HEAD -- apps/cli/src/analysis.ts apps/cli/src/daemon.ts apps/cli/src/watcher.ts scripts/verify-hot-path-latency.mjs scripts/verify-large-repo-latency.mjs scripts/verify-repo-latency.mjs scripts/verify-file-watcher.mjs`
> If any in-scope file changed since this plan was written, compare the current-state excerpts below against the live code before proceeding.
>
> Known drift (verified by review on 2026-06-11): PR #52 (daemon input
> hardening) merged after this plan was stamped, so the drift check WILL
> report `apps/cli/src/daemon.ts` — expected, not a STOP. The
> `/tools/synapse_check` handler cited below at daemon.ts:338 is now at
> ~line 353; `apps/cli/src/analysis.ts` is unchanged (`buildDependencyGraph`
> verified still at line 158, fingerprint reads at 166–170,
> `readSourceFileFingerprints` at 417). Re-anchor by symbol names. Also
> note: pending plans 011 and 016 in this folder add daemon endpoints/
> enrichment near the check handler — if they land first, expect further
> daemon.ts shifts; the symbols stay.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plan 001 recommended, not required
- **Category**: performance
- **Planned at**: commit `3a0b685`, 2026-06-11

## Why this matters

`synapse_check` runs before edits, so latency must stay low and predictable. The dependency graph is cached, but the cache check still recursively stats every TypeScript, Python, and Go source file on each call to compute a source-set fingerprint. In large repos, warm no-change checks still pay filesystem traversal cost even when no source file changed.

## Current state

- `apps/cli/src/daemon.ts` calls `buildDependencyGraph` on every check.
- `apps/cli/src/analysis.ts` computes fingerprints by recursively scanning source trees before it decides whether a cached graph can be reused.
- `apps/cli/src/watcher.ts` already observes worktree file changes and can provide an invalidation signal when enabled.

Relevant excerpts:

```ts
// apps/cli/src/daemon.ts:~353 (post-PR-#52; locate via grep 'tools/synapse_check')
if (request.method === "POST" && url.pathname === "/tools/synapse_check") {
  const checkStartedAt = performance.now();
  const body = (await readJson(request)) as Partial<SynapseCheckRequest>;
  const targets = await resolveCheckTargets(config, body, analysisCache);
  const { graph, neighborsOf } = await buildDependencyGraph(config, analysisCache);
}
```

```ts
// apps/cli/src/analysis.ts:158
export async function buildDependencyGraph(config: RuntimeConfig, cache?: AnalysisCache): Promise<DaemonGraph> {
  const [tsFingerprints, pyFingerprints, goFingerprints] = await Promise.all([
    readSourceFileFingerprints(config.worktreeRoot, isTypeScriptLike),
    readSourceFileFingerprints(config.worktreeRoot, isPythonLike),
    readSourceFileFingerprints(config.worktreeRoot, isGoLike)
  ]);
  const graphFingerprint = sourceSetFingerprint([...tsFingerprints, ...pyFingerprints, ...goFingerprints]);
  if (cache?.graph?.fingerprint === graphFingerprint) {
    return cache.graph.value;
  }
  // then it reads all matching files if stale
}
```

```ts
// apps/cli/src/watcher.ts:50
const schedule = (absolutePath: string): void => {
  const relativePath = normalizePath(relative(options.worktreeRoot, absolutePath));
  if (!relativePath || relativePath.startsWith("..") || !options.shouldReport(relativePath)) {
    return;
  }
  // eventually calls options.onChange(relativePath)
};
```

Repo conventions to match:

- The pre-edit deterministic hot path is measured with `verify:hot-path-latency`, `verify:large-repo-latency`, and `verify:repo-latency`.
- The file watcher can be disabled with `SYNAPSE_FILE_WATCHER=0`.
- Correctness beats cache cleverness: stale graph warnings are worse than a slower check.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit 0 |
| File watcher regression | `npm run verify:file-watcher` | exit 0 |
| Hot path latency | `npm run verify:hot-path-latency` | exit 0 |
| Large repo latency | `npm run verify:large-repo-latency` | exit 0 |
| Repo latency | `npm run verify:repo-latency` | exit 0 |
| Dependency correctness | `npm run verify:dependency-ts-check` | exit 0 |

## Scope

**In scope**:

- `apps/cli/src/analysis.ts`
- `apps/cli/src/daemon.ts`
- `apps/cli/src/watcher.ts` only if the watcher API needs an explicit dirty callback.
- Latency and watcher verifier scripts listed above.

**Out of scope**:

- Replacing the analyzers.
- Building a full incremental TypeScript language service.
- Changing conflict rules.
- Optimizing Python or Go sidecar internals.

## Git workflow

- Branch: `advisor/007-warm-check-cache`
- Suggested commit: `perf(daemon): reuse warm dependency graph until source changes`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add an explicit graph-dirty state to the analysis cache

In `apps/cli/src/analysis.ts`, extend `AnalysisCache` with a graph invalidation flag, for example:

```ts
export interface AnalysisCache {
  symbolsByFile: Map<string, CachedSymbols>;
  graph: CachedGraph | null;
  graphDirty: boolean;
}
```

Initialize it in `apps/cli/src/daemon.ts` as dirty so the first check still builds a fresh graph.

If adding a helper such as `markGraphDirty(cache)` makes call sites clearer, add it in `analysis.ts`.

**Verify**: `npm run typecheck` -> exit 0 after call sites are updated.

### Step 2: Return cached graph immediately when it is known clean

In `buildDependencyGraph`, before reading source fingerprints:

- If `cache?.graph` exists and `cache.graphDirty === false`, return `cache.graph.value` immediately.
- If no clean cache exists, keep the current fingerprint/read/build path.
- After a successful graph build, set `cache.graphDirty = false`.

Preserve the old fingerprint comparison as the fallback for cases where the cache is dirty or the watcher is disabled.

**Verify**: `npm run verify:dependency-ts-check` -> exit 0.

### Step 3: Mark the graph dirty on local source changes and reports

Ensure every path that can change local source graph state marks the graph dirty:

- The file watcher `onChange` path in `apps/cli/src/daemon.ts`.
- The `/tools/synapse_report` path after a report for an analyzable file.
- Any helper from Plan 001 that seeds snapshots should not clear dirty state.

When `SYNAPSE_FILE_WATCHER=0`, do not trust the cache indefinitely. Either leave `graphDirty` true after each build in watcher-disabled mode or preserve the existing fingerprint check on every call.

**Verify**: `npm run verify:file-watcher` -> exit 0.

### Step 4: Add a focused performance regression signal

Extend one latency verifier, preferably `scripts/verify-large-repo-latency.mjs`, to distinguish:

- Cold first check builds/validates the graph.
- Warm second check with no source changes reuses the clean graph.
- Check after a source change rebuilds or invalidates correctly.

Do not assert an exact filesystem-call count unless you add explicit metrics. Prefer elapsed-time budgets already used by the repo, or add a daemon metric such as `synapse_graph_cache_hits_total` and assert it increments on the warm check.

**Verify**: `npm run verify:large-repo-latency` -> exit 0.

### Step 5: Run the latency suite

Run all latency verifiers to make sure the change helps warm checks without regressing cold checks.

**Verify**:

- `npm run verify:hot-path-latency` -> exit 0.
- `npm run verify:large-repo-latency` -> exit 0.
- `npm run verify:repo-latency` -> exit 0.

## Test plan

- Existing dependency correctness verifier proves graph results still drive conflicts.
- File watcher verifier proves source changes still flow into reports.
- Latency verifiers prove hot path budgets remain within thresholds and warm cache is exercised.

## Done criteria

- [ ] Warm checks with a clean graph return cached graph without recursively fingerprinting the whole source tree.
- [ ] Source changes invalidate the graph before later checks.
- [ ] Watcher-disabled mode remains correct, even if less optimized.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run verify:file-watcher` exits 0.
- [ ] `npm run verify:dependency-ts-check` exits 0.
- [ ] `npm run verify:hot-path-latency` exits 0.
- [ ] `npm run verify:large-repo-latency` exits 0.
- [ ] `npm run verify:repo-latency` exits 0.
- [ ] `plans/README.md` status row for Plan 007 is updated.

## STOP conditions

Stop and report if:

- You cannot identify all source-change paths that must mark the graph dirty.
- The fix makes watcher-disabled mode stale.
- Latency scripts become flaky after two focused attempts.
- The implementation starts caching raw source bodies longer than current analyzer behavior requires.

## Maintenance notes

Any future path that mutates or observes local source files must consider graph invalidation. Reviewers should ask: "after this change, can a warm check use an old graph?" If yes, require a dirty mark or a fallback fingerprint check.


# Plan 025: Add timeouts to analyzer sidecar requests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and stop on any STOP condition. Update this plan's row
> in `plans/README.md` when done unless your reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- packages/analyzer-py/src/index.ts packages/analyzer-py/src/index.test.ts packages/analyzer-go/src/index.ts packages/analyzer-go/src/index.test.ts scripts/verify-fuzz.mjs`

## Status

- **Priority**: P1
- **Effort**: S/M
- **Risk**: LOW
- **Depends on**: 024 recommended
- **Category**: bug / perf
- **Planned at**: commit `e3c46f2`, 2026-06-12

## Why this matters

Python and Go analyzer sidecars keep one pending promise per newline JSON-RPC
request. Those promises are rejected when the process exits or stdin write
fails, but not when a sidecar wedges while staying alive. `synapse_check` and
`synapse_report` await these calls, so a stuck sidecar can stall the local
daemon indefinitely instead of degrading to file-level detection.

## Current state

Relevant files:

- `packages/analyzer-py/src/index.ts` - `PythonSidecar.request()`.
- `packages/analyzer-go/src/index.ts` - `GoSidecar.request()`.
- `packages/analyzer-py/src/index.test.ts` and
  `packages/analyzer-go/src/index.test.ts` - sidecar behavior tests.
- `scripts/verify-fuzz.mjs` - malformed-source sidecar health verifier.

Current Python request path:

```ts
// packages/analyzer-py/src/index.ts:143
async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const child = this.ensureStarted();
  const id = this.nextId++;
  const payload = `${JSON.stringify({ id, method, params })}\n`;

  return new Promise<T>((resolve, reject) => {
    this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    child.stdin.write(payload, (error) => {
      if (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  });
}
```

The Go wrapper mirrors the same pattern at
`packages/analyzer-go/src/index.ts:132`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Python analyzer tests | `npm run build && npm test --workspace @synapse/analyzer-py` | exit 0 |
| Go analyzer tests | `npm run build && npm test --workspace @synapse/analyzer-go` | exit 0 |
| Fuzz verifier | `npm run verify:fuzz` | exit 0 |
| Full check | `npm run check` | exit 0 |

Use Node `20.19.x` or newer Node 20.

## Scope

**In scope**:

- `packages/analyzer-py/src/index.ts`
- `packages/analyzer-py/src/index.test.ts`
- `packages/analyzer-go/src/index.ts`
- `packages/analyzer-go/src/index.test.ts`
- `scripts/verify-fuzz.mjs` only if timeout behavior needs verifier coverage

**Out of scope**:

- Rewriting analyzer protocols.
- Changing contract extraction fallback behavior.
- Changing plan 024's Go setup semantics.

## Git workflow

- Branch: `advisor/025-add-analyzer-sidecar-request-timeouts`
- Commit style: `fix(analyzers): time out stuck sidecar requests`.

## Steps

### Step 1: Add a shared timeout pattern in both sidecars

For each sidecar request:

- create a timer using a default timeout such as 5000ms;
- allow override by env var, for example
  `SYNAPSE_ANALYZER_REQUEST_TIMEOUT_MS`;
- on timeout, remove the pending entry and reject with an error naming the
  language, method, id, and timeout;
- clear the timer on success, error response, stdin write error, process exit,
  and close.

Keep implementation local to each package unless you are already extracting a
tiny duplicate helper. Do not introduce a new workspace package in this plan.

**Verify**: `npm run typecheck --workspace @synapse/analyzer-py && npm run typecheck --workspace @synapse/analyzer-go` -> exit 0.

### Step 2: Restart or close on timeout

After a timeout, the sidecar state may be corrupted. Prefer killing/closing the
child process so the next request starts a fresh sidecar. Preserve existing
`closePythonAnalyzer()` / `closeGoAnalyzer()` behavior.

**Verify**: analyzer package tests still pass after build.

### Step 3: Add regression coverage

Add focused tests around the request timeout if feasible without standing up a
real hung sidecar. Options:

- inject a tiny fake child/process seam in tests;
- set the timeout very low and use a method known not to answer only if the
  sidecar safely handles unknown methods;
- otherwise cover via `scripts/verify-fuzz.mjs` by asserting fuzz calls finish
  under a bounded timeout.

Do not make tests flaky by depending on slow real parsing.

**Verify**: `npm run verify:fuzz` -> exit 0.

## Test plan

- Python analyzer tests pass.
- Go analyzer tests pass.
- Fuzz verifier proves analyzer calls terminate.
- Full repo check passes.

## Done criteria

- [ ] `npm run check` exits 0.
- [ ] `npm run verify:fuzz` exits 0.
- [ ] Both sidecar `request()` methods remove pending entries on timeout.
- [ ] Timeout errors are surfaced as normal analyzer degradation to callers.
- [ ] No files outside scope are modified.

## STOP conditions

Stop and report if:

- Adding timeouts requires changing the sidecar wire protocol.
- Tests become timing-dependent or flaky.
- A timeout cannot close/restart a stuck child without breaking normal calls.

## Maintenance notes

Keep timeout defaults conservative. Reviewers should verify every pending entry
has one clear cleanup path, including success, protocol error, write error,
timeout, exit, and close.

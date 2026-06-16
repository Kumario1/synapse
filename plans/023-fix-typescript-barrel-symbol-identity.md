# Plan 023: Keep TypeScript barrel re-exports tied to defining symbols

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and stop on any STOP condition. Update this plan's row
> in `plans/README.md` when done unless your reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- packages/analyzer-ts/src/index.ts packages/analyzer-ts/src/index.test.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `e3c46f2`, 2026-06-12

## Why this matters

The TypeScript analyzer uses `getExportedDeclarations()` when scanning a file.
That API follows re-exports, so when a barrel exports a symbol from another
file, Synapse can create a symbol id using the barrel path instead of the
defining file path. Importers then depend on `ts:src/index.ts#validate`, while
reports from the defining file emit `ts:src/token.ts#validate`. That mismatch
can make dependency conflict checks miss real upstream contract changes.

## Current state

Relevant files:

- `packages/analyzer-ts/src/index.ts` - symbol extraction and dependency graph.
- `packages/analyzer-ts/src/index.test.ts` - analyzer unit tests.

Current extraction:

```ts
// packages/analyzer-ts/src/index.ts:288
for (const [exportName, declarations] of sourceFile.getExportedDeclarations().entries()) {
  for (const declaration of declarations) {
    for (const symbol of symbolsForDeclaration(sourceFile, filePath, declaration, exportName)) {
      symbols.set(symbol.id.raw, symbol);
    }
  }
}
```

Current symbol id construction:

```ts
// packages/analyzer-ts/src/index.ts:627
id: symbolId(input.filePath, input.name),
span: spanFor(input.filePath, input.sourceFile, input.node),
```

There is already a comment acknowledging owner/source mismatch for spans:

```ts
// packages/analyzer-ts/src/index.ts:691
// `getExportedDeclarations()` follows re-exports, so `node` can live in a
// different file than the one being scanned.
```

Existing test style:

```ts
// packages/analyzer-ts/src/index.test.ts:298
test("aliased re-exports resolve through the export-name map (M11)", () => {
  const graph = extractTypeScriptDependencyGraph({ files: [...] });
});
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck --workspace @synapse/analyzer-ts` | exit 0 |
| Analyzer tests | `npm run build && npm test --workspace @synapse/analyzer-ts` | exit 0 |
| Conflict eval | `npm run eval:conflicts` | exit 0 |
| Detection eval | `npm run eval:detection` | exit 0 |

Use Node `20.19.x` or newer Node 20.

## Scope

**In scope**:

- `packages/analyzer-ts/src/index.ts`
- `packages/analyzer-ts/src/index.test.ts`

**Out of scope**:

- Changing protocol `SymbolId` shape.
- Changing Python/Go analyzers.
- Changing rename tracking semantics from plan 012.

## Git workflow

- Branch: `advisor/023-fix-typescript-barrel-symbol-identity`
- Commit style: `fix(analyzer-ts): preserve defining symbol ids for barrel re-exports`.

## Steps

### Step 1: Add a failing test for external barrel re-exports

In `packages/analyzer-ts/src/index.test.ts`, add a test with at least:

- `src/token.ts` exporting `validate`;
- `src/index.ts` doing `export { validate } from "./token";`;
- `src/caller.ts` importing `{ validate } from "./index"` and calling it.

Expected graph behavior:

- Symbols contain `ts:src/token.ts#validate`, not only
  `ts:src/index.ts#validate`.
- The caller edge points to `ts:src/token.ts#validate`.

**Verify**: `npm run build && npm test --workspace @synapse/analyzer-ts` should
fail before the fix or the new assertions should demonstrate the old bad id.

### Step 2: Use the declaration owner path for followed declarations

Update extraction so symbols created from followed declarations use the
declaration owner's source file path when the declaration lives in another
input file. Preserve the export-name mapping needed for alias/default import
resolution.

Implementation guidance:

- Normalize owner paths the same way input `filePath` values are normalized.
- Do not emit duplicate symbols for both barrel and owner paths unless a
  declaration truly exists in both files.
- Ensure `span.path` matches the symbol id path for followed declarations.

**Verify**: `npm run typecheck --workspace @synapse/analyzer-ts` -> exit 0.

### Step 3: Preserve existing alias/default behavior

Run and inspect the existing alias re-export tests. If they fail, adjust the
export-name map so alias imports still resolve to the defining symbol id.

**Verify**: `npm run build && npm test --workspace @synapse/analyzer-ts` -> exit 0.

### Step 4: Run detection gates

Run conflict and detection evals because symbol identity affects conflict
edges.

**Verify**: `npm run eval:conflicts && npm run eval:detection` -> exit 0.

## Test plan

- New test for external `export { x } from "./x"` barrel.
- Existing aliased re-export test still passes.
- Existing default import/export tests still pass.
- Eval gates remain green.

## Done criteria

- [ ] Analyzer tests pass.
- [ ] `npm run eval:conflicts` exits 0.
- [ ] `npm run eval:detection` exits 0.
- [ ] Barrel import edges point to defining-file symbol ids.
- [ ] No files outside scope are modified.

## STOP conditions

Stop and report if:

- Fixing this requires changing serialized `SymbolId` format.
- Existing snapshots or protocol tests require a migration plan.
- The change breaks rename tracking and cannot be fixed locally.

## Maintenance notes

Reviewers should inspect both symbol ids and dependency edges. A fix that only
changes extracted symbols but leaves import edges pointing at the barrel path
does not solve the bug.

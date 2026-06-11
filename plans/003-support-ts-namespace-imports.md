# Plan 003: Resolve TypeScript namespace-import dependency edges

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a STOP condition occurs, stop and report instead of improvising. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 3a0b685..HEAD -- packages/analyzer-ts/src/index.ts packages/analyzer-ts/src/index.test.ts scripts/verify-dependency-ts-check.mjs scripts/verify-tsx-check.mjs`
> If any in-scope file changed since this plan was written, compare the current-state excerpts below against the live code before proceeding.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug, tests
- **Planned at**: commit `3a0b685`, 2026-06-11

## Why this matters

Synapse's dependency warnings rely on the TypeScript analyzer producing edges from an editing symbol to imported symbols it references. Today named imports, aliases, default imports, and aliased re-exports are covered, but `import * as ns from "./module"` is not. A user can therefore miss `dependency_changed` warnings purely because a file uses namespace import syntax.

## Current state

- `packages/analyzer-ts/src/index.ts` extracts TypeScript contracts and dependency edges.
- `packages/analyzer-ts/src/index.test.ts` covers named imports, default imports, JS/MJS imports, and aliased re-exports.

Relevant excerpts:

```ts
// packages/analyzer-ts/src/index.ts:88
const imports = importedSymbolMap(sourceFile, filePath, fileSymbols, fileExports);

// packages/analyzer-ts/src/index.ts:97
for (const identifier of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
  const imported = imports.get(identifier.getText());
  if (!imported || imported.raw === symbol.id.raw) {
    continue;
  }
  edges.set(key, { from: symbol.id, to: imported, kind: "references" });
}
```

```ts
// packages/analyzer-ts/src/index.ts:244
for (const namedImport of declaration.getNamedImports()) {
  const importedName = namedImport.getName();
  const localName = namedImport.getAliasNode()?.getText() ?? importedName;
  const targetSymbol =
    targetExports.get(importedName) ??
    targetSymbols.find((symbol) => symbol.name === importedName)?.id;
  if (targetSymbol) {
    imports.set(localName, targetSymbol);
  }
}

const defaultImport = declaration.getDefaultImport();
```

Existing test pattern:

```ts
// packages/analyzer-ts/src/index.test.ts:125
test("extracts dependency edges from relative named imports", () => {
  const graph = extractTypeScriptDependencyGraph({ files: [...] });
  assert.deepEqual(graph.edges.map((edge) => [edge.from.raw, edge.to.raw, edge.kind]), [...]);
});
```

Repo conventions to match:

- The analyzer keeps public symbol IDs stable: `ts:<path>#<name>`.
- Tests assert exact edge arrays after analyzer sorting.
- Keep TypeScript extraction in-process with `ts-morph`; do not add a language-server dependency.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Analyzer unit/verify | `npm run verify:analyzer-ts` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Dependency integration | `npm run verify:dependency-ts-check` | exit 0 |
| TSX integration | `npm run verify:tsx-check` | exit 0 |

## Scope

**In scope**:

- `packages/analyzer-ts/src/index.ts`
- `packages/analyzer-ts/src/index.test.ts`
- `scripts/verify-dependency-ts-check.mjs` only if adding an end-to-end namespace-import regression is small and valuable.

**Out of scope**:

- TypeScript contract extraction for new symbol kinds.
- Cross-package alias resolution beyond existing relative-module behavior.
- Python or Go dependency graph changes.

## Git workflow

- Branch: `advisor/003-ts-namespace-imports`
- Suggested commit: `fix(analyzer-ts): resolve namespace import edges`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add a failing namespace-import unit test

In `packages/analyzer-ts/src/index.test.ts`, add a test near the existing import-edge tests:

```ts
test("extracts dependency edges from relative namespace imports", () => {
  const graph = extractTypeScriptDependencyGraph({
    files: [
      {
        filePath: "src/auth/token.ts",
        source: `
          export interface Token { value: string; }
          export function validate(input: string): Token | null {
            return input ? { value: input } : null;
          }
        `
      },
      {
        filePath: "src/auth/login.ts",
        source: `
          import * as token from "./token";
          export function login(input: string): boolean {
            return token.validate(input) !== null;
          }
        `
      }
    ]
  });
  assert.deepEqual(graph.edges.map((edge) => [edge.from.raw, edge.to.raw]), [
    ["ts:src/auth/login.ts#login", "ts:src/auth/token.ts#validate"]
  ]);
});
```

Optionally add a second assertion for a type-position use such as `token.Token` if the implementation naturally supports property accesses in type nodes.

**Verify**: `npm run verify:analyzer-ts` -> fails before the fix because no namespace edge is emitted.

### Step 2: Represent namespace imports separately from direct imports

In `packages/analyzer-ts/src/index.ts`, change the import map representation from a single `Map<string, SymbolId>` to a small object, for example:

```ts
interface ImportedSymbols {
  direct: Map<string, SymbolId>;
  namespaces: Map<string, Map<string, SymbolId>>;
}
```

Update `importedSymbolMap` to:

- Keep current named import behavior in `direct`.
- Keep current default import behavior in `direct`.
- For `declaration.getNamespaceImport()`, map the local namespace name to the target file's exported-name map.

Do not map the namespace alias itself to a symbol; only property accesses through it should become edges.

**Verify**: `npm run typecheck` -> exit 0.

### Step 3: Emit edges for namespace property accesses

In the edge extraction loop, keep the current direct identifier behavior. Add a second pass over `PropertyAccessExpression` descendants of the symbol node:

- Get the left expression text. For `token.validate`, this is `token`.
- Get the property name. For `token.validate`, this is `validate`.
- If the left expression is a known namespace alias, resolve the property name through that namespace's export map.
- Emit the same `references` edge using the same de-duplication key.
- Skip self-edges as current code does.

Prefer `ts-morph` node helpers such as `Node.isPropertyAccessExpression` if available. Do not parse text with regular expressions.

**Verify**: `npm run verify:analyzer-ts` -> exit 0.

### Step 4: Run integration verifiers

Run the existing dependency and TSX verifiers to ensure named/default/JSX paths still work.

**Verify**:

- `npm run verify:dependency-ts-check` -> exit 0.
- `npm run verify:tsx-check` -> exit 0.

## Test plan

- New unit test for namespace import property access.
- Existing named/default/re-export tests must keep passing.
- Existing integration scripts prove conflict detection still consumes analyzer edges correctly.

## Done criteria

- [x] Namespace import test fails before the fix and passes after the fix.
- [x] `npm run verify:analyzer-ts` exits 0.
- [x] `npm run typecheck` exits 0.
- [x] `npm run verify:dependency-ts-check` exits 0.
- [x] `npm run verify:tsx-check` exits 0.
- [x] `plans/README.md` status row for Plan 003 is updated.

## STOP conditions

Stop and report if:

- `ts-morph` cannot reliably identify namespace imports or property access nodes.
- Supporting namespace imports requires changing `SymbolId` format.
- The implementation creates duplicate edges or broad false positives that existing tests expose.
- A verification command fails twice after a focused fix attempt.

## Maintenance notes

Future analyzer work should keep import-style parity as a review checklist item: named, aliased, default, namespace, re-export, JS/MJS, and TSX imports should either all work or have documented limitations.

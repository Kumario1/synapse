import assert from "node:assert/strict";
import test from "node:test";
import {
  extractTypeScriptDependencyGraph,
  diffTypeScriptContracts,
  extractTypeScriptContracts
} from "./index.js";

test("extracts exported TypeScript contracts into shared symbols", () => {
  const symbols = extractTypeScriptContracts({
    filePath: "src/auth/token.ts",
    source: `
      export interface Token {
        value: string;
        expiresAt?: Date;
      }

      export type AuthResult<T> =
        | { ok: true; value: T }
        | { ok: false; error: Error };

      export const TOKEN_ISSUER = "synapse";

      export function validate<T extends Token>(
        input: string,
        strict = false
      ): AuthResult<T> {
        return { ok: false, error: new Error(input) };
      }

      export class TokenValidator {
        public currentIssuer: string;

        validate(input: string): AuthResult<Token> {
          return { ok: false, error: new Error(input) };
        }

        private decode(input: string): Token {
          return { value: input };
        }
      }

      function internalOnly() {}
    `
  }).symbols;

  assert.deepEqual(
    symbols.map((symbol) => [symbol.kind, symbol.id.raw]),
    [
      ["type", "ts:src/auth/token.ts#AuthResult"],
      ["interface", "ts:src/auth/token.ts#Token"],
      ["const", "ts:src/auth/token.ts#TOKEN_ISSUER"],
      ["class", "ts:src/auth/token.ts#TokenValidator"],
      ["field", "ts:src/auth/token.ts#TokenValidator.currentIssuer"],
      ["method", "ts:src/auth/token.ts#TokenValidator.validate"],
      ["function", "ts:src/auth/token.ts#validate"]
    ]
  );

  const validate = symbols.find((symbol) => symbol.name === "validate");
  assert.equal(
    validate?.signature?.raw,
    "function validate<T>(input: string, strict?: boolean): AuthResult<T>"
  );
  assert.equal(validate?.span.path, "src/auth/token.ts");
  assert.ok(!symbols.some((symbol) => symbol.name.includes("decode")));
  assert.ok(!symbols.some((symbol) => symbol.name.includes("internalOnly")));
});

test("does not emit a diff for implementation-only changes", () => {
  const before = extractTypeScriptContracts({
    filePath: "src/auth/token.ts",
    source: `
      export function validate(input: string): boolean {
        return input.length > 0;
      }
    `
  }).symbols;
  const after = extractTypeScriptContracts({
    filePath: "src/auth/token.ts",
    source: `
      export function validate(input: string): boolean {
        return input.trim().length > 0;
      }
    `
  }).symbols;

  assert.deepEqual(diffTypeScriptContracts(before, after), []);
});

test("emits signature changes and added symbols", () => {
  const before = extractTypeScriptContracts({
    filePath: "src/auth/token.ts",
    source: `
      export function validate(input: string): boolean {
        return input.length > 0;
      }
    `
  }).symbols;
  const after = extractTypeScriptContracts({
    filePath: "src/auth/token.ts",
    source: `
      export interface Token {
        value: string;
      }

      export function validate(input: string): Token | null {
        return input ? { value: input } : null;
      }
    `
  }).symbols;

  assert.deepEqual(
    diffTypeScriptContracts(before, after).map((change) => [
      change.changeKind,
      change.symbolId.raw
    ]),
    [
      ["added", "ts:src/auth/token.ts#Token"],
      ["signature_changed", "ts:src/auth/token.ts#validate"]
    ]
  );
});

test("extracts dependency edges from relative named imports", () => {
  const graph = extractTypeScriptDependencyGraph({
    files: [
      {
        filePath: "src/auth/token.ts",
        source: `
          export interface Token {
            value: string;
          }

          export function validate(input: string): Token | null {
            return input ? { value: input } : null;
          }
        `
      },
      {
        filePath: "src/auth/login.ts",
        source: `
          import { validate as validateToken } from "./token";

          export function login(input: string): boolean {
            return validateToken(input) !== null;
          }
        `
      }
    ]
  });

  assert.deepEqual(
    graph.edges.map((edge) => [edge.from.raw, edge.to.raw, edge.kind]),
    [
      [
        "ts:src/auth/login.ts#login",
        "ts:src/auth/token.ts#validate",
        "references"
      ]
    ]
  );
});

test("extracts dependency edges from relative namespace imports", () => {
  const graph = extractTypeScriptDependencyGraph({
    files: [
      {
        filePath: "src/auth/token.ts",
        source: `
          export interface Token {
            value: string;
          }

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

  assert.deepEqual(
    graph.edges.map((edge) => [edge.from.raw, edge.to.raw]),
    [["ts:src/auth/login.ts#login", "ts:src/auth/token.ts#validate"]]
  );
});

test("extracts JSX function and arrow components from .tsx/.jsx (M11)", () => {
  const tsx = extractTypeScriptContracts({
    filePath: "src/ui/Button.tsx",
    source: `
      export function Button(props: { label: string }): JSX.Element {
        return <button>{props.label}</button>;
      }
      export const Card = (props: { title: string }) => <div>{props.title}</div>;
    `
  });
  assert.deepEqual(
    tsx.symbols.map((symbol) => [symbol.id.raw, symbol.kind]),
    [
      ["ts:src/ui/Button.tsx#Button", "function"],
      ["ts:src/ui/Button.tsx#Card", "const"]
    ]
  );

  const jsx = extractTypeScriptContracts({
    filePath: "src/ui/Legacy.jsx",
    source: `
      export function Legacy(props) {
        return <span>{props.value}</span>;
      }
    `
  });
  assert.equal(jsx.symbols[0]?.id.raw, "ts:src/ui/Legacy.jsx#Legacy");
});

test("default-exported arrow functions are tracked contracts (M11)", () => {
  const before = extractTypeScriptContracts({
    filePath: "src/ui/Badge.tsx",
    source: "export default (props: { id: number }) => <span>{props.id}</span>;"
  });
  assert.deepEqual(
    before.symbols.map((symbol) => [symbol.id.raw, symbol.kind]),
    [["ts:src/ui/Badge.tsx#default", "function"]]
  );

  const after = extractTypeScriptContracts({
    filePath: "src/ui/Badge.tsx",
    source: "export default (props: { id: string }) => <span>{props.id}</span>;"
  });
  const changes = diffTypeScriptContracts(before.symbols, after.symbols);
  assert.deepEqual(
    changes.map((change) => [change.symbolId.raw, change.changeKind]),
    [["ts:src/ui/Badge.tsx#default", "signature_changed"]]
  );
});

test("default imports resolve dependency edges to the real symbol (M11)", () => {
  const graph = extractTypeScriptDependencyGraph({
    files: [
      {
        filePath: "src/ui/Panel.tsx",
        source: "export default function Panel(props: { open: boolean }) { return <div/>; }"
      },
      {
        filePath: "src/ui/App.tsx",
        source: `
          import Panel from "./Panel";
          export function App(): JSX.Element {
            return <Panel open={true} />;
          }
        `
      }
    ]
  });
  assert.deepEqual(
    graph.edges.map((edge) => [edge.from.raw, edge.to.raw]),
    [["ts:src/ui/App.tsx#App", "ts:src/ui/Panel.tsx#Panel"]]
  );
});

test("plain .js and .mjs modules extract and link like TypeScript (M11)", () => {
  const mjs = extractTypeScriptContracts({
    filePath: "lib/util.mjs",
    source: "export function add(a, b) { return a + b; }"
  });
  assert.equal(mjs.symbols[0]?.id.raw, "ts:lib/util.mjs#add");

  const graph = extractTypeScriptDependencyGraph({
    files: [
      { filePath: "lib/util.mjs", source: "export function add(a, b) { return a + b; }" },
      {
        filePath: "main.js",
        source: `
          import { add } from "./lib/util.mjs";
          export function run() { return add(1, 2); }
        `
      }
    ]
  });
  assert.deepEqual(
    graph.edges.map((edge) => [edge.from.raw, edge.to.raw]),
    [["ts:main.js#run", "ts:lib/util.mjs#add"]]
  );
});

test("aliased re-exports resolve through the export-name map (M11)", () => {
  const graph = extractTypeScriptDependencyGraph({
    files: [
      {
        filePath: "src/core.ts",
        source: `
          function compute(input: number): number { return input * 2; }
          export { compute as run };
        `
      },
      {
        filePath: "src/caller.ts",
        source: `
          import { run } from "./core";
          export function callIt(): number { return run(21); }
        `
      }
    ]
  });
  assert.deepEqual(
    graph.edges.map((edge) => [edge.from.raw, edge.to.raw]),
    [["ts:src/caller.ts#callIt", "ts:src/core.ts#compute"]]
  );
});

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

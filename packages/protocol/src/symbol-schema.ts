import { z } from "zod";
import type { CodeSymbol, SymbolId } from "./index.js";

/**
 * Runtime validation for the symbol payloads the polyglot analyzer sidecars
 * (Go, Python) return over their JSON-RPC channel. The subprocess `result` is
 * `unknown`; without a parse it was cast straight to `CodeSymbol[]`, so a
 * struct-tag drift, a `null`, or a missing field silently injected malformed
 * symbols into the conflict engine. Parsing at this trust boundary turns a
 * bad-but-JSON reply into a thrown error, which the callers already handle by
 * degrading to file-level detection — the same net that catches spawn/timeouts.
 *
 * Objects are loose: a field a newer sidecar adds passes through untouched.
 */
const symbolId = z.looseObject({ raw: z.string().min(1) });

const signatureParam = z.looseObject({
  name: z.string(),
  type: z.string().nullable(),
  optional: z.boolean()
});

const signature = z.looseObject({
  params: z.array(signatureParam),
  returns: z.string().nullable(),
  generics: z.array(z.string()).optional(),
  raw: z.string()
});

const codeSymbol = z.looseObject({
  id: symbolId,
  kind: z.enum([
    "function",
    "method",
    "class",
    "interface",
    "type",
    "field",
    "enum",
    "const",
    "route",
    "schema"
  ]),
  name: z.string(),
  visibility: z.enum(["exported", "public", "internal"]),
  signature: signature.nullable(),
  sigHash: z.string(),
  span: z.looseObject({
    path: z.string(),
    startLine: z.number(),
    endLine: z.number()
  }),
  lang: z.enum(["ts", "py", "go"])
});

const dependencyEdge = z.looseObject({
  from: symbolId,
  to: symbolId,
  kind: z.literal("references")
});

const extractedContractsSchema = z.looseObject({ symbols: z.array(codeSymbol) });

const extractedDependencyGraphSchema = z.looseObject({
  symbols: z.array(codeSymbol),
  edges: z.array(dependencyEdge)
});

export interface ExtractedContracts {
  symbols: CodeSymbol[];
}

export interface ExtractedDependencyGraph {
  symbols: CodeSymbol[];
  edges: { from: SymbolId; to: SymbolId; kind: "references" }[];
}

/** Validate a sidecar `extractFile` reply; throws (ZodError) on a bad shape. */
export function parseExtractedContracts(raw: unknown): ExtractedContracts {
  return extractedContractsSchema.parse(raw) as ExtractedContracts;
}

/** Validate a sidecar `indexGraph` reply; throws (ZodError) on a bad shape. */
export function parseExtractedDependencyGraph(raw: unknown): ExtractedDependencyGraph {
  return extractedDependencyGraphSchema.parse(raw) as ExtractedDependencyGraph;
}

import { z } from "zod";
// Type-only import: index.ts re-exports this module, so a value import here
// would be a runtime cycle (PROTOCOL_VERSION would still be in its TDZ).
import type { ClientMessage } from "./index.js";

// Must equal PROTOCOL_VERSION in index.ts (kept literal to avoid the cycle);
// protocol-version negotiation (plan M15) will replace this with a range.
const WIRE_VERSION = 1 as const;

/**
 * Runtime validation for every inbound wire message — the single source shared
 * by the server (ingress) and any other consumer, so the zod schemas can never
 * drift from the `ClientMessage` TypeScript union without a compile error in
 * `parseClientMessage`'s return type.
 *
 * Objects are *loose* (extra fields pass through) so an older server tolerates
 * payloads from a newer client; required fields are what the server's state
 * mutations actually read, so a malformed message can no longer poison the
 * persisted `TeamState`.
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

const changeKind = z.enum([
  "added",
  "removed",
  "renamed",
  "moved",
  "signature_changed",
  "visibility_changed"
]);

const agentType = z.enum(["claude-code", "cursor", "cline", "aider", "other"]);

const session = z.looseObject({
  id: z.string().min(1),
  repoId: z.string().min(1),
  memberId: z.string(),
  memberLogin: z.string().optional(),
  agentType,
  filesOpen: z.array(z.string()),
  filesEditing: z.array(z.string()),
  lastTask: z.string().nullable(),
  startedAt: z.string(),
  lastSeen: z.string(),
  status: z.enum(["active", "idle", "ended"])
});

const contractDelta = z.looseObject({
  id: z.string().min(1),
  repoId: z.string().min(1),
  sessionId: z.string().min(1),
  symbolId,
  changeKind,
  before: signature.nullable(),
  after: signature.nullable(),
  summary: z.string(),
  filePath: z.string(),
  baseSha: z.string(),
  dependents: z.array(symbolId),
  createdAt: z.string(),
  pushedAt: z.string().nullable()
});

const contractResolution = z.looseObject({
  reconciled: z.boolean(),
  proposedContract: z.string().nullable(),
  rationale: z.string(),
  recommendation: z.enum(["block", "warn", "info", "proceed"]),
  instruction: z.string(),
  source: z.string(),
  repoId: z.string().min(1),
  symbol: symbolId,
  inputsHash: z.string().min(1),
  createdAt: z.string()
});

const sessionSummary = z.looseObject({
  sessionId: z.string().min(1),
  repoId: z.string().min(1),
  memberLogin: z.string(),
  task: z.string().nullable(),
  summary: z.string(),
  symbols: z.array(symbolId),
  deltaCount: z.number(),
  source: z.string(),
  startedAt: z.string(),
  endedAt: z.string()
});

const conflictFeedback = z.looseObject({
  id: z.string().min(1),
  repoId: z.string().min(1),
  conflictId: z.string().min(1),
  sessionId: z.string(),
  memberId: z.string(),
  outcome: z.enum(["acted", "dismissed"]),
  note: z.string().optional(),
  rule: z.string().optional(),
  targetSymbol: symbolId.optional(),
  createdAt: z.string()
});

const envelope = {
  v: z.literal(WIRE_VERSION),
  id: z.string().min(1),
  ts: z.string()
};

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.looseObject({
    ...envelope,
    type: z.literal("session.start"),
    payload: z.looseObject({ session })
  }),
  z.looseObject({
    ...envelope,
    type: z.literal("session.heartbeat"),
    payload: z.looseObject({ repoId: z.string().min(1), sessionId: z.string().min(1) })
  }),
  z.looseObject({
    ...envelope,
    type: z.literal("session.end"),
    payload: z.looseObject({ repoId: z.string().min(1), sessionId: z.string().min(1) })
  }),
  z.looseObject({
    ...envelope,
    type: z.literal("edit.intent"),
    payload: z.looseObject({
      repoId: z.string().min(1),
      sessionId: z.string().min(1),
      symbolId,
      filePath: z.string()
    })
  }),
  z.looseObject({
    ...envelope,
    type: z.literal("contract.delta"),
    payload: z.looseObject({ delta: contractDelta })
  }),
  z.looseObject({
    ...envelope,
    type: z.literal("push.notify"),
    payload: z.looseObject({
      repoId: z.string().min(1),
      memberId: z.string(),
      sha: z.string(),
      summary: z.string(),
      files: z.array(z.string()),
      symbols: z.array(symbolId).optional()
    })
  }),
  z.looseObject({
    ...envelope,
    type: z.literal("repo.event"),
    payload: z.looseObject({
      repoId: z.string().min(1),
      kind: z.enum(["pull_request", "pull_request_review", "issue_comment"]),
      action: z.string(),
      actor: z.string(),
      title: z.string(),
      number: z.number().optional(),
      url: z.string().optional(),
      summary: z.string()
    })
  }),
  z.looseObject({
    ...envelope,
    type: z.literal("resolution.propose"),
    payload: z.looseObject({ repoId: z.string().min(1), resolution: contractResolution })
  }),
  z.looseObject({
    ...envelope,
    type: z.literal("session.summary"),
    payload: z.looseObject({ repoId: z.string().min(1), summary: sessionSummary })
  }),
  z.looseObject({
    ...envelope,
    type: z.literal("conflict.feedback"),
    payload: z.looseObject({ repoId: z.string().min(1), feedback: conflictFeedback })
  }),
  z.looseObject({
    ...envelope,
    type: z.literal("query.briefing"),
    payload: z.looseObject({ repoId: z.string().min(1), since: z.string().optional() })
  })
]);

export type ParsedClientMessage =
  | { ok: true; message: ClientMessage }
  | { ok: false; error: string };

/** Validate an already-JSON-parsed value as a {@link ClientMessage}. */
export function parseClientMessage(value: unknown): ParsedClientMessage {
  const result = clientMessageSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join(".") || "message";
    return { ok: false, error: `invalid_message: ${path} ${first?.message ?? "is invalid"}` };
  }
  return { ok: true, message: result.data as ClientMessage };
}

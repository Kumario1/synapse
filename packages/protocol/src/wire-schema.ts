import { z } from "zod";
// Type-only import: index.ts re-exports this module, so a value import here
// would be a runtime cycle (PROTOCOL_VERSION would still be in its TDZ).
import type { ClientMessage, ServerMessage } from "./index.js";

// Must cover [MIN_SUPPORTED_PROTOCOL_VERSION, PROTOCOL_VERSION] in index.ts
// (kept literal to avoid the cycle). Version negotiation happens at the WS
// handshake; schemas still accept v1 envelopes so a v2 build can speak to
// legacy peers on the downgraded dialect.
const wireVersion = z.union([z.literal(1), z.literal(2)]);

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

const reservationSeed = z.looseObject({
  radius: z.number().int().nonnegative(),
  symbols: z.array(symbolId)
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
  status: z.enum(["active", "idle", "ended"]),
  branch: z.string().optional()
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
  pushedAt: z.string().nullable(),
  reservation: reservationSeed.optional()
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

const affectedSite = z.looseObject({
  symbolId,
  filePath: z.string()
});

const direction = z.looseObject({
  sessionId: z.string().min(1),
  role: z.enum(["keep", "adapt"]),
  summary: z.string(),
  affectedSites: z.array(affectedSite)
});

const resolutionProposal = z.looseObject({
  id: z.string().min(1),
  repoId: z.string().min(1),
  symbol: symbolId,
  conflictClass: z.enum(["mechanical", "semantic"]),
  before: signature.nullable(),
  after: signature.nullable(),
  status: z.enum(["resolving", "resolved", "voided", "awaiting_owner"]),
  candidates: z.array(z.string()).optional(),
  directions: z.array(direction),
  acceptedBy: z.array(z.string().min(1)),
  voidReason: z.enum(["rejected", "timeout"]).optional(),
  voidedBy: z.string().optional(),
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

const editLock = z.looseObject({
  symbolId,
  filePath: z.string(),
  sessionId: z.string().min(1),
  acquiredAt: z.string(),
  ttlSec: z.number()
});

const reservationRoot = z.looseObject({
  symbolId,
  filePath: z.string(),
  acquiredAt: z.string(),
  ttlSec: z.number(),
  radius: z.number().int().nonnegative(),
  symbols: z.array(symbolId)
});

const reservation = z.looseObject({
  repoId: z.string().min(1),
  sessionId: z.string().min(1),
  radius: z.number().int().nonnegative(),
  symbols: z.array(symbolId),
  roots: z.array(reservationRoot),
  updatedAt: z.string()
});

const recentPush = z.looseObject({
  id: z.string().min(1),
  repoId: z.string().min(1),
  memberId: z.string(),
  summary: z.string(),
  filesAffected: z.array(z.string()),
  symbols: z.array(symbolId).optional(),
  sha: z.string(),
  pushedAt: z.string(),
  branch: z.string().optional()
});

const recentRepoEvent = z.looseObject({
  id: z.string().min(1),
  repoId: z.string().min(1),
  kind: z.enum(["pull_request", "pull_request_review", "issue_comment"]),
  action: z.string(),
  actor: z.string(),
  title: z.string(),
  number: z.number().optional(),
  url: z.string().optional(),
  summary: z.string(),
  createdAt: z.string()
});

const teamState = z.looseObject({
  repoId: z.string().min(1),
  sessions: z.array(session),
  editLocks: z.array(editLock),
  reservations: z.array(reservation),
  unpushedDeltas: z.array(contractDelta),
  recentPushes: z.array(recentPush),
  recentRepoEvents: z.array(recentRepoEvent),
  resolutions: z.array(contractResolution),
  resolutionProposals: z.array(resolutionProposal).default([]),
  sessionSummaries: z.array(sessionSummary),
  conflictFeedback: z.array(conflictFeedback)
});

const envelope = {
  v: wireVersion,
  id: z.string().min(1),
  ts: z.string()
};

const stateOp = z.discriminatedUnion("op", [
  z.looseObject({ op: z.literal("upsertSession"), session }),
  z.looseObject({ op: z.literal("upsertEditLock"), lock: editLock }),
  z.looseObject({
    op: z.literal("deleteEditLock"),
    sessionId: z.string().min(1),
    symbolRaw: z.string().min(1)
  }),
  z.looseObject({
    op: z.literal("deleteEditLocksForSession"),
    sessionId: z.string().min(1)
  }),
  z.looseObject({ op: z.literal("upsertReservation"), reservation }),
  z.looseObject({ op: z.literal("deleteReservation"), sessionId: z.string().min(1) }),
  z.looseObject({ op: z.literal("upsertDelta"), delta: contractDelta }),
  z.looseObject({ op: z.literal("deleteDelta"), deltaId: z.string().min(1) }),
  z.looseObject({
    op: z.literal("appendPush"),
    push: recentPush,
    cap: z.number().int().positive()
  }),
  z.looseObject({
    op: z.literal("appendRepoEvent"),
    event: recentRepoEvent,
    cap: z.number().int().positive()
  }),
  z.looseObject({ op: z.literal("upsertResolution"), resolution: contractResolution }),
  z.looseObject({
    op: z.literal("deleteResolution"),
    symbolRaw: z.string().min(1),
    inputsHash: z.string().min(1)
  }),
  z.looseObject({
    op: z.literal("appendSummary"),
    summary: sessionSummary,
    cap: z.number().int().positive()
  }),
  z.looseObject({
    op: z.literal("appendFeedback"),
    feedback: conflictFeedback,
    cap: z.number().int().positive()
  })
]);

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.looseObject({
    ...envelope,
    type: z.literal("session.start"),
    payload: z.looseObject({ session })
  }),
  z.looseObject({
    ...envelope,
    type: z.literal("session.heartbeat"),
    payload: z.looseObject({
      repoId: z.string().min(1),
      sessionId: z.string().min(1),
      branch: z.string().min(1).optional(),
      task: z.string().min(1).optional()
    })
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
      symbols: z.array(symbolId).optional(),
      branch: z.string().optional()
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
      summary: z.string(),
      // Deliberate cap (the neighbors are uncapped): the distiller already
      // trims to 500 chars; this is belt-and-braces against non-distilled
      // senders pushing raw bodies into memory.
      detail: z.string().max(2000).optional()
    })
  }),
  z.looseObject({
    ...envelope,
    type: z.literal("resolution.propose"),
    payload: z.looseObject({ repoId: z.string().min(1), resolution: contractResolution })
  }),
  z.looseObject({
    ...envelope,
    type: z.literal("resolution.ack"),
    payload: z.looseObject({
      repoId: z.string().min(1),
      sessionId: z.string().min(1),
      proposalId: z.string().min(1),
      accept: z.boolean()
    })
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

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.looseObject({
    ...envelope,
    type: z.literal("state.snapshot"),
    payload: z.looseObject({ teamState, seq: z.number().int().nonnegative().optional() })
  }),
  z.looseObject({
    ...envelope,
    type: z.literal("state.delta"),
    payload: z.looseObject({
      repoId: z.string().min(1),
      seq: z.number().int().nonnegative(),
      ops: z.array(stateOp)
    })
  }),
  z.looseObject({
    ...envelope,
    type: z.literal("ack"),
    payload: z.looseObject({
      forId: z.string().min(1),
      ok: z.boolean(),
      error: z.string().optional(),
      locks: z.array(editLock).optional()
    })
  })
]);

export type ParsedClientMessage =
  | { ok: true; message: ClientMessage }
  | { ok: false; error: string };

export type ParsedServerMessage =
  | { ok: true; message: ServerMessage }
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

/** Validate an already-JSON-parsed value as a {@link ServerMessage}. */
export function parseServerMessage(value: unknown): ParsedServerMessage {
  const result = serverMessageSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join(".") || "message";
    return { ok: false, error: `invalid_message: ${path} ${first?.message ?? "is invalid"}` };
  }
  return { ok: true, message: result.data as ServerMessage };
}

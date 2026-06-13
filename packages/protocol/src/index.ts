import { createHmac } from "node:crypto";

export * from "./command-catalog.js";
export * from "./log.js";
export * from "./metrics.js";
export * from "./wire-schema.js";

export const PROTOCOL_VERSION = 1 as const;
/**
 * Oldest wire protocol this build still speaks. The server accepts any client
 * announcing a version in `[MIN_SUPPORTED_PROTOCOL_VERSION, PROTOCOL_VERSION]`
 * (plan M15); a future wire change bumps `PROTOCOL_VERSION` and keeps this at
 * the oldest version it can still downgrade to.
 */
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1 as const;

export type ProtocolNegotiation =
  | { ok: true; agreed: number }
  | { ok: false; reason: string };

/**
 * Negotiate the wire version at connection time (plan M15). The client
 * announces what it speaks; both sides settle on `min(client, server)` when
 * the ranges overlap, so a newer client gracefully downgrades to an older
 * server's dialect and vice versa. No announcement (an old client) is treated
 * as version 1 — the protocol's only dialect before negotiation existed.
 * Outside the supported range the connection is refused with a reason instead
 * of failing opaquely message-by-message.
 */
export function negotiateProtocolVersion(
  clientVersion: number | undefined,
  range: { min: number; max: number } = {
    min: MIN_SUPPORTED_PROTOCOL_VERSION,
    max: PROTOCOL_VERSION
  }
): ProtocolNegotiation {
  const announced = clientVersion ?? 1;
  if (!Number.isInteger(announced) || announced < 1) {
    return { ok: false, reason: `invalid protocol version "${String(clientVersion)}"` };
  }

  if (announced < range.min) {
    return {
      ok: false,
      reason: `client protocol v${announced} is older than the oldest supported v${range.min} — upgrade the client`
    };
  }

  return { ok: true, agreed: Math.min(announced, range.max) };
}

/**
 * Derive an opaque, project-scoped capability key from a server master secret.
 *
 * `key = base64url( HMAC-SHA256(masterSecret, repoId) )`
 *
 * A key minted for one `repoId` cannot validate against another — the server
 * recomputes the HMAC for the requested repo and constant-time compares. This is
 * the stateless tenancy primitive: the CLI mints (`synapse keygen`) and the
 * server validates with this same function, so the two can never drift. Pure and
 * deterministic.
 */
export function deriveProjectKey(masterSecret: string, repoId: string): string {
  return createHmac("sha256", masterSecret).update(repoId).digest("base64url");
}

export type Severity = "none" | "info" | "warn";

export type AgentType =
  | "claude-code"
  | "cursor"
  | "cline"
  | "aider"
  | "other";

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "field"
  | "enum"
  | "const"
  | "route"
  | "schema";

export interface SymbolId {
  raw: string;
}

export interface SignatureParam {
  name: string;
  type: string | null;
  optional: boolean;
}

export interface Signature {
  params: SignatureParam[];
  returns: string | null;
  generics?: string[];
  raw: string;
}

export interface CodeSymbol {
  id: SymbolId;
  kind: SymbolKind;
  name: string;
  visibility: "exported" | "public" | "internal";
  signature: Signature | null;
  sigHash: string;
  span: {
    path: string;
    startLine: number;
    endLine: number;
  };
  lang: "ts" | "py" | "go";
}

export type ChangeKind =
  | "added"
  | "removed"
  | "renamed"
  | "moved"
  | "signature_changed"
  | "visibility_changed";

export interface ContractDelta {
  id: string;
  repoId: string;
  sessionId: string;
  symbolId: SymbolId;
  changeKind: ChangeKind;
  before: Signature | null;
  after: Signature | null;
  summary: string;
  filePath: string;
  baseSha: string;
  dependents: SymbolId[];
  createdAt: string;
  pushedAt: string | null;
}

export interface SymbolChange {
  symbolId: SymbolId;
  changeKind: ChangeKind;
  before: CodeSymbol | null;
  after: CodeSymbol | null;
}

/**
 * Result of deterministically comparing two signatures of the same symbol.
 *
 * - `identical`: the two signatures match exactly.
 * - `compatible`: the change cannot break existing callers (e.g. an added
 *   optional parameter, a newly added symbol).
 * - `breaking`: existing callers will break (removed/retyped parameter, a new
 *   required parameter, a changed return type, a removed symbol).
 * - `unknown`: a change was reported but no structured signature was available
 *   to classify it, so we cannot prove it is safe.
 */
export type SignatureCompatibility = "identical" | "compatible" | "breaking" | "unknown";

/**
 * The concrete shape of a contract change, carried on a `Conflict` so a UI or
 * agent can see *what* changed (before -> after) and whether it actually breaks
 * the other side, instead of only a prose summary.
 */
export interface ContractChange {
  changeKind: ChangeKind;
  before: Signature | null;
  after: Signature | null;
  compatibility: SignatureCompatibility;
  /** Human-readable, deterministic reasons backing the compatibility verdict. */
  breakingReasons: string[];
}

/** How strongly an agent should react to a conflict. */
export type ConflictRecommendation = "block" | "warn" | "info" | "proceed";

/**
 * A concrete next step, addressed to a specific side of the conflict so each
 * agent knows exactly what *it* should do.
 */
export interface ConflictAction {
  /** `you` = the agent running the check; `counterpart` = the other agent. */
  audience: "you" | "counterpart" | "both";
  step: string;
  /**
   * Optional structured suggestion mapping this step to a Synapse tool the
   * reading agent can call. Validated against the command catalog; Synapse
   * only ever SUGGESTS — it never executes these.
   */
  command?: { tool: string; args?: Record<string, string> };
}

/**
 * An actionable analysis of a conflict — the result of comparing the code diffs
 * from *both* sides and deciding what to do, rather than a bare summary.
 * Produced deterministically by the engine and optionally upgraded by an
 * {@link ConflictAnalysis} provider (e.g. an LLM via OpenRouter).
 */
export interface ConflictAnalysis {
  /** Plain-language analysis of both sides' diffs and how they interact. */
  assessment: string;
  /** The recommended reaction strength. */
  recommendation: ConflictRecommendation;
  /** Ordered, side-addressed steps. */
  actions: ConflictAction[];
  /**
   * A concrete merged-contract resolution both agents adopt, when one applies
   * (the `contract_divergent` and `same_symbol_unpushed` "same code" rules).
   * Always populated deterministically by the engine; optionally upgraded by a
   * `ResolutionProvider`.
   */
  resolution?: ProposedResolution;
  /** What produced this analysis: `"deterministic"` or a model id. */
  source: string;
}

/**
 * A concrete *resolution* of a contract conflict: one merged signature that
 * both agents adopt so their edits converge, rather than the side-addressed
 * advice carried by {@link ConflictAnalysis}. Produced deterministically by the
 * engine and optionally upgraded by a {@link ResolutionProvider} (an LLM) for
 * the narrow `contract_divergent` case where both sides rewrote one symbol.
 */
export interface ProposedResolution {
  /** `true` when one merged contract was synthesized; `false` = escalate. */
  reconciled: boolean;
  /** The signature both sides adopt verbatim. `null` when escalating. */
  proposedContract: string | null;
  /** Why this merge (or escalation) is correct. */
  rationale: string;
  /** `"warn"` once merged; `"block"` when escalated and one side must yield. */
  recommendation: ConflictRecommendation;
  /** Identical for both sides ("write exactly this"). */
  instruction: string;
  /** What produced it: a model id or `"deterministic"`. */
  source: string;
}

/**
 * Server-side canonical record of a {@link ProposedResolution}, stored in
 * {@link TeamState} so both agents read the *same* object. Keyed by the symbol
 * plus a hash of the two contributing diffs; first writer wins.
 */
export interface ContractResolution extends ProposedResolution {
  repoId: string;
  symbol: SymbolId;
  /** Hash of the two contributing side diffs; symmetric across agents. */
  inputsHash: string;
  createdAt: string;
}

export type ContractDeltaSummary = Pick<
  ContractDelta,
  "id" | "symbolId" | "changeKind" | "summary" | "filePath" | "createdAt"
>;

export interface Session {
  id: string;
  repoId: string;
  memberId: string;
  memberLogin?: string;
  agentType: AgentType;
  filesOpen: string[];
  filesEditing: string[];
  lastTask: string | null;
  startedAt: string;
  lastSeen: string;
  status: "active" | "idle" | "ended";
  /**
   * The git branch this session is working on, when known. Optional and
   * additive: old clients never send it, detached HEAD omits it. Captured at
   * session start and refreshed on every heartbeat by new clients, so a
   * mid-session checkout propagates within one heartbeat interval; old
   * clients that omit it keep their last known branch.
   */
  branch?: string;
}

export interface EditLock {
  sessionId: string;
  symbolId: SymbolId;
  filePath: string;
  acquiredAt: string;
  ttlSec: number;
}

export interface RecentPush {
  id: string;
  repoId: string;
  memberId: string;
  summary: string;
  filesAffected: string[];
  symbols?: SymbolId[];
  sha: string;
  pushedAt: string;
  /** The branch the push landed on, when known (e.g. from the webhook `ref`). */
  branch?: string;
}

export type RepoEventKind = "pull_request" | "pull_request_review" | "issue_comment";

export interface RecentRepoEvent {
  id: string;
  repoId: string;
  kind: RepoEventKind;
  action: string;
  actor: string;
  title: string;
  number?: number;
  url?: string;
  summary: string;
  /**
   * Distilled prose excerpt of the underlying body (PR description, review,
   * or comment) — code-stripped and capped at ingestion. Optional and
   * additive; the one-line `summary` stays the scannable UI line.
   */
  detail?: string;
  createdAt: string;
}

/**
 * A distilled, narrative record of what one session changed — produced on
 * session end (Layer II). Deterministic by default (a structured list of the
 * session's contract deltas); optionally upgraded to a 2-3 sentence prose
 * summary by an LLM. Stored durably so teammates can catch up on recent work.
 */
export interface SessionSummary {
  sessionId: string;
  repoId: string;
  memberLogin: string;
  task: string | null;
  /** Human-readable summary of the session's contract changes. */
  summary: string;
  /** The symbols the session changed. */
  symbols: SymbolId[];
  /** Number of contract deltas the session produced. */
  deltaCount: number;
  /** What produced the prose: `"deterministic"` or a model id. */
  source: string;
  startedAt: string;
  endedAt: string;
}

export type ConflictFeedbackOutcome = "acted" | "dismissed";

/**
 * Explicit feedback for a surfaced conflict warning. This is telemetry only:
 * recording it does not change current conflict verdicts or tune thresholds.
 */
export interface ConflictFeedback {
  id: string;
  repoId: string;
  conflictId: string;
  sessionId: string;
  memberId: string;
  outcome: ConflictFeedbackOutcome;
  note?: string;
  rule?: Conflict["rule"];
  targetSymbol?: SymbolId;
  createdAt: string;
}

export interface TeamState {
  repoId: string;
  sessions: Session[];
  editLocks: EditLock[];
  unpushedDeltas: ContractDelta[];
  recentPushes: RecentPush[];
  recentRepoEvents: RecentRepoEvent[];
  /** Canonical, shared contract resolutions, keyed by symbol + inputsHash. */
  resolutions: ContractResolution[];
  /** Narrative summaries of ended sessions (most recent first). */
  sessionSummaries: SessionSummary[];
  /** Explicit warning feedback, most recent first, used later for threshold tuning. */
  conflictFeedback: ConflictFeedback[];
}

export interface Conflict {
  /** Deterministic id for recording feedback about this surfaced conflict. */
  id: string;
  severity: Exclude<Severity, "none">;
  rule:
    | "same_symbol_active"
    | "same_symbol_unpushed"
    | "contract_divergent"
    | "dependency_changed"
    | "transitive_dependency"
    | "stale_base"
    | "same_file_no_overlap";
  targetSymbol: SymbolId;
  counterpart: {
    memberLogin: string;
    sessionId: string;
    agentType: AgentType;
    /** The counterpart's branch, when known (session branch or push branch). */
    branch?: string;
  };
  detail: string;
  suggestion: string;
  /**
   * The concrete contract change behind this conflict, when one is known.
   * For symbol-level conflicts this is the *counterpart's* change. Lets
   * consumers render the actual before -> after instead of prose.
   */
  change?: ContractChange;
  /**
   * For `contract_divergent`: the *checking* side's own competing change to the
   * same symbol (the counterpart's is in `change`). Together they let a resolver
   * synthesize one merged contract and a symmetric inputs hash.
   */
  selfChange?: ContractChange;
  /** The checking agent's session id; pairs with `counterpart.sessionId`. */
  selfSessionId?: string;
  /**
   * A human-readable explanation of why this is (or is not) a real conflict.
   * Always populated deterministically by the engine. Detection never depends
   * on it. Superseded for action by `analysis`, kept for a quick one-liner.
   */
  explanation?: string;
  /**
   * Actionable, both-sides analysis: what each agent should do about this
   * conflict. Always populated deterministically; optionally upgraded by an
   * `AnalysisProvider` that compares the full code diffs from both sides.
   */
  analysis?: ConflictAnalysis;
}

export interface SynapseCheckRequest {
  repoId: string;
  sessionId: string;
  files: string[];
  symbols?: SymbolId[];
  task?: string;
}

export interface SynapseCheckResponse {
  verdict: Severity;
  conflicts: Conflict[];
  degraded?: boolean;
}

export interface SynapseReportRequest {
  repoId: string;
  sessionId: string;
  filePath: string;
  symbolId?: SymbolId;
  changeKind?: ChangeKind;
  summary?: string;
  baseSha?: string;
  dependents?: SymbolId[];
}

export interface SynapseReportResponse {
  ok: true;
  delta?: ContractDeltaSummary;
  deltas?: ContractDeltaSummary[];
}

export interface SynapseSessionRequest {
  repoId: string;
  sessionId: string;
  action: "start" | "end" | "heartbeat";
  task?: string;
}

export interface SynapseSessionResponse {
  sessionId: string;
}

export interface SynapsePushRequest {
  repoId: string;
  sessionId: string;
  sha: string;
  summary: string;
  files: string[];
  symbols?: SymbolId[];
}

export interface SynapsePushResponse {
  ok: true;
  sha: string;
  files: string[];
}

export interface SynapseFeedbackRequest {
  repoId: string;
  sessionId: string;
  conflictId: string;
  outcome: ConflictFeedbackOutcome;
  note?: string;
  rule?: Conflict["rule"];
  targetSymbol?: SymbolId;
}

export interface SynapseFeedbackResponse {
  ok: true;
  feedback: ConflictFeedback;
}

export interface SynapseInsightsRequest {
  repoId: string;
  sessionId: string;
  /** Max rows for ranked sections. Defaults to 5. */
  limit?: number;
}

export interface SynapseInsightsBucket {
  name: string;
  count: number;
}

export interface SynapseInsightsResponse {
  repoId: string;
  generatedAt: string;
  degraded: boolean;
  summary: string[];
  totals: {
    feedback: number;
    acted: number;
    dismissed: number;
    activeSessions: number;
    unpushedDeltas: number;
    activeEditLocks: number;
  };
  topRulesByFeedback: SynapseInsightsBucket[];
  topConflictTargets: SynapseInsightsBucket[];
  recentFeedback: Array<{
    conflictId: string;
    outcome: ConflictFeedbackOutcome;
    rule?: Conflict["rule"];
    targetSymbol?: SymbolId;
    createdAt: string;
  }>;
}

export interface SynapseWhatsupRequest {
  repoId: string;
  sessionId: string;
  /** Max rows per repeated section. Defaults to 10. */
  limit?: number;
}

export interface WhatsupSessionSummary {
  id: string;
  memberLogin: string;
  agentType: AgentType;
  status: Session["status"];
  lastTask: string | null;
  filesEditing: string[];
  lastSeen: string;
}

export interface WhatsupDeltaSummary extends ContractDeltaSummary {
  sessionId: string;
  memberLogin: string;
  before: string | null;
  after: string | null;
  baseSha: string;
}

export interface SynapseWhatsupResponse {
  repoId: string;
  generatedAt: string;
  degraded: boolean;
  summary: string[];
  sessions: WhatsupSessionSummary[];
  unpushedDeltas: WhatsupDeltaSummary[];
  editLocks: EditLock[];
  recentPushes: RecentPush[];
  recentRepoEvents: RecentRepoEvent[];
  resolutions: ContractResolution[];
  sessionSummaries: SessionSummary[];
  conflictFeedback: ConflictFeedback[];
}

export interface SynapseWhyRequest {
  repoId: string;
  sessionId: string;
  question: string;
  /** Max matching sources to return. Defaults to 5. */
  limit?: number;
}

export type SynapseWhySourceKind =
  | "session_summary"
  | "repo_event"
  | "recent_push"
  | "resolution"
  | "conflict_feedback"
  | "unpushed_delta"
  | "session";

export interface SynapseWhySource {
  kind: SynapseWhySourceKind;
  title: string;
  summary: string;
  createdAt: string;
  score: number;
  url?: string;
  reference?: string;
}

export interface SynapseWhyResponse {
  repoId: string;
  generatedAt: string;
  degraded: boolean;
  /** True when hybrid vector recall contributed sources beyond the lexical floor. */
  rag?: boolean;
  question: string;
  answer: string;
  sources: SynapseWhySource[];
}

export interface SynapseOnboardRequest {
  repoId: string;
  sessionId: string;
  /** Per-section cap; same clamp semantics as `SynapseWhyRequest.limit`. */
  limit?: number;
}

/**
 * A first-session deep briefing (plan C4 slice): the full team digest plus
 * the room's cited decision history, vector-recall-enriched when RAG is
 * configured. Unlike the session-start catch-up, it has no "since you were
 * last here" baseline — it always answers.
 */
export interface SynapseOnboardResponse {
  repoId: string;
  generatedAt: string;
  /** True when the daemon↔server socket is not OPEN. */
  degraded: boolean;
  /** True when vector recall contributed decisions beyond the lexical floor. */
  rag?: boolean;
  /** Rendered text an agent injects as context. */
  briefing: string;
  sections: {
    activity: SynapseWhatsupResponse;
    /** Recency-ordered durable memory, numbered-citation contract preserved. */
    decisions: SynapseWhySource[];
  };
}

/** One vector-recall hit from the server's memory index (RAG, plan C1/C2). */
export interface RecallMatch {
  kind: SynapseWhySourceKind;
  title: string;
  summary: string;
  reference?: string;
  createdAt: string;
  /** Cosine similarity in [0, 1]; higher is closer. */
  score: number;
}

export interface RecallRequest {
  repoId: string;
  query: string;
  limit?: number;
}

export interface RecallResponse {
  /** True when no embedding provider / vector store is available. */
  degraded: boolean;
  matches: RecallMatch[];
}

export interface WireEnvelope<TType extends string = string, TPayload = unknown> {
  v: typeof PROTOCOL_VERSION;
  type: TType;
  id: string;
  ts: string;
  payload: TPayload;
}

export type ClientMessage =
  | WireEnvelope<"session.start", { session: Session }>
  | WireEnvelope<"session.heartbeat", { repoId: string; sessionId: string; branch?: string }>
  | WireEnvelope<"session.end", { repoId: string; sessionId: string }>
  | WireEnvelope<
      "edit.intent",
      { repoId: string; sessionId: string; symbolId: SymbolId; filePath: string }
    >
  | WireEnvelope<"contract.delta", { delta: ContractDelta }>
  | WireEnvelope<
      "push.notify",
      {
        repoId: string;
        memberId: string;
        sha: string;
        summary: string;
        files: string[];
        symbols?: SymbolId[];
        branch?: string;
      }
    >
  | WireEnvelope<
      "repo.event",
      {
        repoId: string;
        kind: RepoEventKind;
        action: string;
        actor: string;
        title: string;
        number?: number;
        url?: string;
        summary: string;
        detail?: string;
      }
    >
  | WireEnvelope<
      "resolution.propose",
      { repoId: string; resolution: ContractResolution }
    >
  | WireEnvelope<"session.summary", { repoId: string; summary: SessionSummary }>
  | WireEnvelope<"conflict.feedback", { repoId: string; feedback: ConflictFeedback }>
  | WireEnvelope<"query.briefing", { repoId: string; since?: string }>;

export type ServerMessage =
  | WireEnvelope<"state.snapshot", { teamState: TeamState }>
  | WireEnvelope<"state.delta", { teamState: TeamState }>
  | WireEnvelope<"ack", { forId: string; ok: boolean; error?: string }>;

export function createEmptyTeamState(repoId: string): TeamState {
  return {
    repoId,
    sessions: [],
    editLocks: [],
    unpushedDeltas: [],
    recentPushes: [],
    recentRepoEvents: [],
    resolutions: [],
    sessionSummaries: [],
    conflictFeedback: []
  };
}

export function symbolId(raw: string): SymbolId {
  return { raw };
}

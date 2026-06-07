export const PROTOCOL_VERSION = 1 as const;

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
  lang: "ts" | "py";
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
  /** What produced this analysis: `"deterministic"` or a model id. */
  source: string;
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
}

export interface TeamState {
  repoId: string;
  sessions: Session[];
  editLocks: EditLock[];
  unpushedDeltas: ContractDelta[];
  recentPushes: RecentPush[];
}

export interface Conflict {
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
  };
  detail: string;
  suggestion: string;
  /**
   * The concrete contract change behind this conflict, when one is known.
   * Lets consumers render the actual before -> after instead of prose.
   */
  change?: ContractChange;
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

export interface WireEnvelope<TType extends string = string, TPayload = unknown> {
  v: typeof PROTOCOL_VERSION;
  type: TType;
  id: string;
  ts: string;
  payload: TPayload;
}

export type ClientMessage =
  | WireEnvelope<"session.start", { session: Session }>
  | WireEnvelope<"session.heartbeat", { repoId: string; sessionId: string }>
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
      }
    >
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
    recentPushes: []
  };
}

export function symbolId(raw: string): SymbolId {
  return { raw };
}

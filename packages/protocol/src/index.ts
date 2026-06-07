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

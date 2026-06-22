import type { ContractDelta, Session, SessionSummary, TeamState } from "@synapse/protocol";
import { currentGitBranch, type RuntimeConfig } from "./config.js";
import type { SessionSummaryDelta, SummaryProvider } from "./explain-openrouter.js";

export function makeSession(config: RuntimeConfig, task: string | null = null): Session {
  const now = new Date().toISOString();
  return {
    id: config.sessionId,
    repoId: config.repoId,
    memberId: config.member,
    memberLogin: config.member,
    agentType: config.agentType,
    filesOpen: [],
    filesEditing: [],
    lastTask: task,
    startedAt: now,
    lastSeen: now,
    status: "active",
    branch: currentGitBranch(config.worktreeRoot)
  };
}

/**
 * Distill the ending session's contract changes into a {@link SessionSummary}.
 * Deterministic by default (a structured list of the session's deltas); upgraded
 * to prose by the LLM summarizer when one is configured. Reads the session's own
 * unpushed deltas from the warm cache — never raw code.
 */
export async function buildSessionSummary(
  config: RuntimeConfig,
  state: TeamState,
  provider: SummaryProvider | null,
  task: string | undefined
): Promise<SessionSummary> {
  const now = new Date().toISOString();
  const session = state.sessions.find((candidate) => candidate.id === config.sessionId);
  const resolvedTask = task ?? session?.lastTask ?? null;
  const myDeltas = state.unpushedDeltas.filter(
    (delta) => delta.sessionId === config.sessionId && delta.pushedAt === null
  );
  const symbols = [
    ...new Map(myDeltas.map((delta) => [delta.symbolId.raw, delta.symbolId])).values()
  ];

  let summary = deterministicSessionSummary(config.member, resolvedTask, myDeltas);
  let source = "deterministic";

  if (provider && myDeltas.length > 0) {
    const llm = await provider
      .summarizeSession({
        member: config.member,
        task: resolvedTask,
        deltas: myDeltas.map(summaryDeltaFor)
      })
      .catch(() => null);
    if (llm) {
      summary = llm;
      source = provider.model;
    }
  }

  return {
    sessionId: config.sessionId,
    repoId: config.repoId,
    memberLogin: config.member,
    task: resolvedTask,
    summary,
    symbols,
    deltaCount: myDeltas.length,
    source,
    startedAt: session?.startedAt ?? now,
    endedAt: now
  };
}

export function summaryDeltaFor(delta: ContractDelta): SessionSummaryDelta {
  return {
    symbol: delta.symbolId.raw,
    changeKind: delta.changeKind,
    before: delta.before?.raw ?? null,
    after: delta.after?.raw ?? null,
    summary: delta.summary
  };
}

/** A structured, no-LLM summary of a session's contract changes. */
export function deterministicSessionSummary(
  member: string,
  task: string | null,
  deltas: ContractDelta[]
): string {
  const taskSuffix = task ? ` Task: ${task}.` : "";
  if (deltas.length === 0) {
    return `${member}'s session ended with no contract changes.${taskSuffix}`;
  }

  const fileCount = new Set(deltas.map((delta) => delta.filePath)).size;
  const items = deltas.slice(0, 5).map((delta) => {
    const name = delta.symbolId.raw.split("#").pop() ?? delta.symbolId.raw;
    const shape =
      delta.before?.raw && delta.after?.raw ? `: ${delta.before.raw} -> ${delta.after.raw}` : "";
    return `${name} (${delta.changeKind}${shape})`;
  });
  const more = deltas.length > items.length ? `, +${deltas.length - items.length} more` : "";

  return (
    `${member}'s session changed ${deltas.length} contract${deltas.length === 1 ? "" : "s"} ` +
    `across ${fileCount} file${fileCount === 1 ? "" : "s"}: ${items.join(", ")}${more}.${taskSuffix}`
  );
}

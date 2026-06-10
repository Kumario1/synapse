import type {
  SynapseWhatsupResponse,
  SynapseWhyResponse,
  SynapseWhySource,
  SynapseWhySourceKind,
  TeamState,

} from "@synapse/protocol";

/** Build the catch-up text from a whatsup briefing, excluding the reader's own work. */
export function sessionStartBriefing(briefing: SynapseWhatsupResponse, selfSessionId: string): string | null {
  const sections: string[] = [];

  const pushes = briefing.recentPushes.slice(0, 5);
  if (pushes.length > 0) {
    sections.push(
      `Recent pushes:\n${pushes
        .map((push) => `  • ${push.memberId}: ${push.summary} (${push.filesAffected.length} file(s))`)
        .join("\n")}`
    );
  }

  const repoEvents = briefing.recentRepoEvents.slice(0, 5);
  if (repoEvents.length > 0) {
    sections.push(
      `Recent GitHub activity:\n${repoEvents
        .map((event) => `  • ${event.actor}: ${event.summary}`)
        .join("\n")}`
    );
  }

  const othersDeltas = briefing.unpushedDeltas.filter((delta) => delta.sessionId !== selfSessionId);
  if (othersDeltas.length > 0) {
    sections.push(
      `Teammates' unpushed contract changes:\n${othersDeltas
        .slice(0, 5)
        .map((delta) => `  • ${delta.memberLogin}: ${delta.symbolId.raw} (${delta.changeKind})`)
        .join("\n")}`
    );
  }

  const summaries = briefing.sessionSummaries.filter((summary) => summary.sessionId !== selfSessionId);
  if (summaries.length > 0) {
    sections.push(
      `Recent session summaries:\n${summaries
        .slice(0, 3)
        .map((summary) => `  • ${summary.summary}`)
        .join("\n")}`
    );
  }

  if (sections.length === 0) {
    return null;
  }

  return `📋 Synapse catch-up for ${briefing.repoId}:\n${sections.join("\n\n")}`;
}

export function buildWhatsupResponse(
  state: TeamState,
  options: { degraded: boolean; limit?: number }
): SynapseWhatsupResponse {
  const limit = clampLimit(options.limit);
  const memberBySession = new Map(
    state.sessions.map((session) => [
      session.id,
      session.memberLogin ?? session.memberId ?? session.id
    ])
  );
  const activeSessions = state.sessions
    .filter((session) => session.status !== "ended")
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  const unpushedDeltas = [...state.unpushedDeltas]
    .filter((delta) => delta.pushedAt === null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recentPushes = [...state.recentPushes].sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
  const recentRepoEvents = [...state.recentRepoEvents].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
  const resolutions = [...state.resolutions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const sessionSummaries = [...state.sessionSummaries].sort((a, b) =>
    b.endedAt.localeCompare(a.endedAt)
  );
  const conflictFeedback = [...state.conflictFeedback].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );

  return {
    repoId: state.repoId,
    generatedAt: new Date().toISOString(),
    degraded: options.degraded,
    summary: [
      `${activeSessions.length} active session${activeSessions.length === 1 ? "" : "s"}`,
      `${unpushedDeltas.length} unpushed contract delta${unpushedDeltas.length === 1 ? "" : "s"}`,
      `${state.editLocks.length} active edit lock${state.editLocks.length === 1 ? "" : "s"}`,
      `${recentPushes.length} recent push${recentPushes.length === 1 ? "" : "es"}`,
      `${recentRepoEvents.length} GitHub repo event${recentRepoEvents.length === 1 ? "" : "s"}`,
      `${resolutions.length} shared resolution${resolutions.length === 1 ? "" : "s"}`,
      `${sessionSummaries.length} session summar${sessionSummaries.length === 1 ? "y" : "ies"}`,
      `${conflictFeedback.length} conflict feedback event${conflictFeedback.length === 1 ? "" : "s"}`
    ],
    sessions: activeSessions.slice(0, limit).map((session) => ({
      id: session.id,
      memberLogin: session.memberLogin ?? session.memberId,
      agentType: session.agentType,
      status: session.status,
      lastTask: session.lastTask,
      filesEditing: session.filesEditing,
      lastSeen: session.lastSeen
    })),
    unpushedDeltas: unpushedDeltas.slice(0, limit).map((delta) => ({
      id: delta.id,
      sessionId: delta.sessionId,
      memberLogin: memberBySession.get(delta.sessionId) ?? delta.sessionId,
      symbolId: delta.symbolId,
      changeKind: delta.changeKind,
      summary: delta.summary,
      filePath: delta.filePath,
      before: delta.before?.raw ?? null,
      after: delta.after?.raw ?? null,
      baseSha: delta.baseSha,
      createdAt: delta.createdAt
    })),
    editLocks: state.editLocks.slice(0, limit),
    recentPushes: recentPushes.slice(0, limit),
    recentRepoEvents: recentRepoEvents.slice(0, limit),
    resolutions: resolutions.slice(0, limit),
    sessionSummaries: sessionSummaries.slice(0, limit),
    conflictFeedback: conflictFeedback.slice(0, limit)
  };
}

export function buildWhyResponse(
  state: TeamState,
  question: string,
  options: { degraded: boolean; limit?: number }
): SynapseWhyResponse {
  const limit = clampWhyLimit(options.limit);
  const terms = questionTerms(question);
  const sources = whySources(state)
    .map((source) => ({ ...source, score: scoreWhySource(source, terms) }))
    .filter((source) => source.score > 0)
    .sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);

  const answer =
    sources.length === 0
      ? `No matching Synapse memory found for "${question}". Try a symbol, file, PR title, teammate, or task keyword.`
      : [
          `Found ${sources.length} Synapse memor${sources.length === 1 ? "y" : "ies"} related to "${question}":`,
          ...sources.map((source, index) => `${index + 1}. ${source.title} — ${source.summary}`)
        ].join("\n");

  return {
    repoId: state.repoId,
    generatedAt: new Date().toISOString(),
    degraded: options.degraded,
    question,
    answer,
    sources
  };
}

function whySources(state: TeamState): SynapseWhySource[] {
  const memberBySession = new Map(
    state.sessions.map((session) => [
      session.id,
      session.memberLogin ?? session.memberId ?? session.id
    ])
  );

  return [
    ...state.sessionSummaries.map((summary) => ({
      kind: "session_summary" as SynapseWhySourceKind,
      title: `${summary.memberLogin}'s ended session`,
      summary: summary.summary,
      createdAt: summary.endedAt,
      score: 0,
      reference: summary.sessionId
    })),
    ...state.recentRepoEvents.map((event) => ({
      kind: "repo_event" as SynapseWhySourceKind,
      title: event.title,
      summary: `${event.actor}: ${event.summary}`,
      createdAt: event.createdAt,
      score: 0,
      url: event.url,
      reference: event.number ? `#${event.number}` : event.kind
    })),
    ...state.recentPushes.map((push) => ({
      kind: "recent_push" as SynapseWhySourceKind,
      title: `Push ${push.sha}`,
      summary: `${push.memberId}: ${push.summary} (${push.filesAffected.join(", ")})`,
      createdAt: push.pushedAt,
      score: 0,
      reference: push.sha
    })),
    ...state.resolutions.map((resolution) => ({
      kind: "resolution" as SynapseWhySourceKind,
      title: `Resolution for ${resolution.symbol.raw}`,
      summary: `${resolution.recommendation}: ${resolution.instruction} ${resolution.rationale}`,
      createdAt: resolution.createdAt,
      score: 0,
      reference: resolution.inputsHash
    })),
    ...state.conflictFeedback.map((feedback) => ({
      kind: "conflict_feedback" as SynapseWhySourceKind,
      title: `${memberBySession.get(feedback.sessionId) ?? feedback.memberId} ${feedback.outcome} on ${feedback.conflictId}`,
      summary: [
        feedback.rule ? `rule ${feedback.rule}` : "",
        feedback.targetSymbol?.raw ? `target ${feedback.targetSymbol.raw}` : "",
        feedback.note ?? ""
      ]
        .filter(Boolean)
        .join("; "),
      createdAt: feedback.createdAt,
      score: 0,
      reference: feedback.conflictId
    })),
    ...state.unpushedDeltas
      .filter((delta) => delta.pushedAt === null)
      .map((delta) => ({
        kind: "unpushed_delta" as SynapseWhySourceKind,
        title: `${memberBySession.get(delta.sessionId) ?? delta.sessionId} changed ${delta.symbolId.raw}`,
        summary: [
          delta.summary,
          delta.before?.raw && delta.after?.raw ? `${delta.before.raw} -> ${delta.after.raw}` : "",
          delta.filePath
        ]
          .filter(Boolean)
          .join(" "),
        createdAt: delta.createdAt,
        score: 0,
        reference: delta.symbolId.raw
      })),
    ...state.sessions.map((session) => ({
      kind: "session" as SynapseWhySourceKind,
      title: `${session.memberLogin ?? session.memberId}'s ${session.status} session`,
      summary: [
        session.lastTask ?? "No task recorded",
        session.filesEditing.length ? `editing ${session.filesEditing.join(", ")}` : ""
      ]
        .filter(Boolean)
        .join("; "),
      createdAt: session.lastSeen,
      score: 0,
      reference: session.id
    }))
  ];
}

function scoreWhySource(source: SynapseWhySource, terms: string[]): number {
  if (terms.length === 0) {
    return 1;
  }

  const text = `${source.kind} ${source.title} ${source.summary} ${source.reference ?? ""}`.toLowerCase();
  return terms.reduce((score, term) => score + (text.includes(term) ? term.length : 0), 0);
}

function questionTerms(question: string): string[] {
  const stopwords = new Set([
    "a",
    "an",
    "and",
    "are",
    "did",
    "do",
    "for",
    "how",
    "is",
    "it",
    "of",
    "on",
    "or",
    "the",
    "to",
    "was",
    "what",
    "when",
    "where",
    "who",
    "why"
  ]);

  return [...new Set(question.toLowerCase().match(/[a-z0-9_.#/-]+/gu) ?? [])].filter(
    (term) => term.length > 1 && !stopwords.has(term)
  );
}

function clampWhyLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 5;
  }

  return Math.max(1, Math.min(20, Math.trunc(value)));
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 10;
  }

  return Math.max(1, Math.min(50, Math.trunc(value)));
}


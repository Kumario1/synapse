import { editLockIsActive } from "@synapse/conflict-engine";
import type {
  RecallMatch,
  SynapseOnboardResponse,
  SynapsePrBriefResponse,
  SynapseWhatsupResponse,
  SynapseWhyResponse,
  SynapseWhySource,
  SynapseWhySourceKind,
  Reservation,
  ReservationRoot,
  TeamState
} from "@synapse/protocol";

/** Build the catch-up text from a whatsup briefing, excluding the reader's own work. */
export function sessionStartBriefing(
  briefing: SynapseWhatsupResponse,
  selfSessionId: string
): string | null {
  const sections: string[] = [];

  const pushes = briefing.recentPushes.slice(0, 5);
  if (pushes.length > 0) {
    sections.push(
      `Recent pushes:\n${pushes
        .map(
          (push) => `  • ${push.memberId}: ${push.summary} (${push.filesAffected.length} file(s))`
        )
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

  const sessionLabelById = new Map(
    briefing.sessions.map((session) => [session.id, session.memberLogin ?? session.id])
  );
  const reservationLines = briefing.reservations.flatMap((reservation) => {
    if (reservation.sessionId === selfSessionId) {
      return [];
    }
    const label = sessionLabelById.get(reservation.sessionId) ?? reservation.sessionId;
    return [
      `  • ${label}: ${reservation.symbols.length} symbol${reservation.symbols.length === 1 ? "" : "s"}, radius ${reservation.radius} - ${reservationSymbolList(reservation)}`
    ];
  });
  if (reservationLines.length > 0) {
    sections.push(`Teammates' live reservations:\n${reservationLines.join("\n")}`);
  }

  const summaries = briefing.sessionSummaries.filter(
    (summary) => summary.sessionId !== selfSessionId
  );
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

function reservationSymbolList(reservation: Reservation): string {
  const symbols = reservation.symbols.map((symbol) => symbol.raw);
  const shown = symbols.slice(0, 5).join("; ");
  const remaining = symbols.length - 5;
  return remaining > 0 ? `${shown}; +${remaining} more` : shown;
}

function activeReservation(reservation: Reservation, now = Date.now()): Reservation | null {
  const roots = reservation.roots.filter((root) => reservationRootIsActive(root, now));
  if (roots.length === 0) {
    return null;
  }

  return {
    ...reservation,
    roots,
    radius: Math.max(...roots.map((root) => root.radius)),
    symbols: uniqueSymbols(roots.flatMap((root) => root.symbols))
  };
}

function reservationRootIsActive(root: ReservationRoot, now: number): boolean {
  const acquiredAt = Date.parse(root.acquiredAt);
  return Number.isNaN(acquiredAt) || now - acquiredAt <= root.ttlSec * 1000;
}

function uniqueSymbols(symbols: Reservation["symbols"]): Reservation["symbols"] {
  const seen = new Set<string>();
  const result: Reservation["symbols"] = [];
  for (const symbol of symbols) {
    if (seen.has(symbol.raw)) {
      continue;
    }
    seen.add(symbol.raw);
    result.push(symbol);
  }
  return result;
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
  const liveRegionSessionIds = new Set(
    activeSessions.filter((session) => session.status === "active").map((session) => session.id)
  );
  const activeEditLocks = state.editLocks.filter(
    (lock) => liveRegionSessionIds.has(lock.sessionId) && editLockIsActive(lock)
  );
  const activeReservations = state.reservations
    .filter((reservation) => liveRegionSessionIds.has(reservation.sessionId))
    .flatMap((reservation) => {
      const active = activeReservation(reservation);
      return active ? [active] : [];
    });
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
      `${activeEditLocks.length} active edit lock${activeEditLocks.length === 1 ? "" : "s"}`,
      `${activeReservations.length} active reservation${activeReservations.length === 1 ? "" : "s"}`,
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
      lastSeen: session.lastSeen,
      branch: session.branch
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
    editLocks: activeEditLocks.slice(0, limit),
    reservations: activeReservations.slice(0, limit),
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

export function buildPrBriefResponse(
  state: TeamState,
  options: { degraded: boolean; base?: string; head?: string; limit?: number }
): SynapsePrBriefResponse {
  const limit = clampLimit(options.limit);
  const base = options.base?.trim() || "main";
  const head = options.head?.trim() || null;
  const activity = buildWhatsupResponse(state, { degraded: options.degraded, limit: 50 });
  const sessionById = new Map(state.sessions.map((session) => [session.id, session]));

  const activeSessions = activity.sessions
    .filter((session) => branchRelevant(session.branch, base, head))
    .slice(0, limit);
  const unpushedDeltas = activity.unpushedDeltas
    .filter((delta) => branchRelevant(sessionById.get(delta.sessionId)?.branch, base, head))
    .slice(0, limit);
  const editLocks = activity.editLocks
    .filter((lock) => branchRelevant(sessionById.get(lock.sessionId)?.branch, base, head))
    .slice(0, limit);
  const recentPushes = activity.recentPushes
    .filter((push) => branchRelevant(push.branch, base, head))
    .slice(0, limit);
  const recentRepoEvents = activity.recentRepoEvents.slice(0, limit);
  const decisions = recentWhySources(state, limit);

  const summary = [
    `${activeSessions.length} branch-relevant active session${activeSessions.length === 1 ? "" : "s"}`,
    `${unpushedDeltas.length} unresolved unpushed delta${unpushedDeltas.length === 1 ? "" : "s"}`,
    `${editLocks.length} branch-relevant edit lock${editLocks.length === 1 ? "" : "s"}`,
    `${recentPushes.length} recent push${recentPushes.length === 1 ? "" : "es"}`,
    `${recentRepoEvents.length} recent GitHub repo event${recentRepoEvents.length === 1 ? "" : "s"}`,
    `${decisions.length} cited context item${decisions.length === 1 ? "" : "s"}`
  ];

  return {
    repoId: state.repoId,
    generatedAt: new Date().toISOString(),
    degraded: options.degraded,
    base,
    head,
    summary,
    briefing: renderPrBriefMarkdown({
      repoId: state.repoId,
      base,
      head,
      summary,
      activeSessions,
      unpushedDeltas,
      editLocks,
      recentPushes,
      recentRepoEvents,
      decisions
    }),
    sections: {
      activeSessions,
      unpushedDeltas,
      editLocks,
      recentPushes,
      recentRepoEvents,
      decisions
    }
  };
}

/**
 * Hybrid recall (plan C1/C2): fold the server's vector-memory matches into a
 * deterministic `why` answer. Strictly additive — the lexical floor's sources
 * keep their rank; vector-only hits append after them (deduped by reference
 * then title), and the answer is rebuilt with the same numbered-citation
 * format so every line still cites a source.
 */
export function mergeRecallIntoWhy(
  response: SynapseWhyResponse,
  matches: RecallMatch[],
  limit?: number
): SynapseWhyResponse {
  const cap = clampWhyLimit(limit);
  const seen = new Set(response.sources.map((source) => source.reference ?? source.title));
  const added: SynapseWhySource[] = [];
  for (const match of matches) {
    const key = match.reference ?? match.title;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    added.push({
      kind: match.kind,
      title: match.title,
      summary: match.summary,
      createdAt: match.createdAt,
      score: match.score,
      ...(match.reference ? { reference: match.reference } : {})
    });
  }

  if (added.length === 0) {
    return response;
  }

  const sources = [...response.sources, ...added].slice(0, cap);
  const answer = [
    `Found ${sources.length} Synapse memor${sources.length === 1 ? "y" : "ies"} related to "${response.question}":`,
    ...sources.map((source, index) => `${index + 1}. ${source.title} — ${source.summary}`)
  ].join("\n");

  return { ...response, rag: true, answer, sources };
}

function renderPrBriefMarkdown(input: {
  repoId: string;
  base: string;
  head: string | null;
  summary: string[];
  activeSessions: SynapsePrBriefResponse["sections"]["activeSessions"];
  unpushedDeltas: SynapsePrBriefResponse["sections"]["unpushedDeltas"];
  editLocks: SynapsePrBriefResponse["sections"]["editLocks"];
  recentPushes: SynapsePrBriefResponse["sections"]["recentPushes"];
  recentRepoEvents: SynapsePrBriefResponse["sections"]["recentRepoEvents"];
  decisions: SynapsePrBriefResponse["sections"]["decisions"];
}): string {
  const sections: string[] = [
    `# Synapse PR brief`,
    "",
    `Repo: ${input.repoId}`,
    `Base: ${input.base}`,
    `Head: ${input.head ?? "unknown"}`,
    "",
    `## Summary`,
    ...input.summary.map((line) => `- ${line}`)
  ];

  appendSection(
    sections,
    "Active sessions",
    input.activeSessions.map(
      (session) =>
        `- ${session.memberLogin} on ${session.branch ?? "unknown branch"} (${session.status}${session.lastTask ? `: ${session.lastTask}` : ""})`
    )
  );
  appendSection(
    sections,
    "Unresolved deltas",
    input.unpushedDeltas.map(
      (delta) =>
        `- ${delta.memberLogin}: ${delta.symbolId.raw} (${delta.changeKind}) in ${delta.filePath} — ${delta.summary}`
    )
  );
  appendSection(
    sections,
    "Edit locks",
    input.editLocks.map((lock) => `- ${lock.sessionId}: ${lock.symbolId.raw} in ${lock.filePath}`)
  );
  appendSection(
    sections,
    "Recent pushes",
    input.recentPushes.map(
      (push) =>
        `- ${push.memberId}: ${push.summary} (${push.filesAffected.join(", ") || "no files"}, ${push.sha}${push.branch ? `, ${push.branch}` : ""})`
    )
  );
  appendSection(
    sections,
    "Recent GitHub activity",
    input.recentRepoEvents.map((event) => {
      const ref =
        event.number && !event.summary.includes(`#${event.number}`) ? ` #${event.number}` : "";
      const detail = event.detail ? ` — ${event.detail}` : "";
      return `- ${event.actor}: ${event.summary}${ref}${event.url ? ` (${event.url})` : ""}${detail}`;
    })
  );
  appendSection(
    sections,
    "Cited context",
    input.decisions.map((source, index) => {
      const ref = source.reference ? ` [${source.reference}]` : "";
      return `${index + 1}. ${source.title}${ref} — ${source.summary}`;
    })
  );

  return sections.join("\n");
}

function appendSection(lines: string[], title: string, items: string[]): void {
  lines.push("", `## ${title}`);
  lines.push(...(items.length > 0 ? items : ["- None recorded."]));
}

function branchRelevant(branch: string | undefined, base: string, head: string | null): boolean {
  return !branch || branch === base || branch === head;
}

/**
 * The room's durable memory ordered by recency (no question filter) — the
 * deterministic floor of the onboarding briefing. Thin wrapper so
 * `whySources` stays private and scoring-free callers get a purpose-named
 * seam.
 */
export function recentWhySources(state: TeamState, limit?: number): SynapseWhySource[] {
  return whySources(state)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, clampWhyLimit(limit));
}

/**
 * First-session deep briefing (plan C4 slice): the full team digest plus
 * cited decision history. Unlike `sessionStartBriefing` (a diff against
 * "while you were away"), onboarding has no baseline — it always answers,
 * even for an empty room.
 */
export function buildOnboardResponse(
  state: TeamState,
  options: { degraded: boolean; limit?: number }
): SynapseOnboardResponse {
  const activity = buildWhatsupResponse(state, options);
  const decisions = recentWhySources(state, options.limit);

  const sections: string[] = [];

  const active = activity.sessions.filter((session) => session.status !== "ended");
  if (active.length > 0) {
    sections.push(
      `Active sessions:\n${active
        .map(
          (session) =>
            `  • ${session.memberLogin} (${session.status}${session.lastTask ? `: ${session.lastTask}` : ""})`
        )
        .join("\n")}`
    );
  }

  if (activity.recentPushes.length > 0) {
    sections.push(
      `Recent pushes:\n${activity.recentPushes
        .map(
          (push) => `  • ${push.memberId}: ${push.summary} (${push.filesAffected.length} file(s))`
        )
        .join("\n")}`
    );
  }

  if (activity.recentRepoEvents.length > 0) {
    sections.push(
      `Recent GitHub activity:\n${activity.recentRepoEvents
        .map((event) => `  • ${event.actor}: ${event.summary}`)
        .join("\n")}`
    );
  }

  if (activity.unpushedDeltas.length > 0) {
    sections.push(
      `Unpushed contract changes:\n${activity.unpushedDeltas
        .map((delta) => `  • ${delta.memberLogin}: ${delta.symbolId.raw} (${delta.changeKind})`)
        .join("\n")}`
    );
  }

  if (decisions.length > 0) {
    sections.push(
      `Decisions & history:\n${decisions
        .map((source, index) => `  ${index + 1}. ${source.title} — ${source.summary}`)
        .join("\n")}`
    );
  }

  const header = `🧭 Synapse onboarding briefing for ${state.repoId}:`;
  const briefing =
    sections.length === 0
      ? `${header}\nNo recorded team history yet — this room is new.`
      : `${header}\n${sections.join("\n\n")}`;

  return {
    repoId: state.repoId,
    generatedAt: new Date().toISOString(),
    degraded: options.degraded,
    briefing,
    sections: { activity, decisions }
  };
}

/**
 * Fold vector-recall matches into an onboarding response's decisions —
 * strictly additive, same dedupe key as `mergeRecallIntoWhy`
 * (reference-then-title), but recall hits rank FIRST. Deliberate divergence
 * from the why-merge: why's floor is question-scored, so it keeps rank;
 * onboarding's floor is unfiltered recency padded up to the cap, so
 * floor-first ordering would trim every semantically-selected recall hit
 * right back off the end.
 */
export function mergeRecallIntoOnboard(
  response: SynapseOnboardResponse,
  matches: RecallMatch[],
  limit?: number
): SynapseOnboardResponse {
  const cap = clampWhyLimit(limit);
  const seen = new Set(
    response.sections.decisions.map((source) => source.reference ?? source.title)
  );
  const added: SynapseWhySource[] = [];
  for (const match of matches) {
    const key = match.reference ?? match.title;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    added.push({
      kind: match.kind,
      title: match.title,
      summary: match.summary,
      createdAt: match.createdAt,
      score: match.score,
      ...(match.reference ? { reference: match.reference } : {})
    });
  }
  if (added.length === 0) {
    return response;
  }

  const decisions = [...added, ...response.sections.decisions].slice(0, cap);
  const decisionsSection = `Decisions & history:\n${decisions
    .map((source, index) => `  ${index + 1}. ${source.title} — ${source.summary}`)
    .join("\n")}`;

  // Re-render: replace the existing decisions section, or append one if the
  // floor had none (recall can answer for a room with vector memory only).
  const briefing = response.briefing.includes("Decisions & history:")
    ? response.briefing.replace(/Decisions & history:[\s\S]*$/, decisionsSection)
    : response.briefing.includes("No recorded team history yet")
      ? `🧭 Synapse onboarding briefing for ${response.repoId}:\n${decisionsSection}`
      : `${response.briefing}\n\n${decisionsSection}`;

  return { ...response, rag: true, briefing, sections: { ...response.sections, decisions } };
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

  const text =
    `${source.kind} ${source.title} ${source.summary} ${source.reference ?? ""}`.toLowerCase();
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

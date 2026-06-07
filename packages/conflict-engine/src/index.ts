import type {
  AgentType,
  Conflict,
  EditLock,
  Session,
  SymbolId,
  TeamState
} from "@synapse/protocol";

export interface ConflictTarget {
  filePath: string;
  symbolId?: SymbolId;
}

export interface DependencyHop {
  symbolId: SymbolId;
  hops: number;
}

export interface DependencyGraph {
  dependenciesOf(symbolId: SymbolId, maxHops: number): DependencyHop[];
}

export interface ConflictCheckContext {
  selfSessionId: string;
  targets: ConflictTarget[];
  state: TeamState;
  graph?: DependencyGraph;
}

export const emptyDependencyGraph: DependencyGraph = {
  dependenciesOf: () => []
};

const severityRank = {
  info: 1,
  warn: 2
} as const;

export function verdictFor(conflicts: Conflict[]): "none" | "info" | "warn" {
  if (conflicts.some((conflict) => conflict.severity === "warn")) {
    return "warn";
  }

  if (conflicts.some((conflict) => conflict.severity === "info")) {
    return "info";
  }

  return "none";
}

export function evaluateConflicts(context: ConflictCheckContext): Conflict[] {
  const graph = context.graph ?? emptyDependencyGraph;
  const conflicts = new Map<string, Conflict>();

  for (const target of context.targets) {
    const targetSymbol = target.symbolId ?? fileSymbol(target.filePath);
    const dependencyHops = dependencyHopMap(graph.dependenciesOf(targetSymbol, 2));

    for (const lock of context.state.editLocks) {
      if (lock.sessionId === context.selfSessionId) {
        continue;
      }

      if (sameSymbol(lock.symbolId, targetSymbol)) {
        addConflict(conflicts, {
          severity: "warn",
          rule: "same_symbol_active",
          targetSymbol,
          counterpart: counterpartFor(context.state.sessions, lock.sessionId),
          detail: `${labelFor(lock.sessionId, context.state.sessions)} is actively editing ${targetSymbol.raw}.`,
          suggestion: "Coordinate on the intended contract before continuing."
        });
      }
    }

    for (const delta of context.state.unpushedDeltas) {
      if (delta.sessionId === context.selfSessionId || delta.pushedAt !== null) {
        continue;
      }

      const counterpart = counterpartFor(context.state.sessions, delta.sessionId);

      if (sameSymbol(delta.symbolId, targetSymbol)) {
        addConflict(conflicts, {
          severity: "warn",
          rule: "same_symbol_unpushed",
          targetSymbol,
          counterpart,
          detail: `${counterpart.memberLogin} has an unpushed change to ${delta.symbolId.raw}: ${delta.summary}`,
          suggestion: "Pull or inspect the counterpart branch, or agree on the final contract."
        });
        continue;
      }

      const hops = dependencyHops.get(delta.symbolId.raw);
      if (hops === 1) {
        addConflict(conflicts, {
          severity: "warn",
          rule: "dependency_changed",
          targetSymbol,
          counterpart,
          detail: `${counterpart.memberLogin} changed ${delta.symbolId.raw}, which ${targetSymbol.raw} depends on: ${delta.summary}`,
          suggestion: "Adjust to the new dependency contract or coordinate before editing."
        });
      } else if (hops === 2) {
        addConflict(conflicts, {
          severity: "info",
          rule: "transitive_dependency",
          targetSymbol,
          counterpart,
          detail: `${counterpart.memberLogin} changed ${delta.symbolId.raw}, a transitive dependency of ${targetSymbol.raw}.`,
          suggestion: "Keep the related change in mind while editing."
        });
      }
    }

    for (const push of context.state.recentPushes) {
      const pushedSymbolRaws = new Set((push.symbols ?? []).map((symbol) => symbol.raw));
      const directDependencyChanged = [...dependencyHops.entries()].some(
        ([raw, hops]) => hops === 1 && pushedSymbolRaws.has(raw)
      );

      if (
        pushedSymbolRaws.has(targetSymbol.raw) ||
        directDependencyChanged ||
        push.filesAffected.includes(target.filePath)
      ) {
        addConflict(conflicts, {
          severity: "warn",
          rule: "stale_base",
          targetSymbol,
          counterpart: {
            memberLogin: push.memberId,
            sessionId: "push",
            agentType: "other"
          },
          detail: `A recent push touched code related to ${targetSymbol.raw}: ${push.summary}`,
          suggestion: "Pull the latest base before continuing."
        });
      }
    }

    for (const session of activeOtherSessions(context.state.sessions, context.selfSessionId)) {
      if (
        session.filesEditing.includes(target.filePath) &&
        !hasSpecificConflict(conflicts, targetSymbol, session.id)
      ) {
        addConflict(conflicts, {
          severity: "info",
          rule: "same_file_no_overlap",
          targetSymbol,
          counterpart: counterpartFor(context.state.sessions, session.id),
          detail: `${session.memberLogin ?? session.memberId} is also editing ${target.filePath}.`,
          suggestion: "Proceed if the symbols are unrelated; coordinate if the work overlaps."
        });
      }
    }
  }

  return suppressSameFileNoise([...conflicts.values()]).sort(
    (a, b) => severityRank[b.severity] - severityRank[a.severity]
  );
}

function hasSpecificConflict(
  conflicts: Map<string, Conflict>,
  targetSymbol: SymbolId,
  sessionId: string
): boolean {
  return [...conflicts.values()].some(
    (conflict) =>
      conflict.targetSymbol.raw === targetSymbol.raw &&
      conflict.counterpart.sessionId === sessionId &&
      conflict.rule !== "same_file_no_overlap"
  );
}

function suppressSameFileNoise(conflicts: Conflict[]): Conflict[] {
  const sessionsWithSpecificConflicts = new Set(
    conflicts
      .filter((conflict) => conflict.rule !== "same_file_no_overlap")
      .map((conflict) => conflict.counterpart.sessionId)
  );

  return conflicts.filter(
    (conflict) =>
      conflict.rule !== "same_file_no_overlap" ||
      !sessionsWithSpecificConflicts.has(conflict.counterpart.sessionId)
  );
}

function addConflict(conflicts: Map<string, Conflict>, conflict: Conflict): void {
  const key = [
    conflict.rule,
    conflict.targetSymbol.raw,
    conflict.counterpart.sessionId,
    conflict.detail
  ].join(":");
  const existing = conflicts.get(key);

  if (!existing || severityRank[conflict.severity] > severityRank[existing.severity]) {
    conflicts.set(key, conflict);
  }
}

function dependencyHopMap(hops: DependencyHop[]): Map<string, number> {
  const result = new Map<string, number>();

  for (const hop of hops) {
    const existing = result.get(hop.symbolId.raw);
    if (existing === undefined || hop.hops < existing) {
      result.set(hop.symbolId.raw, hop.hops);
    }
  }

  return result;
}

function activeOtherSessions(sessions: Session[], selfSessionId: string): Session[] {
  return sessions.filter(
    (session) =>
      session.id !== selfSessionId &&
      (session.status === "active" || session.status === "idle")
  );
}

function counterpartFor(
  sessions: Session[],
  sessionId: string
): { memberLogin: string; sessionId: string; agentType: AgentType } {
  const session = sessions.find((candidate) => candidate.id === sessionId);

  return {
    memberLogin: session?.memberLogin ?? session?.memberId ?? sessionId,
    sessionId,
    agentType: session?.agentType ?? "other"
  };
}

function labelFor(sessionId: string, sessions: Session[]): string {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  return session?.memberLogin ?? session?.memberId ?? sessionId;
}

function sameSymbol(a: SymbolId, b: SymbolId): boolean {
  return a.raw === b.raw;
}

function fileSymbol(filePath: string): SymbolId {
  return { raw: `file:${filePath}` };
}

export function symbolForFile(filePath: string): SymbolId {
  return fileSymbol(filePath);
}

export type { Conflict };

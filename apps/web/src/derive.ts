import type { Session, TeamState } from "@synapse/protocol";

export interface FlowEdge {
  from: string;
  to: string;
  contested: boolean;
}

export interface FlowGraph {
  sessions: Session[];
  symbols: string[];
  edges: FlowEdge[];
}

export function activeSessions(state: TeamState) {
  return state.sessions.filter((session) => session.status !== "ended");
}

export function deriveContestedSymbols(state: TeamState): Set<string> {
  const activeIds = new Set(activeSessions(state).map((session) => session.id));
  const sessionsBySymbol = new Map<string, Set<string>>();

  const remember = (raw: string, sessionId: string) => {
    if (!activeIds.has(sessionId)) {
      return;
    }
    const sessionIds = sessionsBySymbol.get(raw) ?? new Set<string>();
    sessionIds.add(sessionId);
    sessionsBySymbol.set(raw, sessionIds);
  };

  for (const lock of state.editLocks) {
    remember(lock.symbolId.raw, lock.sessionId);
  }

  for (const delta of state.unpushedDeltas) {
    remember(delta.symbolId.raw, delta.sessionId);
  }

  return new Set(
    Array.from(sessionsBySymbol.entries())
      .filter(([, sessionIds]) => sessionIds.size >= 2)
      .map(([raw]) => raw)
  );
}

export function deriveGraph(state: TeamState): FlowGraph {
  const sessions = activeSessions(state);
  const activeIds = new Set(sessions.map((session) => session.id));
  const contested = deriveContestedSymbols(state);
  const symbolSet = new Set<string>();

  for (const lock of state.editLocks) {
    if (activeIds.has(lock.sessionId)) {
      symbolSet.add(lock.symbolId.raw);
    }
  }

  for (const delta of state.unpushedDeltas) {
    if (activeIds.has(delta.sessionId)) {
      symbolSet.add(delta.symbolId.raw);
    }
  }

  const symbols = Array.from(symbolSet).sort();
  const edges: FlowEdge[] = [
    ...sessions.map((session) => ({
      from: session.id,
      to: "server",
      contested: false
    })),
    ...symbols.map((symbol) => ({
      from: "server",
      to: symbol,
      contested: contested.has(symbol)
    }))
  ];

  return { sessions, symbols, edges };
}

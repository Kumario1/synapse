import type {
  Reservation,
  ReservationRoot,
  ResolutionProposal,
  Session,
  TeamState
} from "@synapse/protocol";

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

export interface ActiveReservation {
  session: Session;
  reservation: Reservation;
  activeRoots: ReservationRoot[];
  rootSymbols: string[];
  dependencySymbols: string[];
  symbols: string[];
  ttlRemainingSec: number;
}

export function deriveActiveReservations(state: TeamState, now = Date.now()): ActiveReservation[] {
  const sessions = new Map(activeSessions(state).map((session) => [session.id, session]));

  return state.reservations.flatMap((reservation) => {
    const session = sessions.get(reservation.sessionId);
    if (!session) {
      return [];
    }

    const activeRoots = reservation.roots.filter((root) => rootTtlRemaining(root, now) > 0);
    if (activeRoots.length === 0) {
      return [];
    }

    const rootSymbols = Array.from(new Set(activeRoots.map((root) => root.symbolId.raw))).sort();
    const rootSet = new Set(rootSymbols);
    const dependencySymbols = Array.from(
      new Set(reservation.symbols.map((symbol) => symbol.raw).filter((raw) => !rootSet.has(raw)))
    ).sort();

    return [
      {
        session,
        reservation,
        activeRoots,
        rootSymbols,
        dependencySymbols,
        symbols: [...rootSymbols, ...dependencySymbols],
        ttlRemainingSec: Math.min(...activeRoots.map((root) => rootTtlRemaining(root, now)))
      }
    ];
  });
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

export interface ResolutionOverview {
  proposals: ResolutionProposal[];
  resolving: ResolutionProposal[];
  resolved: ResolutionProposal[];
  escalated: ResolutionProposal[];
}

export function deriveResolutionOverview(state: TeamState): ResolutionOverview {
  const proposals = state.resolutionProposals ?? [];
  return {
    proposals,
    resolving: proposals.filter((proposal) => proposal.status === "resolving"),
    resolved: proposals.filter((proposal) => proposal.status === "resolved"),
    escalated: proposals.filter(
      (proposal) => proposal.status === "awaiting_owner" || proposal.status === "voided"
    )
  };
}

function rootTtlRemaining(root: ReservationRoot, now: number) {
  const elapsed = Math.floor((now - Date.parse(root.acquiredAt)) / 1000);
  return Math.max(0, root.ttlSec - elapsed);
}

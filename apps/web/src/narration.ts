import type { TeamState } from "@synapse/protocol";
import { activeSessions, deriveContestedSymbols } from "./derive";

export type PanelKey = "online" | "signals" | "flow" | "commits";

// What each panel actually renders, reduced to a comparable signature. A panel
// "changed" between two frames when its signature differs.
function signatures(state: TeamState): Record<PanelKey, string> {
  const sessions = activeSessions(state);
  const contested = deriveContestedSymbols(state);
  const lockedSymbols = new Set(state.editLocks.map((lock) => lock.symbolId.raw));
  const deltaSymbols = new Set(state.unpushedDeltas.map((delta) => delta.symbolId.raw));

  return {
    // Online is about presence: who is in the room and their status. Task and
    // editing churn surfaces through signals/flow, not here.
    online: sessions.map((s) => `${s.id}:${s.status}`).sort().join("|"),
    signals: [...state.editLocks.map((l) => `${l.sessionId}@${l.symbolId.raw}`), ...state.unpushedDeltas.map((d) => `${d.sessionId}~${d.symbolId.raw}`)]
      .sort()
      .join("|"),
    // The flow graph draws sessions → server → contested/locked symbols.
    flow: [...lockedSymbols, ...deltaSymbols].map((sym) => `${sym}:${contested.has(sym)}`).sort().join("|"),
    commits: [...state.recentPushes.map((p) => p.id), ...state.recentRepoEvents.map((e) => e.id)].sort().join("|")
  };
}

const PANELS: PanelKey[] = ["online", "signals", "flow", "commits"];

export function changedPanels(prev: TeamState | null, next: TeamState): Set<PanelKey> {
  const after = signatures(next);
  const before = prev ? signatures(prev) : null;
  return new Set(PANELS.filter((panel) => !before || before[panel] !== after[panel]));
}

export interface NarrationStep {
  title: string;
  caption: string;
  highlight: PanelKey;
}

// One step per demoFrame. `highlight` must name a panel that changed on that
// frame — narration.test.ts enforces both invariants, so editing the frames
// without updating this list fails the build.
export const narrationSteps: NarrationStep[] = [
  {
    title: "Alice joins the room",
    caption: "An agent enters the shared room with its repo, branch, and current task.",
    highlight: "online"
  },
  {
    title: "Bob joins too",
    caption: "A second agent is now working in the same room — but on a different file.",
    highlight: "online"
  },
  {
    title: "Alice locks loadRoom",
    caption: "Before editing, Alice claims the symbol. The lock and the symbol appear as live signals.",
    highlight: "signals"
  },
  {
    title: "Alice reports a contract delta",
    caption: "Alice changes loadRoom's signature. Synapse records the before→after contract change.",
    highlight: "signals"
  },
  {
    title: "Bob hits the same symbol",
    caption: "Bob starts editing loadRoom too. Synapse flags it contested before the collision lands.",
    highlight: "signals"
  },
  {
    title: "Alice ships, Bob rebases",
    caption: "The contract update is pushed and a PR opens. Bob rebases on Alice's change instead of fighting it.",
    highlight: "commits"
  }
];

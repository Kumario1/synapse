import type {
  ContractDelta,
  EditLock,
  RecentPush,
  RecentRepoEvent,
  ResolutionProposal,
  Session,
  TeamState
} from "@synapse/protocol";

const repoId = "demo/playground";
const base = Date.parse("2026-06-15T16:00:00.000Z");
const symbol = "src/room.ts#loadRoom";
const filePath = "src/room.ts";

function at(seconds: number) {
  return new Date(base + seconds * 1000).toISOString();
}

const alice: Session = {
  id: "alice-session",
  repoId,
  memberId: "alice",
  memberLogin: "alice",
  agentType: "claude-code",
  filesOpen: [filePath],
  filesEditing: [],
  lastTask: "Explore room loading contract",
  startedAt: at(0),
  lastSeen: at(0),
  status: "active",
  branch: "feature/room-contract"
};

const bob: Session = {
  id: "bob-session",
  repoId,
  memberId: "bob",
  memberLogin: "bob",
  agentType: "cursor",
  filesOpen: ["src/sidebar.ts"],
  filesEditing: [],
  lastTask: "Wire room sidebar",
  startedAt: at(18),
  lastSeen: at(18),
  status: "active",
  branch: "feature/sidebar"
};

const aliceLock: EditLock = {
  sessionId: alice.id,
  symbolId: { raw: symbol },
  filePath,
  acquiredAt: at(36),
  ttlSec: 180
};

const bobLock: EditLock = {
  sessionId: bob.id,
  symbolId: { raw: symbol },
  filePath,
  acquiredAt: at(72),
  ttlSec: 180
};

const aliceDelta: ContractDelta = {
  id: "delta-load-room",
  repoId,
  sessionId: alice.id,
  symbolId: { raw: symbol },
  changeKind: "signature_changed",
  before: null,
  after: null,
  summary: "Return room members and active edit locks together",
  filePath,
  baseSha: "6781b81",
  dependents: [{ raw: "src/sidebar.ts#renderRoom" }],
  createdAt: at(54),
  pushedAt: null
};

const loadRoomProposal: ResolutionProposal = {
  id: `rp:${symbol}:${alice.id}:${bob.id}`,
  repoId,
  symbol: { raw: symbol },
  conflictClass: "mechanical",
  before: null,
  after: null,
  status: "resolving",
  directions: [
    {
      sessionId: alice.id,
      role: "keep",
      summary: "Keep the loadRoom contract update.",
      affectedSites: []
    },
    {
      sessionId: bob.id,
      role: "adapt",
      summary: "Update src/sidebar.ts to match loadRoom's new shape.",
      affectedSites: [
        { symbolId: { raw: "src/sidebar.ts#renderRoom" }, filePath: "src/sidebar.ts" }
      ]
    }
  ],
  acceptedBy: [alice.id],
  createdAt: at(78)
};

const finalPush: RecentPush = {
  id: "push-load-room",
  repoId,
  memberId: alice.memberId,
  summary: "Ship live room contract update",
  filesAffected: [filePath, "src/sidebar.ts"],
  symbols: [{ raw: symbol }],
  sha: "d91fe20",
  pushedAt: at(108),
  branch: "feature/room-contract"
};

const finalPr: RecentRepoEvent = {
  id: "pr-load-room",
  repoId,
  kind: "pull_request",
  action: "opened",
  actor: "alice",
  title: "Update live room contract",
  number: 37,
  url: "https://example.com/demo/playground/pull/37",
  summary: "Room contract update is ready for review",
  createdAt: at(112)
};

function state(step: number, patch: Partial<TeamState>): TeamState {
  return {
    repoId,
    editLocks: [],
    reservations: [],
    unpushedDeltas: [],
    recentPushes: [],
    recentRepoEvents: [],
    resolutions: [],
    resolutionProposals: [],
    sessionSummaries: [],
    conflictFeedback: [],
    ...patch,
    sessions: (patch.sessions ?? []).map((session, index) => ({
      ...session,
      lastSeen: session.status === "ended" ? session.lastSeen : at(step * 18 - index * 4)
    }))
  };
}

export const demoFrames: TeamState[] = [
  state(0, {
    sessions: [alice]
  }),
  state(1, {
    sessions: [alice, bob]
  }),
  state(2, {
    sessions: [
      { ...alice, filesEditing: [filePath], lastTask: "Lock loadRoom before editing" },
      bob
    ],
    editLocks: [aliceLock]
  }),
  state(3, {
    sessions: [{ ...alice, filesEditing: [filePath], lastTask: "Report contract delta" }, bob],
    editLocks: [aliceLock],
    unpushedDeltas: [aliceDelta]
  }),
  state(4, {
    sessions: [
      { ...alice, filesEditing: [filePath], lastTask: "Resolve overlapping room work" },
      { ...bob, filesEditing: [filePath], lastTask: "Started same symbol edit" }
    ],
    editLocks: [aliceLock, bobLock],
    unpushedDeltas: [aliceDelta],
    resolutionProposals: [loadRoomProposal]
  }),
  state(5, {
    sessions: [
      { ...alice, filesEditing: [], lastTask: "Pushed room contract update" },
      { ...bob, filesEditing: [], lastTask: "Rebased on Alice's update", status: "idle" }
    ],
    editLocks: [],
    unpushedDeltas: [],
    resolutionProposals: [
      {
        ...loadRoomProposal,
        status: "resolved",
        acceptedBy: [alice.id, bob.id]
      }
    ],
    recentPushes: [finalPush],
    recentRepoEvents: [finalPr]
  })
];

import { useMemo } from "react";
import { activeSessions, deriveContestedSymbols } from "./derive";
import type { FeedSnapshot } from "./feed";
import FlowGraph from "./FlowGraph";
import { CommitsPanel, OnlinePanel, SignalsPanel } from "./panels";

export default function Dashboard({ snapshot }: { snapshot: FeedSnapshot }) {
  const sessions = useMemo(() => activeSessions(snapshot.state), [snapshot.state]);
  const contested = useMemo(() => deriveContestedSymbols(snapshot.state), [snapshot.state]);

  return (
    <main className="dashboard" id="dashboard">
      <section className="dashboard__head">
        <div>
          <p className="eyebrow">Live room</p>
          <h2>{snapshot.state.repoId}</h2>
        </div>
        <dl className="metrics" aria-label="Room metrics">
          <div>
            <dt>Members</dt>
            <dd>{sessions.length}</dd>
          </div>
          <div>
            <dt>Signals</dt>
            <dd>{snapshot.state.unpushedDeltas.length + snapshot.state.editLocks.length}</dd>
          </div>
          <div>
            <dt>Contested</dt>
            <dd>{contested.size}</dd>
          </div>
        </dl>
        <div className={`status status--${snapshot.status}`}>
          <span aria-hidden="true" />
          <strong>{snapshot.mode}</strong>
          <small>{snapshot.message} · seq {snapshot.seq}</small>
        </div>
      </section>

      <section className="dashboard__grid" aria-label="Synapse room dashboard">
        <OnlinePanel sessions={sessions} />
        <SignalsPanel state={snapshot.state} />
        <FlowGraph state={snapshot.state} />
        <CommitsPanel pushes={snapshot.state.recentPushes} events={snapshot.state.recentRepoEvents} />
      </section>
    </main>
  );
}

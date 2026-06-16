"use client";

import type { RecentPush, RecentRepoEvent, Session, TeamState } from "@synapse/protocol";
import { deriveContestedSymbols } from "./derive";

export function OnlinePanel({ sessions }: { sessions: Session[] }) {
  return (
    <article className="panel panel--online">
      <header className="panel__header">
        <p className="eyebrow">Online members</p>
        <strong>{sessions.length}</strong>
      </header>
      <div className="member-list">
        {sessions.map((session) => (
          <section className="member" key={session.id}>
            <div>
              <h3>{session.memberLogin ?? session.memberId}</h3>
              <p>{session.lastTask ?? "Waiting for work"}</p>
            </div>
            <dl>
              <div>
                <dt>Agent</dt>
                <dd>{session.agentType}</dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd>{session.branch ?? "unknown"}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{session.status}</dd>
              </div>
            </dl>
          </section>
        ))}
      </div>
    </article>
  );
}

export function SignalsPanel({ state }: { state: TeamState }) {
  const contested = deriveContestedSymbols(state);
  const sessions = new Map(state.sessions.map((session) => [session.id, session]));

  return (
    <article className="panel panel--signals">
      <header className="panel__header">
        <p className="eyebrow">Edit signals</p>
        <strong>{state.editLocks.length}</strong>
      </header>
      {state.editLocks.length === 0 ? (
        <p className="empty">No active signals</p>
      ) : (
        <div className="signal-list">
          {state.editLocks.map((lock) => {
            const holder = sessions.get(lock.sessionId);
            const isContested = contested.has(lock.symbolId.raw);
            return (
              <section className={isContested ? "signal-row signal-row--contested" : "signal-row"} key={`${lock.sessionId}-${lock.symbolId.raw}`}>
                <span>{isContested ? "Contested lock" : "Edit lock"}</span>
                <h3>{holder?.memberLogin ?? holder?.memberId ?? lock.sessionId} -&gt; {lock.symbolId.raw}</h3>
                <p>{lock.filePath}</p>
                <small>{ttlRemaining(lock.acquiredAt, lock.ttlSec)}s TTL</small>
              </section>
            );
          })}
        </div>
      )}
    </article>
  );
}

export function CommitsPanel({ pushes, events }: { pushes: RecentPush[]; events: RecentRepoEvent[] }) {
  const items = [
    ...pushes.map((push) => ({ ...push, itemType: "push" as const, at: push.pushedAt })),
    ...events.map((event) => ({ ...event, itemType: "event" as const, at: event.createdAt }))
  ].sort((left, right) => Date.parse(right.at) - Date.parse(left.at));

  return (
    <article className="panel panel--commits">
      <header className="panel__header">
        <p className="eyebrow">Commits and PRs</p>
        <strong>{items.length}</strong>
      </header>
      {items.length === 0 ? (
        <p className="empty">No recent activity</p>
      ) : (
        <div className="timeline">
          {items.map((item) => (
            <section key={`${item.itemType}-${item.id}`}>
              {item.itemType === "push" ? <PushItem push={item} /> : <RepoEventItem event={item} />}
              <time dateTime={item.at}>{relativeTime(item.at)}</time>
            </section>
          ))}
        </div>
      )}
    </article>
  );
}

function PushItem({ push }: { push: RecentPush & { at: string; itemType: "push" } }) {
  return (
    <>
      <span>push {push.sha.slice(0, 7)}</span>
      <h3>{push.summary}</h3>
      <p>{push.filesAffected.length} files</p>
    </>
  );
}

function RepoEventItem({ event }: { event: RecentRepoEvent & { at: string; itemType: "event" } }) {
  const label = `${event.kind.replaceAll("_", " ")} ${event.action}`;
  const title = `${event.number ? `#${event.number} ` : ""}${event.title}`;

  return (
    <>
      <span>{label}</span>
      <h3>
        {event.url ? (
          <a href={event.url} rel="noreferrer" target="_blank">{title}</a>
        ) : (
          title
        )}
      </h3>
      <p>{event.actor}</p>
    </>
  );
}

export function relativeTime(value: string, now = Date.now()) {
  const elapsed = Math.max(0, now - Date.parse(value));
  const seconds = Math.round(elapsed / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

function ttlRemaining(acquiredAt: string, ttlSec: number, now = Date.now()) {
  const elapsed = Math.floor((now - Date.parse(acquiredAt)) / 1000);
  return Math.max(0, ttlSec - elapsed);
}

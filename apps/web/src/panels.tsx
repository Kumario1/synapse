import { GitCommitHorizontalIcon, LockKeyholeIcon, RadioTowerIcon, UsersIcon } from "lucide-react";
import type {
  RecentPush,
  RecentRepoEvent,
  ResolutionProposal,
  Session,
  TeamState
} from "@synapse/protocol";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { deriveContestedSymbols, deriveResolutionOverview } from "./derive";

export function OnlinePanel({
  sessions,
  onKick
}: {
  sessions: Session[];
  onKick?: (session: Session) => void;
}) {
  return (
    <Card className="bg-card/85">
      <CardHeader>
        <CardTitle>Online members</CardTitle>
        <CardDescription>Active agents in the shared room.</CardDescription>
        <CardAction>
          <Badge variant="secondary">{sessions.length}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? (
          <PanelEmpty icon={UsersIcon} title="No members online" description="Waiting for an agent to join this room." />
        ) : (
          <div className="flex flex-col gap-4">
            {sessions.map((session, index) => (
              <div className="flex flex-col gap-4" key={session.id}>
                {index > 0 ? <Separator /> : null}
                <section className="grid gap-4 sm:grid-cols-[auto_1fr_auto]">
                  <Avatar size="lg">
                    <AvatarFallback>{initials(session.memberLogin ?? session.memberId)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium">{session.memberLogin ?? session.memberId}</h3>
                    <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
                      {session.lastTask ?? "Waiting for work"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-start gap-2 sm:justify-end">
                    <Badge variant="outline">{session.agentType}</Badge>
                    <Badge variant={session.status === "active" ? "secondary" : "outline"}>{session.status}</Badge>
                    <Badge variant="outline">{session.branch ?? "unknown branch"}</Badge>
                    {onKick && session.status !== "ended" ? (
                      <Button size="sm" variant="outline" onClick={() => onKick(session)}>
                        Kick
                      </Button>
                    ) : null}
                  </div>
                </section>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SignalsPanel({ state }: { state: TeamState }) {
  const contested = deriveContestedSymbols(state);
  const sessions = new Map(state.sessions.map((session) => [session.id, session]));

  return (
    <Card className="bg-card/85">
      <CardHeader>
        <CardTitle>Edit signals</CardTitle>
        <CardDescription>Locks that announce where agents are editing.</CardDescription>
        <CardAction>
          <Badge variant={contested.size > 0 ? "destructive" : "secondary"}>{state.editLocks.length}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {state.editLocks.length === 0 ? (
          <PanelEmpty icon={LockKeyholeIcon} title="No active signals" description="No one is holding an edit lock right now." />
        ) : (
          <div className="flex flex-col gap-4">
            {state.editLocks.map((lock, index) => {
              const holder = sessions.get(lock.sessionId);
              const isContested = contested.has(lock.symbolId.raw);
              return (
                <div className="flex flex-col gap-4" key={`${lock.sessionId}-${lock.symbolId.raw}`}>
                  {index > 0 ? <Separator /> : null}
                  <section className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Badge variant={isContested ? "destructive" : "outline"}>
                        {isContested ? "Contested lock" : "Edit lock"}
                      </Badge>
                      <Badge variant="secondary">{ttlRemaining(lock.acquiredAt, lock.ttlSec)}s TTL</Badge>
                    </div>
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-medium">
                        {holder?.memberLogin ?? holder?.memberId ?? lock.sessionId} -&gt; {lock.symbolId.raw}
                      </h3>
                      <p className="mt-1 truncate text-sm text-muted-foreground">{lock.filePath}</p>
                    </div>
                  </section>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ResolutionPanel({
  state,
  onChooseWinner
}: {
  state: TeamState;
  onChooseWinner?: (proposal: ResolutionProposal, winnerSessionId: string) => void;
}) {
  const overview = deriveResolutionOverview(state);
  const sessions = new Map(state.sessions.map((session) => [session.id, session]));

  return (
    <Card className="bg-card/85">
      <CardHeader>
        <CardTitle>Resolution mediator</CardTitle>
        <CardDescription>Coordinated keep/adapt proposals and Owner escalations.</CardDescription>
        <CardAction>
          <div className="flex flex-wrap justify-end gap-2">
            <Badge variant="outline">{overview.resolving.length} resolving</Badge>
            <Badge variant="secondary">{overview.resolved.length} resolved</Badge>
            <Badge variant={overview.escalated.length > 0 ? "destructive" : "outline"}>
              {overview.escalated.length} escalated
            </Badge>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent>
        {overview.proposals.length === 0 ? (
          <PanelEmpty icon={RadioTowerIcon} title="No mediator proposals" description="Resolving pairs and Owner escalations will appear here." />
        ) : (
          <div className="flex flex-col gap-4">
            {overview.proposals.map((proposal, index) => (
              <div className="flex flex-col gap-4" key={proposal.id}>
                {index > 0 ? <Separator /> : null}
                <section className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant={proposal.status === "voided" || proposal.status === "awaiting_owner" ? "destructive" : "outline"}>
                        {proposal.status.replace("_", " ")}
                      </Badge>
                      <Badge variant="secondary">{proposal.conflictClass}</Badge>
                    </div>
                    {proposal.directions.length > 0 ? (
                      <Badge variant="outline">
                        {proposal.acceptedBy.length}/{proposal.directions.length} accepted
                      </Badge>
                    ) : null}
                  </div>
                  <div className="min-w-0">
                    <h3 className="break-words text-sm font-medium">{proposal.symbol.raw}</h3>
                    {proposal.voidReason ? (
                      <p className="mt-1 text-sm text-muted-foreground">
                        Voided by {proposal.voidReason}
                        {proposal.voidedBy ? ` from ${labelFor(proposal.voidedBy, sessions)}` : ""}.
                      </p>
                    ) : null}
                  </div>
                  {proposal.status === "awaiting_owner" && proposal.candidates?.length ? (
                    <div className="flex flex-wrap gap-2">
                      {proposal.candidates.map((candidate) => (
                        <Button
                          key={candidate}
                          size="sm"
                          variant="outline"
                          onClick={() => onChooseWinner?.(proposal, candidate)}
                          disabled={!onChooseWinner}
                        >
                          Choose {labelFor(candidate, sessions)}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                  {proposal.directions.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      {proposal.directions.map((direction) => (
                        <p className="line-clamp-2 text-sm text-muted-foreground" key={`${proposal.id}-${direction.sessionId}`}>
                          <span className="font-medium text-foreground">{direction.role}</span>{" "}
                          {labelFor(direction.sessionId, sessions)}: {direction.summary}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </section>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function CommitsPanel({ pushes, events }: { pushes: RecentPush[]; events: RecentRepoEvent[] }) {
  const items = [
    ...pushes.map((push) => ({ ...push, itemType: "push" as const, at: push.pushedAt })),
    ...events.map((event) => ({ ...event, itemType: "event" as const, at: event.createdAt }))
  ].sort((left, right) => Date.parse(right.at) - Date.parse(left.at));

  return (
    <Card className="bg-card/85">
      <CardHeader>
        <CardTitle>Commits and PRs</CardTitle>
        <CardDescription>Recent repository activity tied to the room.</CardDescription>
        <CardAction>
          <Badge variant="secondary">{items.length}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <PanelEmpty icon={GitCommitHorizontalIcon} title="No recent activity" description="Pushes and PRs will appear here." />
        ) : (
          <div className="flex flex-col gap-4">
            {items.map((item, index) => (
              <div className="flex flex-col gap-4" key={`${item.itemType}-${item.id}`}>
                {index > 0 ? <Separator /> : null}
                <section className="flex flex-col gap-2">
                  {item.itemType === "push" ? <PushItem push={item} /> : <RepoEventItem event={item} />}
                  <time className="text-sm text-muted-foreground" dateTime={item.at}>
                    {relativeTime(item.at)}
                  </time>
                </section>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PushItem({ push }: { push: RecentPush & { at: string; itemType: "push" } }) {
  return (
    <>
      <Badge className="w-fit" variant="outline">
        push {push.sha.slice(0, 7)}
      </Badge>
      <h3 className="text-sm font-medium">{push.summary}</h3>
      <p className="text-sm text-muted-foreground">{push.filesAffected.length} files · {push.branch}</p>
    </>
  );
}

function RepoEventItem({ event }: { event: RecentRepoEvent & { at: string; itemType: "event" } }) {
  const label = `${event.kind.replaceAll("_", " ")} ${event.action}`;
  const title = `${event.number ? `#${event.number} ` : ""}${event.title}`;

  return (
    <>
      <Badge className="w-fit" variant="secondary">
        {label}
      </Badge>
      <h3 className="text-sm font-medium">
        {event.url ? (
          <a className="underline underline-offset-4" href={event.url} rel="noreferrer" target="_blank">
            {title}
          </a>
        ) : (
          title
        )}
      </h3>
      <p className="text-sm text-muted-foreground">{event.actor}</p>
    </>
  );
}

function PanelEmpty({ description, icon: Icon, title }: { description: string; icon: typeof UsersIcon; title: string }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
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

function initials(value: string) {
  return value
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function labelFor(sessionId: string, sessions: Map<string, Session>) {
  const session = sessions.get(sessionId);
  return session?.memberLogin ?? session?.memberId ?? sessionId;
}

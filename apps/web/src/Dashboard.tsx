import { ActivityIcon, GitPullRequestIcon, LockKeyholeIcon, UsersIcon } from "lucide-react";
import type { ResolutionProposal, Session } from "@synapse/protocol";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { activeSessions, deriveActiveReservations, deriveContestedSymbols } from "./derive";
import type { FeedSnapshot, FeedStatus } from "./feed";
import FlowGraph from "./FlowGraph";
import {
  CommitsPanel,
  OnlinePanel,
  ReservationsPanel,
  ResolutionPanel,
  SignalsPanel
} from "./panels";

export default function Dashboard({
  snapshot,
  onKick,
  onChooseWinner
}: {
  snapshot: FeedSnapshot;
  onKick?: (session: Session) => void;
  onChooseWinner?: (proposal: ResolutionProposal, winnerSessionId: string) => void;
}) {
  const sessions = activeSessions(snapshot.state);
  const contested = deriveContestedSymbols(snapshot.state);
  const reservations = deriveActiveReservations(snapshot.state);
  const signalCount = snapshot.state.unpushedDeltas.length + snapshot.state.editLocks.length;
  const activityCount = snapshot.state.recentPushes.length + snapshot.state.recentRepoEvents.length;

  return (
    <main
      className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 pb-16 sm:px-6 lg:px-8"
      id="dashboard"
    >
      <section className="grid gap-3 lg:grid-cols-[1fr_auto]" aria-label="Live room summary">
        <Card className="bg-card/85">
          <CardHeader>
            <CardTitle className="text-3xl tracking-normal sm:text-4xl">
              {snapshot.state.repoId}
            </CardTitle>
            <CardDescription>
              Live coordination room with current sessions, edit signals, data flow, and repository
              activity.
            </CardDescription>
            <CardAction>
              <Badge variant={statusVariant(snapshot.status)}>{snapshot.status}</Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {snapshot.message} · {snapshot.mode} · seq {snapshot.seq}
            </p>
          </CardContent>
        </Card>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:min-w-[42rem]">
          <Metric icon={UsersIcon} label="Members" value={sessions.length} />
          <Metric icon={LockKeyholeIcon} label="Signals" value={signalCount} />
          <Metric icon={ActivityIcon} label="Reservations" value={reservations.length} />
          <Metric icon={ActivityIcon} label="Contested" value={contested.size} />
          <Metric icon={GitPullRequestIcon} label="Ship trail" value={activityCount} />
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-2" aria-label="Synapse room dashboard">
        <OnlinePanel sessions={sessions} onKick={onKick} />
        <SignalsPanel state={snapshot.state} />
        <ReservationsPanel state={snapshot.state} />
        <ResolutionPanel state={snapshot.state} onChooseWinner={onChooseWinner} />
        <FlowGraph state={snapshot.state} />
        <CommitsPanel
          pushes={snapshot.state.recentPushes}
          events={snapshot.state.recentRepoEvents}
        />
      </section>
    </main>
  );
}

function Metric({
  icon: Icon,
  label,
  value
}: {
  icon: typeof UsersIcon;
  label: string;
  value: number;
}) {
  return (
    <Card className="bg-card/70" size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="size-4 text-primary" />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="font-heading text-3xl leading-none">{value}</p>
      </CardContent>
    </Card>
  );
}

function statusVariant(status: FeedStatus) {
  return status === "open" || status === "connecting" ? "secondary" : "destructive";
}

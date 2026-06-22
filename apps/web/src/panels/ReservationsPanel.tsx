import { LockKeyholeIcon } from "lucide-react";
import type { TeamState } from "@synapse/protocol";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { ActiveReservation } from "../derive";
import { PanelEmpty } from "./PanelEmpty";
import { labelFor, relativeTime } from "./format";

export function ReservationsPanel({
  state,
  regions
}: {
  state: TeamState;
  regions: ActiveReservation[];
}) {
  const sessions = new Map(state.sessions.map((session) => [session.id, session]));

  return (
    <Card className="bg-card/85">
      <CardHeader>
        <CardTitle>Reservations</CardTitle>
        <CardDescription>
          Reported edit regions: held symbols plus dependency neighbors, not Contracts.
        </CardDescription>
        <CardAction>
          <Badge variant="secondary">{regions.length}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {regions.length === 0 ? (
          <PanelEmpty
            icon={LockKeyholeIcon}
            title="No active Reservations"
            description="No session is holding a Reservation right now."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {regions.map((region, index) => (
              <div className="flex flex-col gap-4" key={region.reservation.sessionId}>
                {index > 0 ? <Separator /> : null}
                <section className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline">radius {region.reservation.radius}</Badge>
                      <Badge variant="outline">{region.activeRoots.length} roots</Badge>
                      <Badge variant="secondary">{region.symbols.length} symbols</Badge>
                    </div>
                    <Badge variant="secondary">{region.ttlRemainingSec}s TTL</Badge>
                  </div>
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium">
                      {labelFor(region.reservation.sessionId, sessions)}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Updated{" "}
                      <time dateTime={region.reservation.updatedAt}>
                        {relativeTime(region.reservation.updatedAt)}
                      </time>
                    </p>
                  </div>
                  <SymbolList label="Held symbols" symbols={region.rootSymbols} />
                  <SymbolList
                    empty="No dependency neighbors"
                    label="Dependency neighbors"
                    symbols={region.dependencySymbols}
                  />
                </section>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SymbolList({
  empty,
  label,
  symbols
}: {
  empty?: string;
  label: string;
  symbols: string[];
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{label}</p>
      {symbols.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {symbols.map((symbol) => (
            <Badge className="max-w-full truncate" key={symbol} variant="outline">
              {symbol}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

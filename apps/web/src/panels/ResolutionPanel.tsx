import { RadioTowerIcon } from "lucide-react";
import type { ResolutionProposal, TeamState } from "@synapse/protocol";
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
import { Separator } from "@/components/ui/separator";
import { deriveResolutionOverview } from "../derive";
import { PanelEmpty } from "./PanelEmpty";
import { labelFor } from "./format";

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
          <PanelEmpty
            icon={RadioTowerIcon}
            title="No mediator proposals"
            description="Resolving pairs and Owner escalations will appear here."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {overview.proposals.map((proposal, index) => (
              <div className="flex flex-col gap-4" key={proposal.id}>
                {index > 0 ? <Separator /> : null}
                <section className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-2">
                      <Badge
                        variant={
                          proposal.status === "voided" || proposal.status === "awaiting_owner"
                            ? "destructive"
                            : "outline"
                        }
                      >
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
                        <p
                          className="line-clamp-2 text-sm text-muted-foreground"
                          key={`${proposal.id}-${direction.sessionId}`}
                        >
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

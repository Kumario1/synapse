import { UsersIcon } from "lucide-react";
import type { Session } from "@synapse/protocol";
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
import { Separator } from "@/components/ui/separator";
import { PanelEmpty } from "./PanelEmpty";
import { initials } from "./format";

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
          <PanelEmpty
            icon={UsersIcon}
            title="No members online"
            description="Waiting for an agent to join this room."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {sessions.map((session, index) => (
              <div className="flex flex-col gap-4" key={session.id}>
                {index > 0 ? <Separator /> : null}
                <section className="grid gap-4 sm:grid-cols-[auto_1fr_auto]">
                  <Avatar size="lg">
                    <AvatarFallback>
                      {initials(session.memberLogin ?? session.memberId)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium">
                      {session.memberLogin ?? session.memberId}
                    </h3>
                    <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
                      {session.lastTask ?? "Waiting for work"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-start gap-2 sm:justify-end">
                    <Badge variant="outline">{session.agentType}</Badge>
                    <Badge variant={session.status === "active" ? "secondary" : "outline"}>
                      {session.status}
                    </Badge>
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

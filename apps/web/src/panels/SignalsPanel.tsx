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
import { PanelEmpty } from "./PanelEmpty";
import { ttlRemaining } from "./format";

export function SignalsPanel({ state, contested }: { state: TeamState; contested: Set<string> }) {
  const sessions = new Map(state.sessions.map((session) => [session.id, session]));

  return (
    <Card className="bg-card/85">
      <CardHeader>
        <CardTitle>Edit signals</CardTitle>
        <CardDescription>Locks that announce where agents are editing.</CardDescription>
        <CardAction>
          <Badge variant={contested.size > 0 ? "destructive" : "secondary"}>
            {state.editLocks.length}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {state.editLocks.length === 0 ? (
          <PanelEmpty
            icon={LockKeyholeIcon}
            title="No active signals"
            description="No one is holding an edit lock right now."
          />
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
                      <Badge variant="secondary">
                        {ttlRemaining(lock.acquiredAt, lock.ttlSec)}s TTL
                      </Badge>
                    </div>
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-medium">
                        {holder?.memberLogin ?? holder?.memberId ?? lock.sessionId} -&gt;{" "}
                        {lock.symbolId.raw}
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

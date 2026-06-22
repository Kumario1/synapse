import { GitCommitHorizontalIcon } from "lucide-react";
import type { RecentPush, RecentRepoEvent } from "@synapse/protocol";
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
import { relativeTime } from "./format";

export function CommitsPanel({
  pushes,
  events
}: {
  pushes: RecentPush[];
  events: RecentRepoEvent[];
}) {
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
          <PanelEmpty
            icon={GitCommitHorizontalIcon}
            title="No recent activity"
            description="Pushes and PRs will appear here."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {items.map((item, index) => (
              <div className="flex flex-col gap-4" key={`${item.itemType}-${item.id}`}>
                {index > 0 ? <Separator /> : null}
                <section className="flex flex-col gap-2">
                  {item.itemType === "push" ? (
                    <PushItem push={item} />
                  ) : (
                    <RepoEventItem event={item} />
                  )}
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
      <p className="text-sm text-muted-foreground">
        {push.filesAffected.length} files · {push.branch}
      </p>
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
          <a
            className="underline underline-offset-4"
            href={event.url}
            rel="noreferrer"
            target="_blank"
          >
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

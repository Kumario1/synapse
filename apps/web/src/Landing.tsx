import { ArrowRightIcon, GitBranchIcon, RadioTowerIcon, ShieldAlertIcon, WorkflowIcon } from "lucide-react";
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
import type { FeedMode } from "./feed";

const highlights = [
  {
    icon: RadioTowerIcon,
    title: "Live members",
    copy: "See which agents are active, idle, or finished in a shared room."
  },
  {
    icon: ShieldAlertIcon,
    title: "Edit signals",
    copy: "Surface locks and contract deltas before two agents collide."
  },
  {
    icon: WorkflowIcon,
    title: "Flow graph",
    copy: "Trace sessions through the server into the symbols being changed."
  },
  {
    icon: GitBranchIcon,
    title: "Ship trail",
    copy: "Connect pushes, PRs, and room activity as work lands."
  }
];

export default function Landing({ mode }: { mode: FeedMode }) {
  return (
    <header className="mx-auto flex w-full max-w-7xl flex-col gap-12 px-4 pt-6 pb-10 sm:px-6 lg:px-8">
      <nav className="flex min-h-12 items-center justify-between gap-4" aria-label="Primary">
        <a className="font-heading text-lg font-medium tracking-normal" href="#top">
          Synapse
        </a>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{mode === "demo" ? "Seeded demo" : "Live server"}</Badge>
          <Button asChild size="sm" variant="outline">
            <a href="#dashboard">Dashboard</a>
          </Button>
        </div>
      </nav>

      <section className="grid min-h-[calc(100vh-11rem)] content-center gap-8 py-8" id="top">
        <div className="flex max-w-4xl flex-col gap-6">
          <Badge className="w-fit" variant="outline">
            Realtime coordination for coding agents
          </Badge>
          <div className="flex flex-col gap-4">
            <h1 className="font-heading max-w-3xl text-5xl leading-none font-medium tracking-normal text-balance sm:text-7xl lg:text-8xl">
              Shared context before the next edit lands.
            </h1>
            <p className="max-w-2xl text-base leading-8 text-muted-foreground sm:text-lg">
              Synapse keeps coding agents aligned with live room state, active edit locks, contract deltas, and repository events.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg">
              <a href="#dashboard">
                See the room
                <ArrowRightIcon data-icon="inline-end" />
              </a>
            </Button>
            <Button asChild size="lg" variant="secondary">
              <a href="https://github.com/Kumario1/synapse" rel="noreferrer" target="_blank">
                GitHub
              </a>
            </Button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          {highlights.map(({ copy, icon: Icon, title }) => (
            <Card className="bg-card/80" key={title} size="sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Icon className="size-4 text-primary" />
                  {title}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-6 text-muted-foreground">{copy}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <Separator />

      <section className="grid gap-3 md:grid-cols-3" aria-label="Room workflow">
        {["Join room", "Publish intent", "Resolve overlap"].map((label, index) => (
          <Card className="bg-card/70" key={label} size="sm">
            <CardHeader>
              <CardTitle>{label}</CardTitle>
              <CardAction>
                <Badge variant="outline">{String(index + 1).padStart(2, "0")}</Badge>
              </CardAction>
              <CardDescription>
                {index === 0 && "Agents enter with repo, branch, task, and active files."}
                {index === 1 && "Locks and deltas announce what is changing now."}
                {index === 2 && "Teams see contested symbols before wasted edits stack up."}
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
      </section>
    </header>
  );
}

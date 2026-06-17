import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { fetchProjects, type Project } from "@/auth";
import { INSTALL_COMMAND, daemonCommand, fetchRoomConnected } from "@/onboarding";

/**
 * Onboarding (plan 053). For each Project the signed-in Owner has claimed,
 * shows the CLI install step plus the exact daemon-start command for THIS
 * Project (hosted server URL + the repo's minted project-key) and a live
 * connected indicator. Self-fetches `/auth/projects`; renders nothing when
 * there are none, so the signed-out landing is unchanged.
 */
export default function Onboarding() {
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    fetchProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  if (projects.length === 0) {
    return null;
  }

  return (
    <section className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
      <h2 className="text-2xl font-semibold tracking-tight">Connect your Project</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Install the CLI, then start the daemon for each Project. The view flips to
        Connected once a daemon joins.
      </p>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        {projects.map((project) => (
          <Card key={project.repoId}>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>{project.repoId}</CardTitle>
                <ConnectionStatus project={project} />
              </div>
              <CardDescription>
                Run these two steps from your repo to connect a daemon.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <CommandStep
                label="1. Install the CLI"
                command={INSTALL_COMMAND}
              />
              <CommandStep
                label="2. Start the daemon"
                command={daemonCommand(project)}
              />
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

function CommandStep({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(command);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
        <code>{command}</code>
      </pre>
    </div>
  );
}

function ConnectionStatus({ project }: { project: Project }) {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let active = true;
    const check = () => {
      void fetchRoomConnected(project).then((result) => {
        if (active) setConnected(result);
      });
    };
    check();
    const interval = window.setInterval(check, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [project]);

  return (
    <Badge variant={connected ? "default" : "secondary"}>
      {connected ? "Connected" : "Waiting for daemon…"}
    </Badge>
  );
}

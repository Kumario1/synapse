import { useEffect, useState } from "react";
import type { TeamState } from "@synapse/protocol";
import { Button } from "@/components/ui/button";
import { fetchProjects, type Project } from "@/auth";
import { emptyRoomState, fetchOwnedRoomState, toSnapshot } from "@/projects";
import type { FeedStatus } from "@/feed";
import Dashboard from "@/Dashboard";

/**
 * Owner dashboard (plan 054). Lists every Project the signed-in Owner has
 * claimed, lets them select one, and renders that Project's live Room by
 * reusing {@link Dashboard}. The read path is cookie-authed and authorized by
 * ownership (`GET /auth/projects/state`); live updates arrive by polling that
 * route every ~2s, not over the project-key WebSocket. Self-fetches
 * `/auth/projects`; renders nothing when there are none.
 */
export default function ProjectsDashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    fetchProjects()
      .then((found) => {
        setProjects(found);
        setSelected((current) => current ?? found[0]?.repoId ?? null);
      })
      .catch(() => setProjects([]));
  }, []);

  if (projects.length === 0) {
    return null;
  }

  return (
    <section className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
      <h2 className="text-2xl font-semibold tracking-tight">Your Projects</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Select a Project to watch its live Room — agent sessions, edit locks,
        contested symbols, and the ship trail.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        {projects.map((project) => (
          <Button
            key={project.repoId}
            size="sm"
            variant={project.repoId === selected ? "default" : "outline"}
            onClick={() => setSelected(project.repoId)}
          >
            {project.repoId}
          </Button>
        ))}
      </div>
      {selected && <SelectedRoom repoId={selected} />}
    </section>
  );
}

function SelectedRoom({ repoId }: { repoId: string }) {
  const [state, setState] = useState<TeamState>(() => emptyRoomState(repoId));
  const [seq, setSeq] = useState(0);
  const [status, setStatus] = useState<FeedStatus>("connecting");

  useEffect(() => {
    let active = true;
    setState(emptyRoomState(repoId));
    setSeq(0);
    setStatus("connecting");

    const poll = () => {
      void fetchOwnedRoomState(repoId).then((next) => {
        if (!active) return;
        if (next) {
          setState(next);
          setSeq((current) => current + 1);
          setStatus("open");
        } else {
          setStatus("reconnecting");
        }
      });
    };
    poll();
    const interval = window.setInterval(poll, 2000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [repoId]);

  return (
    <div className="mt-6">
      <Dashboard snapshot={toSnapshot(state, seq, status)} />
    </div>
  );
}

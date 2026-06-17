import { useEffect, useMemo, useState } from "react";
import Dashboard from "./Dashboard";
import { createFeedFromLocation, type FeedSnapshot } from "./feed";
import Landing from "./Landing";
import NarratedDemo from "./NarratedDemo";

export default function App() {
  const feed = useMemo(() => createFeedFromLocation(window.location), []);
  const [snapshot, setSnapshot] = useState<FeedSnapshot>(feed.initial);

  useEffect(() => feed.subscribe(setSnapshot), [feed]);

  return (
    <div className="min-h-screen overflow-x-hidden">
      <Landing mode={snapshot.mode} />
      {snapshot.mode === "demo" ? <NarratedDemo /> : <Dashboard snapshot={snapshot} />}
      <footer className="mt-8 border-t border-border/60">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-8 text-sm text-muted-foreground sm:px-6 lg:px-8">
          <span>MIT license</span>
          <span>Built by Prince Kumar</span>
        </div>
      </footer>
    </div>
  );
}

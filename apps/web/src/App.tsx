import { useEffect, useMemo, useState } from "react";
import Dashboard from "./Dashboard";
import { createFeedFromLocation, type FeedSnapshot } from "./feed";
import Landing from "./Landing";

export default function App() {
  const feed = useMemo(() => createFeedFromLocation(window.location), []);
  const [snapshot, setSnapshot] = useState<FeedSnapshot>(feed.initial);

  useEffect(() => feed.subscribe(setSnapshot), [feed]);

  return (
    <div className="min-h-screen">
      <Landing mode={snapshot.mode} />
      <Dashboard snapshot={snapshot} />
    </div>
  );
}

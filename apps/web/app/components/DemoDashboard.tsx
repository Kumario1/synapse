"use client";

import { useEffect, useMemo, useState } from "react";
import Dashboard from "../../src/Dashboard";
import { createDemoFeed, type FeedSnapshot } from "../../src/feed";

export default function DemoDashboard() {
  const feed = useMemo(() => createDemoFeed(), []);
  const [snapshot, setSnapshot] = useState<FeedSnapshot>(feed.initial);

  useEffect(() => feed.subscribe(setSnapshot), [feed]);

  return <Dashboard snapshot={snapshot} />;
}

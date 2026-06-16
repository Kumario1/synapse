import type { TeamState } from "@synapse/protocol";
import { demoFrames } from "./fixture";

export type FeedMode = "demo" | "live";
export type FeedStatus = "connecting" | "open" | "reconnecting" | "closed" | "error";

export interface FeedSnapshot {
  mode: FeedMode;
  status: FeedStatus;
  state: TeamState;
  seq: number;
  message: string;
}

export type FeedListener = (snapshot: FeedSnapshot) => void;

export interface Feed {
  initial: FeedSnapshot;
  subscribe(listener: FeedListener): () => void;
}

export interface LiveFeedConnection {
  id: string;
  serverUrl: string;
  repoId: string;
}

export type LiveFeedConfig =
  | {
      server: string;
      repoId: string;
      token: string;
    }
  | {
      needsToken: true;
    };

interface StateSnapshotEnvelope {
  type: "state.snapshot";
  payload: {
    teamState: TeamState;
    seq: number;
  };
}

const demoIntervalMs = 2600;

export function createFeedFromLocation(location: Location): Feed {
  const searchParams = new URLSearchParams(location.search);
  const server = searchParams.get("server");
  if (!server) {
    return createDemoFeed();
  }

  return createLiveFeed({
    server,
    repoId: searchParams.get("repoId") ?? "synapse",
    token: searchParams.get("token")
  });
}

export function createDemoFeed(): Feed {
  let index = 0;
  let timer: number | undefined;
  let current: FeedSnapshot = {
    mode: "demo",
    status: "open",
    state: demoFrames[0],
    seq: 1,
    message: "Seeded demo feed"
  };
  const listeners = new Set<FeedListener>();

  const publish = () => {
    index = (index + 1) % demoFrames.length;
    current = {
      ...current,
      state: demoFrames[index],
      seq: current.seq + 1
    };
    for (const listener of listeners) {
      listener(current);
    }
  };

  return {
    initial: current,
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      if (timer === undefined) {
        timer = window.setInterval(publish, demoIntervalMs);
      }

      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== undefined) {
          window.clearInterval(timer);
          timer = undefined;
        }
      };
    }
  };
}

export function createLiveFeed(options: { server: string; repoId: string; token: string | null }): Feed {
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let closedByCaller = false;
  let attempts = 0;
  let current: FeedSnapshot = {
    mode: "live",
    status: "connecting",
    state: demoFrames[0],
    seq: 0,
    message: "Connecting to Synapse server"
  };
  const listeners = new Set<FeedListener>();

  const publish = (patch: Partial<FeedSnapshot>) => {
    current = { ...current, ...patch };
    for (const listener of listeners) {
      listener(current);
    }
  };

  const connect = () => {
    publish({ status: attempts === 0 ? "connecting" : "reconnecting", message: "Opening WebSocket" });
    const url = buildSocketUrl(options);
    socket = new WebSocket(url);

    socket.addEventListener("open", () => {
      attempts = 0;
      publish({ status: "open", message: "Live Synapse feed connected" });
    });

    socket.addEventListener("message", (event) => {
      const envelope = parseSnapshot(event.data);
      if (!envelope) {
        return;
      }
      publish({
        status: "open",
        state: envelope.payload.teamState,
        seq: envelope.payload.seq,
        message: "Received state.snapshot"
      });
    });

    socket.addEventListener("error", () => {
      publish({ status: "error", message: "WebSocket error" });
    });

    socket.addEventListener("close", () => {
      if (closedByCaller) {
        publish({ status: "closed", message: "Live feed closed" });
        return;
      }
      attempts += 1;
      const delay = Math.min(10_000, 500 * 2 ** Math.min(attempts, 5));
      publish({ status: "reconnecting", message: `Reconnecting in ${Math.round(delay / 1000)}s` });
      reconnectTimer = window.setTimeout(connect, delay);
    });
  };

  return {
    initial: current,
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      if (listeners.size === 1) {
        closedByCaller = false;
        connect();
      }

      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          closedByCaller = true;
          if (reconnectTimer !== undefined) {
            window.clearTimeout(reconnectTimer);
          }
          socket?.close();
        }
      };
    }
  };
}

export function resolveLiveFeedConfig(options: {
  connection: LiveFeedConnection;
  token: string | null;
}): LiveFeedConfig {
  if (!options.token) {
    return { needsToken: true };
  }
  return {
    server: options.connection.serverUrl,
    repoId: options.connection.repoId,
    token: options.token
  };
}

export function buildSocketUrl(options: { server: string; repoId: string; token: string | null }) {
  const url = new URL(options.server);
  url.searchParams.set("repoId", options.repoId);
  if (options.token) {
    url.searchParams.set("token", options.token);
  }
  return url.toString();
}

function parseSnapshot(raw: unknown): StateSnapshotEnvelope | null {
  if (typeof raw !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StateSnapshotEnvelope>;
    if (parsed.type !== "state.snapshot" || !parsed.payload?.teamState) {
      return null;
    }
    return parsed as StateSnapshotEnvelope;
  } catch {
    return null;
  }
}

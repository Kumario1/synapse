"use client";

import { FormEvent, useEffect, useState } from "react";
import Dashboard from "../../src/Dashboard";
import {
  createLiveFeed,
  resolveLiveFeedConfig,
  type Feed,
  type FeedSnapshot,
  type LiveFeedConnection
} from "../../src/feed";

interface SavedConnection extends LiveFeedConnection {
  label: string;
  createdAt: string;
  updatedAt: string;
}

const emptyForm = {
  label: "",
  serverUrl: "",
  repoId: ""
};

export default function ConnectionDashboard({ userId }: { userId: string }) {
  const [connections, setConnections] = useState<SavedConnection[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [selected, setSelected] = useState<SavedConnection | null>(null);
  const [needsToken, setNeedsToken] = useState<SavedConnection | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [feed, setFeed] = useState<Feed | null>(null);
  const [snapshot, setSnapshot] = useState<FeedSnapshot | null>(null);
  const [message, setMessage] = useState("Loading saved connections");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/connections")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load connections: ${response.status}`);
        }
        return (await response.json()) as SavedConnection[];
      })
      .then((rows) => {
        if (!cancelled) {
          setConnections(rows);
          setMessage(rows.length ? "Select a connection to open a live room" : "Add a connection to start");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : "Failed to load connections");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!feed) {
      return undefined;
    }
    setSnapshot(feed.initial);
    return feed.subscribe(setSnapshot);
  }, [feed]);

  async function addConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("Saving connection");
    const response = await fetch("/api/connections", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(form)
    });

    if (!response.ok) {
      setMessage(`Connection was not saved: ${response.status}`);
      return;
    }

    const row = (await response.json()) as SavedConnection;
    setConnections((current) => [row, ...current]);
    setForm(emptyForm);
    setMessage("Connection saved. Enter its server token on this device.");
    selectConnection(row);
  }

  function selectConnection(connection: SavedConnection) {
    setSelected(connection);
    const storedToken = window.localStorage.getItem(localTokenKey(connection.id));
    openConnection(connection, storedToken);
  }

  function saveToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!needsToken || !tokenInput.trim()) {
      return;
    }
    window.localStorage.setItem(localTokenKey(needsToken.id), tokenInput.trim());
    openConnection(needsToken, tokenInput.trim());
    setTokenInput("");
  }

  function openConnection(connection: SavedConnection, storedToken: string | null) {
    const config = resolveLiveFeedConfig({ connection, token: storedToken });
    if ("needsToken" in config) {
      setNeedsToken(connection);
      setFeed(null);
      setSnapshot(null);
      setMessage("Enter the server token for this device");
      return;
    }

    setNeedsToken(null);
    setMessage(`Opening ${connection.label}`);
    setFeed(createLiveFeed(config));
  }

  return (
    <main className="dashboard-shell">
      <section className="dashboard-sidebar" aria-label="Saved connections">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1>Your Synapse connections</h1>
          <p>Signed in as GitHub account {userId}.</p>
        </div>

        <form className="connection-form" onSubmit={addConnection}>
          <label>
            Label
            <input
              required
              value={form.label}
              onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
              placeholder="Production room"
            />
          </label>
          <label>
            Server URL
            <input
              required
              value={form.serverUrl}
              onChange={(event) => setForm((current) => ({ ...current, serverUrl: event.target.value }))}
              placeholder="wss://synapse.example.com"
            />
          </label>
          <label>
            Repo ID
            <input
              required
              value={form.repoId}
              onChange={(event) => setForm((current) => ({ ...current, repoId: event.target.value }))}
              placeholder="owner/repo"
            />
          </label>
          <button type="submit">Add connection</button>
        </form>

        <div className="connection-list">
          {connections.map((connection) => (
            <button
              className={selected?.id === connection.id ? "connection-row connection-row--active" : "connection-row"}
              key={connection.id}
              onClick={() => selectConnection(connection)}
              type="button"
            >
              <strong>{connection.label}</strong>
              <span>{connection.repoId}</span>
              <small>{connection.serverUrl}</small>
            </button>
          ))}
        </div>

        {needsToken ? (
          <form className="connection-form" onSubmit={saveToken}>
            <label>
              Server token
              <input
                required
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                placeholder={`Token for ${needsToken.label}`}
                type="password"
              />
            </label>
            <button type="submit">Save on this device</button>
          </form>
        ) : null}

        <p className="dashboard-message">{message}</p>
      </section>

      <section className="dashboard-stage" aria-label="Live dashboard">
        {snapshot ? (
          <Dashboard snapshot={snapshot} />
        ) : (
          <div className="empty dashboard-empty">
            Select a saved connection and enter its server token to open the live room.
          </div>
        )}
      </section>
    </main>
  );
}

function localTokenKey(id: string) {
  return `synapse.connection.${id}.token`;
}

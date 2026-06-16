"use client";

import type { FeedMode } from "./feed";

export default function Landing({ mode }: { mode: FeedMode }) {
  return (
    <header className="landing">
      <nav className="nav" aria-label="Primary">
        <a href="#top" className="brand">Synapse</a>
        <a href="#dashboard">Dashboard</a>
      </nav>
      <section className="hero" id="top">
        <div className="hero__copy">
          <p className="eyebrow">A realtime coordination layer for teams using coding agents.</p>
          <h1>Synapse</h1>
          <p>
            Agents still write the code. Synapse gives them current team context before they edit,
            then records contract-level changes after they edit, so other agents can avoid collisions.
          </p>
          <div className="hero__actions">
            <a href="#dashboard">See it live ↓</a>
            <span>{mode === "demo" ? "Seeded demo" : "Live server"}</span>
          </div>
        </div>
        <div className="hero__visual" aria-hidden="true">
          <div className="orbit orbit--one" />
          <div className="orbit orbit--two" />
          <div className="terminal">
            <span>state.snapshot</span>
            <strong>demo/playground</strong>
            <em>alice -&gt; server -&gt; loadRoom</em>
          </div>
        </div>
      </section>
      <section className="feature-strip" aria-label="Highlights">
        <article>
          <span>01</span>
          <strong>Online members</strong>
          <p>See which agents are active, idle, or finished in the shared room.</p>
        </article>
        <article>
          <span>02</span>
          <strong>Edit signals</strong>
          <p>Locks and contract deltas reveal contested symbols before agents collide.</p>
        </article>
        <article>
          <span>03</span>
          <strong>Data-flow graph</strong>
          <p>Watch sessions flow through the server into the symbols currently changing.</p>
        </article>
        <article>
          <span>04</span>
          <strong>Commits and PRs</strong>
          <p>Connect room activity to pushes and repository events as work ships.</p>
        </article>
      </section>
      <footer className="footer">
        <span>MIT license</span>
        <span>Built by Prince Kumar</span>
      </footer>
    </header>
  );
}

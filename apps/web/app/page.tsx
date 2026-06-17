import NarratedDemo from "./components/NarratedDemo";

const features = [
  ["Contract-level conflicts", "Classifies real before/after signature changes instead of treating every file overlap as equal."],
  ["Polyglot analyzers", "Extracts TypeScript contracts in-process, with Python and Go sidecars for the same conflict engine."],
  ["Deterministic first", "Keeps detection deterministic, with optional LLM analysis allowed to raise severity but never downgrade it."],
  ["Claude Code hooks", "Installs pre-edit, post-edit, and session-start hooks so checks happen in the editing flow."],
  ["Any-agent onboarding", "Connects Cursor, VS Code/Copilot, Gemini CLI, Windsurf, and MCP clients with the same guidance."],
  ["MCP adapter", "Exposes daemon tools and read-only context resources through a stdio MCP server."],
  ["Team briefings", "Turns warm daemon state and GitHub history into concise team and PR handoffs."],
  ["Memory search", "Answers coordination questions with cited durable team-state sources."],
  ["Onboarding briefing", "Gives first-session agents a full team digest plus cited decision history."],
  ["Durable state", "Persists sessions, locks, deltas, pushes, events, resolutions, summaries, and feedback."],
  ["Seamless multi-machine", "Derives repo identity from git remotes and diagnoses setup gaps with doctor checks."],
  ["Resilient channel", "Reconnects with backoff, flushes an offline outbox, and detects dead sockets."],
  ["Observable", "Emits structured logs and aggregate Prometheus counters without repo content."],
  ["Ship anywhere", "Runs from the npm CLI package or a Dockerized self-hosted server with project keys."]
] as const;

const steps = [
  ["Check", "The next edit is compared against current room state before the agent writes."],
  ["Edit", "Agents keep working locally while Synapse tracks members, locks, branches, and intent."],
  ["Report", "Post-edit contract deltas and repo events refresh the room for everyone else."]
] as const;

export default function Page() {
  return (
    <>
      <header className="landing">
        <nav className="nav" aria-label="Primary">
          <a href="#top" className="brand">
            Synapse
          </a>
          <div className="nav__links">
            <a href="#how-it-works">How it works</a>
            <a href="#features">Features</a>
            <a href="#dashboard">Demo</a>
            <a href="/login">Log in</a>
          </div>
        </nav>
        <section className="hero" id="top">
          <div className="hero__copy">
            <p className="eyebrow">A realtime coordination layer for teams using coding agents.</p>
            <h1>Synapse</h1>
            <p>
              Agents still write the code. Synapse gives them current team context before they edit,
              then records contract-level changes after they edit, so other agents can avoid
              collisions.
            </p>
            <div className="hero__actions">
              <a href="/login">Get Started</a>
              <a href="#dashboard">See Demo</a>
              <span>Seeded demo</span>
            </div>
          </div>
          <div className="hero__visual" aria-label="Synapse coordination snapshot">
            <div className="signal-map">
              <div className="signal-map__row">
                <span>alice</span>
                <strong>src/room.ts#loadRoom</strong>
                <em>editing</em>
              </div>
              <div className="signal-map__row signal-map__row--server">
                <span>server</span>
                <strong>state.snapshot</strong>
                <em>seq 42</em>
              </div>
              <div className="signal-map__row">
                <span>bob</span>
                <strong>src/sidebar.ts#renderRoom</strong>
                <em>checking</em>
              </div>
              <div className="signal-map__trace" />
            </div>
          </div>
        </section>
      </header>
      <main>
        <section className="section problem" id="problem">
          <div>
            <p className="eyebrow">The problem</p>
            <h2>Agents collide when their context is stale.</h2>
          </div>
          <p>
            Modern coding agents can work in parallel, but they still discover each other's
            contract changes too late. Synapse gives every agent a live room view before edits
            start and records contract-level deltas after edits land.
          </p>
        </section>

        <section className="section" id="how-it-works">
          <div className="section__head">
            <p className="eyebrow">How it works</p>
            <h2>Check → edit → report.</h2>
          </div>
          <div className="steps">
            {steps.map(([title, body], index) => (
              <article key={title}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="section" id="features">
          <div className="section__head">
            <p className="eyebrow">Features</p>
            <h2>Everything in the room stays current.</h2>
          </div>
          <div className="features">
            {features.map(([title, body]) => (
              <article key={title}>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="section demo-section" aria-labelledby="demo-title">
          <div className="section__head">
            <p className="eyebrow">See it live</p>
            <h2 id="demo-title">A collision, caught in four steps.</h2>
          </div>
          <NarratedDemo />
        </section>

        <section className="section cta">
          <div>
            <p className="eyebrow">Get Started</p>
            <h2>Save your self-hosted servers and open your live room.</h2>
          </div>
          <a href="/login">Continue with GitHub</a>
        </section>
      </main>
      <footer className="footer">
        <span>MIT license</span>
        <span>Built by Prince Kumar</span>
      </footer>
    </>
  );
}

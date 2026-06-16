import { redirect } from "next/navigation";
import { auth } from "../../auth";
import { AuthenticationRequired, requireUser } from "../../lib/auth-guard";

const commands = [
  ["join", "Write local room config, install Claude Code hooks, and connect other agents."],
  ["connect", "Wire Cursor, VS Code/Copilot, Gemini CLI, Windsurf, and MCP clients."],
  ["whatsup", "Show the daemon's current team-state briefing."],
  ["why", "Search durable Synapse memory with cited sources."],
  ["onboard", "Give a first-session briefing with team digest and decisions."],
  ["doctor", "Diagnose identity, reachability, auth, protocol, and live peers."],
  ["demo", "Run the one-command sandboxed conflict demo."]
] as const;

export default async function GetStartedPage() {
  const session = await auth();
  try {
    requireUser(session);
  } catch (error) {
    if (error instanceof AuthenticationRequired) {
      redirect("/login");
    }
    throw error;
  }

  return (
    <main className="docs-page">
      <section className="section docs-hero">
        <p className="eyebrow">Get Started</p>
        <h1>Install the CLI, start a room, connect your agents.</h1>
        <p>
          Synapse stays self-hosted. The website saves connection metadata for your account;
          your browser still connects directly to your server.
        </p>
      </section>

      <section className="section docs-grid">
        <article>
          <h2>Install</h2>
          <pre>
            <code>npm install -g @kumario/synapse</code>
          </pre>
          <p>
            Requires Node.js 20.19.0+ and npm 11.4.1. Python 3.10+ and Go 1.22+
            are optional for analyzing `.py` and `.go` files.
          </p>
        </article>

        <article>
          <h2>Start local coordination</h2>
          <pre>
            <code>synapse up</code>
          </pre>
          <p>
            Resolves identity from the git remote, joins the room, preflights, and starts
            the daemon for the current worktree.
          </p>
        </article>

        <article>
          <h2>Host for teammates</h2>
          <pre>
            <code>synapse up --serve --tunnel</code>
          </pre>
          <p>
            Starts the server, exposes a public WebSocket tunnel, writes `.synapse/team.json`,
            and prints the teammate command plus the server credential.
          </p>
        </article>
      </section>

      <section className="section">
        <div className="section__head">
          <p className="eyebrow">Command sheet</p>
          <h2>Daily coordination commands.</h2>
        </div>
        <div className="command-list">
          {commands.map(([command, description]) => (
            <article key={command}>
              <code>synapse {command}</code>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section cta">
        <div>
          <p className="eyebrow">Connect your server</p>
          <h2>Save the server URL and repo id for this account.</h2>
        </div>
        <a href="/dashboard">Open dashboard</a>
      </section>
    </main>
  );
}

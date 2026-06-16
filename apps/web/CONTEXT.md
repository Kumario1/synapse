# Web surface — context

Glossary for the Synapse website (`apps/web`). This is the marketing + onboarding +
dashboard surface, distinct from the self-hosted coordination **Server** that users run
via the CLI.

## Glossary

### Account
A website login, identified by a **GitHub** identity (GitHub OAuth, the only sign-in
method). An Account exists to (1) gate the website and (2) own a synced list of
**Connections**. It does **not** host or proxy anything — Synapse stays self-hosted.
Distinct from a **Session** in the coordination domain (an agent's editing session on a
Server); when ambiguous, say "website Account" vs "agent Session".

### Connection
A saved profile pointing at one self-hosted **Server**: a human label, the `wss://`
server URL, and the `repoId`. Connection **metadata is synced** in the website database,
per Account. A Connection deliberately does **not** include the **Token** — see Token.

### Token
The per-server secret that authenticates a browser (or CLI) to a **Server**. It grants
read access to a room's live coordination state. The website **never stores the Token**:
it lives only in the browser (localStorage), re-entered once per device. A breach of the
website exposes no Tokens.

### Server
A self-hosted Synapse coordination server (`apps/server`), run by the user via the CLI.
The browser connects **directly** to it over WebSocket — the website is never in the
path of live coordination traffic.

### Dashboard
The live view of a room's `TeamState` (members, edit locks, contract deltas, data-flow
graph, commits/PRs). Two feeds drive it:
- **Demo feed** — a seeded, public, no-login loop used for pitching on the landing page.
- **Live feed** — a real WebSocket to a user's **Server**, selected from a saved
  **Connection** plus its locally-held **Token**.

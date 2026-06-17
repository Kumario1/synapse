# apps/web — Context

The marketing + live-room site for Synapse. Two jobs: (1) explain what Synapse
is, (2) show the coordination room in action.

## Glossary

Data terms come from `@synapse/protocol`; the entries below are the
web-presentation vocabulary we use to talk about the UI.

- **Owner** — a human who has signed in (GitHub/Google OAuth) and claimed one or more Projects. Owners are the *only* humans in the model; the people "on a session" are AI agents, never human teammates.
- **Project** — an Owner-facing name for a repo's Room: the thing an Owner claims, configures, and watches from the dashboard. One Project = one Room = one repo.
- **Room** — a single coordination space for one repo. The dashboard renders one room.
- **Session** — an **AI agent** connected to a room (member, agent type, branch, task, files). NOT a human. Source: protocol `Session`. "Who is on the session" = which agent sessions are active in a Project's Room.
- **Kick** — an Owner-initiated **force-end** of an agent Session: the server marks it `ended`, closes its socket, releases its edit locks, and broadcasts. A reconnecting daemon returns as a *fresh* session (kick is an interrupt, not a ban — banning is deferred). Authorized by the Owner's cookie session + GitHub push-access; travels over an authenticated HTTP route, never the machine WS protocol. Net-new capability.
- **Edit lock** — a session's claim on a symbol it's editing. Source: protocol `EditLock`.
- **Contract delta** — a recorded before→after change to a symbol's contract, classified breaking/compatible/etc. Source: protocol `ContractDelta`.
- **Contested symbol** — a symbol two or more sessions are touching at once; the moment Synapse exists to surface. Derived in `derive.ts`.
- **Ship trail** — the page's name for recent pushes + repo events (the "work landed" stream).
- **Demo (narrated step-through)** — the scripted 4-frame conflict story (Alice & Bob collide on `loadRoom`), shown as a guided walkthrough with a caption per step, highlighting only the panel that changed. Used when `mode === "demo"`.
- **Live grid** — the cleaned-up 4-panel dashboard shown when a real server is connected (`mode === "live"`). Same panels, no scripted narration.

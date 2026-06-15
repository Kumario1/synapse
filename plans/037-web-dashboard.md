# Plan 037: Add a web dashboard + landing page (`apps/web`) that visualizes a live Synapse room

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 6781b81..HEAD -- packages/protocol/src/index.ts apps/server/src/index.ts package.json turbo.json`
> If `packages/protocol/src/index.ts` changed, re-check the type excerpts in
> "Current state" against the live file before writing the fixture and the
> rendering code; on a mismatch treat it as a STOP condition. Changes to
> `apps/server/src/index.ts` only matter for the optional live feed (Step 6) —
> re-confirm the WebSocket query params there if it drifted.

> **Execution model for `improve execute`**: use a low/medium-reasoning worker
> only as the code executor. Use an xhigh-reasoning reviewer/main thinker to
> check the worker's code, completed work, verification evidence, and PR-ready
> diff against this plan before approving anything. The reviewer, not the
> executor, owns `plans/README.md` status updates.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: LOW (new, isolated, read-only consumer app — touches no existing source)
- **Depends on**: none
- **Category**: direction (product surface / DX)
- **Planned at**: commit `6781b81`, 2026-06-15

## Why this matters

Synapse coordinates AI coding agents but is invisible: all its state (who is
online, who is editing which symbol, what just shipped) lives in a server's
JSON and a CLI. The owner wants a website that *shows the product working* —
the connections between daemons and the server, the live data flow, who is
sending a signal, and the latest commits — usable both as a public "show off"
page and as a real dashboard when pointed at a running server.

This is cheap to build because **the server already exposes everything a
dashboard needs** and **no server changes are required** (see "Current state").
A previous advisory pass deferred this dashboard ("defer until revenue");
the owner has now explicitly reversed that and chosen the shape below.

What lands: a new `apps/web` workspace — a Vite + React single-page app,
deployable to Vercel as a static site — with a marketing landing page on top
and, below it, a live dashboard with four views (online members, edit-signals,
an animated data-flow graph, and a commits/PRs feed). By default it plays a
**seeded looping demo** so a public visitor always sees it "alive"; a
`?server=wss://…` URL parameter switches it to a real Synapse server over
WebSocket.

## Current state

This app is **new**; the facts below are what it consumes and the conventions
it must match. Nothing in existing source is modified.

### The data source already exists (no server change needed)

`apps/server/src/index.ts` serves a WebSocket on the same port as HTTP. On
connect and on every state change it sends a `state.snapshot` message to
clients that did **not** negotiate protocol v2. Relevant excerpts:

- Connection handler (`apps/server/src/index.ts:295-322`) sends a snapshot on
  open: `envelope("state.snapshot", { teamState: state, seq: ... })`.
- `verifyClient` (`apps/server/src/index.ts:219-247`) reads `repoId`, `v`, and
  `token` from the WS URL query string. In **open** auth mode (no
  `SYNAPSE_AUTH_TOKEN` / `SYNAPSE_MASTER_SECRET` set on the server) any client
  may connect with no token.
- `broadcastStateChange` (`apps/server/src/index.ts:653-665`): clients with
  negotiated `version >= 2` get incremental `state.delta`; **everyone else
  gets a full `state.snapshot`**. So a client that connects **without a `v`
  query param** (treated as v1) receives a full snapshot on connect and on
  every change — no delta reconstruction needed. This is what the dashboard
  does; it is the lazy, correct choice for a read-only viewer.

So the live feed = open a browser `WebSocket` to
`wss://<server>/?repoId=<repoId>` (plus `&token=<t>` only if the server runs
with auth), then render the `teamState` from each `state.snapshot` message.
Browser WebSocket connections are **not** subject to CORS, so no server CORS
header is required. (A cross-origin `fetch('/state')` *would* need CORS — we
do not use it; see Out of scope.)

There is also `GET /health` (returns `{ ok, service, version, protocolVersion }`)
which the dashboard may ping to show a server's version, but it is optional.

### The exact wire/state types the dashboard renders

From `packages/protocol/src/index.ts` (import these as **types only** — see
Step 2). Inlined here so the fixture and rendering match exactly:

```ts
// packages/protocol/src/index.ts
export interface SymbolId { raw: string }            // e.g. { raw: "ts:src/widget.ts#area" }

export type AgentType = "claude-code" | "cursor" | "cline" | "aider" | "other";

export interface Session {
  id: string;
  repoId: string;
  memberId: string;
  memberLogin?: string;
  agentType: AgentType;
  filesOpen: string[];
  filesEditing: string[];
  lastTask: string | null;
  startedAt: string;   // ISO
  lastSeen: string;    // ISO
  status: "active" | "idle" | "ended";
  branch?: string;
}

export interface EditLock {
  sessionId: string;
  symbolId: SymbolId;
  filePath: string;
  acquiredAt: string;  // ISO
  ttlSec: number;      // edit.intent locks are created with ttlSec: 90
}

export interface SignatureParam {
  name: string;
  type: string | null;
  optional: boolean;
}

export interface Signature {
  params: SignatureParam[];
  returns: string | null;
  generics?: string[];
  raw: string;
}

export type ChangeKind =
  | "added"
  | "removed"
  | "renamed"
  | "moved"
  | "signature_changed"
  | "visibility_changed";

export interface ContractDelta {
  id: string;
  repoId: string;
  sessionId: string;
  symbolId: SymbolId;
  changeKind: ChangeKind;      // e.g. "signature_changed"
  before: Signature | null;    // not rendered; keep null in the fixture
  after: Signature | null;
  summary: string;
  filePath: string;
  baseSha: string;
  dependents: SymbolId[];
  createdAt: string;           // ISO
  pushedAt: string | null;
}

export interface RecentPush {
  id: string;
  repoId: string;
  memberId: string;
  summary: string;
  filesAffected: string[];
  symbols?: SymbolId[];
  sha: string;
  pushedAt: string;   // ISO
  branch?: string;
}

export type RepoEventKind = "pull_request" | "pull_request_review" | "issue_comment";
export interface RecentRepoEvent {
  id: string;
  repoId: string;
  kind: RepoEventKind;
  action: string;          // e.g. "opened"
  actor: string;
  title: string;
  number?: number;
  url?: string;
  summary: string;
  detail?: string;
  createdAt: string;       // ISO
}

export interface TeamState {
  repoId: string;
  sessions: Session[];
  editLocks: EditLock[];
  unpushedDeltas: ContractDelta[];
  recentPushes: RecentPush[];
  recentRepoEvents: RecentRepoEvent[];
  resolutions: unknown[];        // not rendered — keep []
  sessionSummaries: unknown[];   // not rendered in v1 — keep []
  conflictFeedback: unknown[];   // not rendered — keep []
}
```

The `state.snapshot` server message has the envelope shape
`{ v, type: "state.snapshot", id, ts, payload: { teamState: TeamState, seq: number } }`.

### Repo conventions to match

- **Monorepo**: npm workspaces (`apps/*`, `packages/*`) + turbo. Root
  `package.json` scripts: `build` = `turbo run build`, `typecheck` =
  `turbo run typecheck`, `test` = `turbo run test`. A new workspace under
  `apps/` is auto-discovered by turbo; you do **not** edit `turbo.json`.
- **TypeScript**: ESM (`"type": "module"`), `target: ES2022`. The root
  `tsconfig.base.json` defines `paths` so `@synapse/protocol` resolves to
  `packages/protocol/src/index.ts` for typechecking.
- **Tests**: Node's built-in runner, `node:test` + `node:assert/strict`. Example
  idiom — `packages/protocol/src/negotiation.test.ts:1-12`:
  ```ts
  import assert from "node:assert/strict";
  import { test } from "node:test";
  import { negotiateProtocolVersion } from "./index.js";
  test("...", () => { assert.deepEqual(/* ... */); });
  ```
  Other workspaces compile first and test `dist`. **This app diverges**: it is
  a Vite app with no `dist` test output, so it tests **source** with `tsx`
  (already a root devDependency): `node --import tsx --test src/*.test.ts`.
- **Node version**: `.nvmrc` pins `20.19.2`; `engines.node` is `>=20.19.0`.

### Prior art — the old landing page (source lost)

`Synapse/dist/index.html` is the previously deployed marketing page (a
Vite+React build; **source is gone**, only the built bundle remains). Do **not**
depend on it or try to reverse it. Reuse only its visual identity for
continuity:

- Fonts: **Fraunces** (display) + **JetBrains Mono** (mono), loaded from Google
  Fonts exactly as in `Synapse/dist/index.html:7-9`.
- Dark palette (from the old CSS, use these as CSS variables):
  `--bg:#0a0a0c; --bg-elevated:#0e0e11; --panel:#131316; --bg-2:#16161a;`
  `--border:#16161a; --border-strong:#5a5853; --text:#e8e6df; --text-muted:#8a8780;`
  `--text-dim:#5a5853; --accent:#b88a5f; --signal:#6ba3c7; --success:#8ab87a;`
  `--danger:#d47474;`

`Synapse/.vercel/project.json` is the old Vercel project link — repointing it
to the new app vs. creating a new project is the owner's call (Maintenance).

## Commands you will need

| Purpose         | Command                                                        | Expected on success                         |
|-----------------|---------------------------------------------------------------|---------------------------------------------|
| Install         | `npm install`                                                 | exit 0 (adds the new web deps)              |
| Typecheck (all) | `npm run typecheck`                                           | exit 0, no errors                           |
| Typecheck (web) | `npm run typecheck --workspace @synapse/web`                  | exit 0                                       |
| Build (all)     | `npm run build`                                               | exit 0; `apps/web/dist/index.html` created  |
| Build (web)     | `npm run build --workspace @synapse/web`                      | exit 0                                       |
| Test (web)      | `npm test --workspace @synapse/web`                           | all pass                                     |
| Dev server      | `npm run dev --workspace @synapse/web`                        | Vite serves on `http://localhost:5173`      |

## Suggested executor toolkit

- This repo ships React/Vercel skills. If available in your environment, invoke
  `vercel-react-best-practices` (or `vercel:react-best-practices`) when writing
  the React components in Steps 5–7, and `web-design-guidelines` to sanity-check
  accessibility/UX before finishing.
- Do **not** run any `vercel` deploy command — deployment is the owner's step
  (see Maintenance notes). Your job ends at a green local build + tests.

## Scope

**In scope** (create only — all new files under `apps/web/`):

- `apps/web/package.json`
- `apps/web/tsconfig.json`
- `apps/web/tsconfig.node.json`
- `apps/web/vite.config.ts`
- `apps/web/index.html`
- `apps/web/.gitignore`
- `apps/web/src/main.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/theme.css`
- `apps/web/src/feed.ts`
- `apps/web/src/fixture.ts`
- `apps/web/src/derive.ts`
- `apps/web/src/derive.test.ts`
- `apps/web/src/Landing.tsx`
- `apps/web/src/Dashboard.tsx`
- `apps/web/src/panels.tsx`
- `apps/web/src/FlowGraph.tsx`

You will also modify, at the repo root, **only** the lockfile via `npm install`
(`package-lock.json` changes automatically — that is expected and allowed).

**Out of scope** (do NOT touch):

- `apps/server/**`, `apps/cli/**`, `packages/**` — the dashboard is a pure
  read-only consumer. It must require **zero** changes to the server or
  protocol. If you find yourself wanting to edit the server (e.g. to add CORS),
  STOP — you are using `fetch` where you should use WebSocket.
- `turbo.json` — turbo auto-discovers the new workspace; no edit needed.
- Root `package.json` — do not add the web app's deps here; they live in
  `apps/web/package.json`. (npm workspaces hoist them automatically.)
- The old `Synapse/` directory — leave it untouched; do not import from it.
- Protocol-v2 delta handling, a real backend, auth UI, write actions of any
  kind. The dashboard never sends messages — it only receives snapshots.

## Git workflow

- Branch: `advisor/037-web-dashboard`
- Commit per logical unit (scaffold → feed/derive + tests → components →
  landing → polish). Message style matches `git log` (conventional commits,
  e.g. `feat(web): scaffold dashboard app`). Last commit on `main` for
  reference: `feat(server): attach authoritative peer locks to edit.intent ack`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Scaffold the workspace (package.json, tsconfigs, vite, index.html)

Create `apps/web/package.json`:

```json
{
  "name": "@synapse/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test src/*.test.ts"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@synapse/protocol": "*",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "vite": "^6.0.0"
  }
}
```

`@synapse/protocol` is a workspace dependency used **for types only** (Step 2);
`*` resolves to the local workspace. `tsx` and `typescript` are already root
devDependencies and are visible to the workspace via hoisting.

Create `apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true
  },
  "include": ["src", "vite.config.ts"]
}
```

If extending the base causes a conflict (e.g. base sets `noEmit: false` or a
`composite`/`outDir` the bundler config rejects and `tsc --noEmit` errors on
config rather than code), STOP and report the exact tsc config error — do not
silently drop `extends` (you would lose the `@synapse/protocol` path mapping).
A targeted fix is to add the path mapping locally instead:
`"paths": { "@synapse/protocol": ["../../packages/protocol/src/index.ts"] }`
under `compilerOptions`, then drop `extends`.

Create `apps/web/tsconfig.node.json` (for the Vite config file):

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["node"],
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["vite.config.ts"]
}
```

Create `apps/web/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Type-only imports of @synapse/protocol are erased at build time, so no
  // module resolution is needed for it. If a build ever fails resolving it,
  // uncomment the alias below.
  // resolve: { alias: { "@synapse/protocol": new URL("../../packages/protocol/src/index.ts", import.meta.url).pathname } },
});
```

Create `apps/web/.gitignore`:

```
dist
node_modules
```

Create `apps/web/index.html` (reuses the old page's fonts for continuity):

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Synapse — the coordination layer for AI coding agents</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600&family=JetBrains+Mono:wght@300;400;500&display=swap"
      rel="stylesheet"
    />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**Verify**: `npm install` → exit 0. Then
`test -f apps/web/package.json && echo OK` → `OK`.

### Step 2: Theme + React entry

Create `apps/web/src/theme.css` with the design tokens and base layout. Define
the CSS variables from "Prior art" on `:root`, set `body` to
`background: var(--bg); color: var(--text); font-family: "JetBrains Mono",
ui-monospace, monospace;`, and a display class using
`font-family: "Fraunces", serif;`. Add minimal layout primitives you will reuse:
a `.panel` card (`background: var(--panel); border: 1px solid var(--border);
border-radius: 10px; padding: 16px;`), a `.dot` status indicator, and a
`.mono-dim` muted text helper. Keep it lean — no CSS framework.

Create `apps/web/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./theme.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

**Verify**: `npm run typecheck --workspace @synapse/web` → exit 0 (it will pass
once App exists in Step 5; if you run it now expecting a missing-module error
for `./App.tsx`, that is fine — defer this verify to Step 5).

### Step 3: Pure derivations (`derive.ts`) + tests — do this before any UI

These are the testable heart of the data-flow visualization. Create
`apps/web/src/derive.ts`:

- `import type { TeamState, Session, EditLock } from "@synapse/protocol";`
  (type-only import — required so Vite erases it).
- `export function deriveContestedSymbols(state: TeamState): Set<string>` —
  a symbol's `raw` id is **contested** when two or more *distinct sessions*
  reference it across `editLocks` **and/or** `unpushedDeltas`. Implementation:
  build `Map<string, Set<string>>` from `symbolId.raw` → set of `sessionId`,
  iterating `state.editLocks` (use `lock.symbolId.raw`, `lock.sessionId`) and
  `state.unpushedDeltas` (use `delta.symbolId.raw`, `delta.sessionId`); return
  the set of raw ids whose session-set size is `>= 2`.
- `export interface FlowEdge { from: string; to: string; contested: boolean }`
- `export interface FlowGraph { sessions: Session[]; symbols: string[]; edges: FlowEdge[] }`
- `export function deriveGraph(state: TeamState): FlowGraph` —
  - `sessions` = `state.sessions.filter(s => s.status !== "ended")`.
  - `symbols` = the **distinct** `symbolId.raw` values appearing in
    `editLocks` or `unpushedDeltas` (a `string[]`, stable insertion order).
  - `edges`: for each non-ended session, an edge `{ from: session.id,
    to: "server", contested: false }`. For each symbol, an edge
    `{ from: "server", to: symbol, contested: contestedSet.has(symbol) }`.
  - Use `deriveContestedSymbols` for the `contested` flags.

Create `apps/web/src/derive.test.ts` modeled on the `node:test` idiom shown in
"Repo conventions". Note the test imports from `./derive.ts` **with the
extension** (tsx allows it). Cover:

1. **No contention**: a state with one session holding one lock → empty
   contested set; graph has 1 session→server edge and 1 server→symbol edge,
   `contested: false`.
2. **Contested symbol**: two sessions referencing the same `symbolId.raw` (one
   via `editLocks`, one via `unpushedDeltas`) → contested set contains that raw;
   the corresponding `server→symbol` edge has `contested: true`.
3. **Ended sessions excluded**: a `status: "ended"` session does not appear in
   `graph.sessions` nor produce a session→server edge.

Build the test inputs as full `TeamState` objects (all eight arrays present;
unused ones `[]`). Example minimal session/lock for the tests:

```ts
const sess = (id: string, status: Session["status"] = "active"): Session => ({
  id, repoId: "demo/playground", memberId: id, agentType: "claude-code",
  filesOpen: [], filesEditing: [], lastTask: null,
  startedAt: "2026-06-15T00:00:00.000Z", lastSeen: "2026-06-15T00:00:00.000Z",
  status,
});
const lock = (sessionId: string, raw: string): EditLock => ({
  sessionId, symbolId: { raw }, filePath: raw.split("#")[0].replace(/^ts:/, ""),
  acquiredAt: "2026-06-15T00:00:00.000Z", ttlSec: 90,
});
```

**Verify**: `npm test --workspace @synapse/web` → all 3 tests pass.

### Step 4: The feed abstraction (`feed.ts`) + seeded fixture (`fixture.ts`)

This is the seam between the seeded demo (default) and a real server.

Create `apps/web/src/feed.ts`:

```ts
import type { TeamState } from "@synapse/protocol";

export type FeedStatus = "seeded" | "connecting" | "live" | "error";
export interface Feed {
  subscribe(onState: (state: TeamState, status: FeedStatus) => void): () => void;
}

// Seeded feed: cycle a fixed array of snapshots on a timer, looping forever.
export function createSeededFeed(frames: TeamState[], intervalMs = 2500): Feed { /* ... */ }

// Live feed: open a browser WebSocket to a real server. Connect WITHOUT a `v`
// query param so the server always sends full `state.snapshot` messages
// (apps/server/src/index.ts:653-665). Parse each message; on
// `type === "state.snapshot"` call onState(msg.payload.teamState, "live").
// Reconnect on close with a simple capped backoff. Surface "connecting" /
// "error" status to the callback.
export function createLiveFeed(serverUrl: string, repoId: string, token?: string): Feed { /* ... */ }

// Choose the feed from the URL: `?server=wss://host:4010&repoId=foo&token=t`
// → live; otherwise seeded. Read with `new URLSearchParams(location.search)`.
export function createFeedFromLocation(frames: TeamState[]): Feed { /* ... */ }
```

Implementation notes:
- Seeded feed: `setInterval` advancing an index modulo `frames.length`, emit
  `frames[i]` with status `"seeded"`; emit `frames[0]` immediately on
  subscribe; return an unsubscribe that clears the interval.
- Live feed WS URL: `` `${serverUrl}/?repoId=${encodeURIComponent(repoId)}` ``
  plus `` `&token=${encodeURIComponent(token)}` `` only when `token` is set.
  Do not append `&v=...`. Parse with `JSON.parse(event.data)`; ignore any
  message whose `type` is not `"state.snapshot"`.
- Backoff: start 1000ms, double to a 15000ms cap, reset on a successful open.
  Stop reconnecting after the unsubscribe is called.

Create `apps/web/src/fixture.ts` — `export const DEMO_FRAMES: TeamState[]` — a
hand-authored scenario that loops to look alive. Tell this story across ~6
frames (each a **full** `TeamState`, `repoId: "demo/playground"`):

1. `alice` joins — one `active` session, `branch: "feat-rect"`,
   `lastTask: "make area() take a Rect"`, empty locks/deltas.
2. `bob` joins — second `active` session, `branch: "main"`,
   `lastTask: "add Rect support"`.
3. `alice` signals an edit — add an `EditLock` for
   `{ raw: "ts:src/widget.ts#area" }` (`ttlSec: 90`); set alice's
   `filesEditing: ["src/widget.ts"]`.
4. `alice` records a contract change — add a `ContractDelta` for that symbol
   (`changeKind: "modified"`, `summary: "area() now takes a Rect"`,
   `filePath: "src/widget.ts"`, `before: null`, `after: null`,
   `dependents: []`, `pushedAt: null`).
5. `bob` signals the **same** symbol — add a second `EditLock` from `bob` on
   `ts:src/widget.ts#area` → now **contested**.
6. A push lands + a PR opens — add a `RecentPush`
   (`sha: "a1b2c3d"`, `summary: "area() → Rect"`,
   `filesAffected: ["src/widget.ts"]`), clear the deltas/locks for that file,
   and add a `RecentRepoEvent` (`kind: "pull_request"`, `action: "opened"`,
   `number: 42`, `actor: "bob"`, `title: "Add Rect support"`,
   `summary: "Adds a Rect type and updates area()"`).

Keep timestamps as fixed ISO strings (relative "x ago" rendering, Step 6, is
computed against `Date.now()` so the labels stay live even with static data).
Reuse the same `SymbolId` raw across frames so the contested logic and the
graph line up.

**Verify**: `npm run typecheck --workspace @synapse/web` → exit 0 (confirms the
fixture matches the real `TeamState` type). If typecheck flags a missing field,
the type drifted — re-read `packages/protocol/src/index.ts` and fix the fixture
(do **not** loosen the types).

### Step 5: App shell + dashboard wiring (`App.tsx`, `Dashboard.tsx`)

`apps/web/src/App.tsx`:
- Renders `<Landing />` then `<Dashboard />` in a single scrolling page (no
  router — the landing's CTA is an anchor link to `#dashboard`).
- Owns the feed: `const feed = useMemo(() => createFeedFromLocation(DEMO_FRAMES), [])`.
  Subscribe in a `useEffect`, store `{ state, status }` in `useState`, unsubscribe
  on cleanup. Pass `state` and `status` down to `<Dashboard />`.

`apps/web/src/Dashboard.tsx`:
- `id="dashboard"`. A header showing the `repoId`, the live/seeded status (a
  `.dot` colored `--success` for `live`, `--accent` for `seeded`,
  `--danger` for `error`), and the session count.
- A responsive grid laying out, from `state`:
  `<FlowGraph state={state} />` (the centerpiece, spanning the top),
  then `<OnlinePanel />`, `<SignalsPanel />`, `<CommitsPanel />` (Step 6).
- If `state` is null (before first frame), render a small "connecting…" placeholder.

**Verify**: `npm run dev --workspace @synapse/web`, open `http://localhost:5173`
→ the page renders with the landing on top and the dashboard cycling through the
seeded frames below; no console errors. (If you are headless, skip the visual
check here and rely on the build/test gates in Done criteria.)

### Step 6: The four panels (`panels.tsx`)

Create `apps/web/src/panels.tsx` exporting three components. All take
`{ state }: { state: TeamState }`. Use the design tokens; render the live
fields named below; format ISO timestamps as relative ("3s ago") against
`Date.now()` with a tiny local helper (no date library).

- `OnlinePanel` — **"Who's online"**: a list of `state.sessions` where
  `status !== "ended"`. Per row: a `.dot` (`--success` if `status === "active"`,
  `--text-dim` if `idle`), `memberLogin ?? memberId`, `agentType`, `branch`
  (if present), and `lastTask` (muted). Show "No one online" when empty.
- `SignalsPanel` — **"Signals / edit-locks"**: a list of `state.editLocks`.
  Per row: the holder (resolve `lock.sessionId` → its session's
  `memberLogin ?? memberId`), an arrow, `lock.symbolId.raw`, and a TTL
  countdown badge = `lock.ttlSec - secondsSince(lock.acquiredAt)` (clamp at 0;
  color `--danger` if this symbol is in `deriveContestedSymbols(state)`,
  else `--signal`). Show "No active signals" when empty.
- `CommitsPanel` — **"Commits & PRs"**: merge `state.recentPushes` and
  `state.recentRepoEvents` into one feed sorted by time desc (pushes by
  `pushedAt`, events by `createdAt`). Push rows: short `sha` (first 7 chars),
  `summary`, `filesAffected.length` files. Event rows: `kind`+`action` badge,
  `#number` (if present), `title`, `actor`. Render `url` as a link when present.
  Show "No recent activity" when empty.

**Verify**: `npm run typecheck --workspace @synapse/web` → exit 0.

### Step 7: The data-flow graph (`FlowGraph.tsx`)

This is the "connections & data flow" centerpiece. Keep it **hand-rolled SVG —
no graph/physics library** (a fixed three-column layout is all this topology
needs).

`apps/web/src/FlowGraph.tsx`, `{ state }: { state: TeamState }`:
- `const graph = deriveGraph(state)` (Step 3).
- Fixed-viewBox SVG, three columns: **sessions on the left**, a single
  **server node in the center**, **contested/active symbols on the right**.
  Compute y-positions by evenly distributing each column's nodes over the SVG
  height (index-based; no physics).
- Draw an edge as an SVG `<line>` (or `<path>`) for each `graph.edges` entry,
  from the source node center to the target node center. Color contested edges
  `--danger`, others `--border-strong`/`--signal`.
- **Animate the "flow"** with CSS only: give edges `stroke-dasharray` + an
  animated `stroke-dashoffset` keyframe (define `@keyframes flow` in
  `theme.css`) so dashes travel from source → target, reading as data moving
  daemon→server→symbol. Contested edges animate faster / in `--danger`.
- Node labels: session nodes show `memberLogin ?? memberId`; the server node
  shows "server" + `state.repoId`; symbol nodes show the symbol name (the part
  after `#`, falling back to the raw). Truncate long labels.
- Empty state (no sessions/symbols): render just the server node with a muted
  "waiting for activity" label — never crash on empty arrays.

Keep the component pure/derived from `state`; it re-renders whenever the feed
pushes a new snapshot, so the graph updates live with no extra wiring.

**Verify**: `npm run build --workspace @synapse/web` → exit 0 and
`test -f apps/web/dist/index.html && echo OK` → `OK`. Then
`npm run dev` and confirm visually the graph shows alice & bob connecting to the
server, the contested `area` symbol highlighted in red during frames 5–6, and
animated flow on the edges (skip the visual check if headless).

### Step 8: The landing page (`Landing.tsx`)

`apps/web/src/Landing.tsx` — a lean marketing hero, copy sourced from the repo
`README.md` (do not invent claims):

- Wordmark "Synapse" in **Fraunces**.
- Tagline (verbatim from `README.md:5`): *"A realtime coordination layer for
  teams using coding agents."*
- One-line pitch (from `README.md:14`): *"Agents still write the code. Synapse
  gives them current team context before they edit, then records contract-level
  changes after they edit, so other agents can avoid collisions."*
- A primary CTA button "See it live ↓" linking to `#dashboard`.
- 3–4 feature highlights drawn from the README features table
  (`README.md:20-77`), e.g. *Contract-level conflicts*, *Polyglot analyzers*,
  *Deterministic first*, *Any-agent onboarding* — one short sentence each.
- A short footer (MIT license, "Built by Prince Kumar" — matches the README
  badges).

Keep it to one screen of hero + a feature strip; the dashboard is the proof.

**Verify**: `npm run build` (root) → exit 0; `npm run typecheck` (root) →
exit 0.

## Test plan

- New test file: `apps/web/src/derive.test.ts` (Step 3), `node:test` idiom,
  covering: (1) no-contention graph shape, (2) a contested symbol flagged on
  the right edge, (3) ended sessions excluded. These lock the data-flow logic
  that the whole visualization depends on.
- Structural pattern to follow: `packages/protocol/src/negotiation.test.ts`.
- The React components and the seeded/live feed timers are **not** unit-tested
  (no component test framework is added — that would pull in a new dependency
  for low marginal value). They are covered by the build gate and the manual
  dev-server smoke check. This is a deliberate scope choice; note it in the PR.
- Verification: `npm test --workspace @synapse/web` → all pass (3 tests).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm install` exits 0; `apps/web` is listed under workspaces
      (`npm query .workspace --workspace @synapse/web` or
      `test -d apps/web && echo OK` → `OK`).
- [ ] `npm run typecheck` exits 0 (turbo runs the web workspace's `tsc --noEmit`).
- [ ] `npm run build` exits 0 and `apps/web/dist/index.html` exists.
- [ ] `npm test` exits 0; the 3 new tests in `apps/web/src/derive.test.ts` pass.
- [ ] `grep -rn "fetch(" apps/web/src` returns no matches (the dashboard uses
      WebSocket, not cross-origin fetch — so no server CORS change is needed).
- [ ] No files outside `apps/web/**` are modified except `package-lock.json`
      (`git status --porcelain` shows only `apps/web/…` and the lockfile, plus
      the `plans/` index update below).
- [ ] `apps/server/**`, `packages/**`, and `turbo.json` are unchanged
      (`git diff --stat 6781b81..HEAD -- apps/server packages turbo.json` is empty).
- [ ] `plans/README.md` status row for 037 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The `TeamState`/`Session`/`EditLock`/`ContractDelta` excerpts in "Current
  state" don't match `packages/protocol/src/index.ts` today (the protocol
  drifted) — the fixture and rendering would be wrong.
- Making the build pass appears to require editing the server, the protocol
  package, or `turbo.json` (it should not — if it does, an assumption here is
  false).
- You reach for a `fetch('/state')` against the server and hit CORS. The design
  uses WebSocket precisely to avoid this; do not add a server CORS header.
  Switch to the WS feed instead.
- `import type { … } from "@synapse/protocol"` fails to resolve at **build**
  time (it should be erased by esbuild). First try the commented `resolve.alias`
  in `vite.config.ts` (Step 1); if that still fails, STOP and report.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

For the owner / next agent:

- **No server changes shipped.** The live feed relies on the server sending
  full `state.snapshot` to v1 (no-`v`) WebSocket clients
  (`apps/server/src/index.ts:653-665`). If a future change makes deltas
  mandatory or stops snapshotting v1 clients, the live feed
  (`createLiveFeed`) must learn to apply `state.delta` ops — re-check this when
  touching `broadcastStateChange`.
- **Auth.** The live feed only works against a server in **open** mode, or with
  a token passed as `?token=`. A `SYNAPSE_MASTER_SECRET` (project-key) server
  needs the per-repo derived key as the token; surfacing/managing that is out
  of scope here.
- **Deploy (owner's step, not the executor's).** Vercel project settings: root
  directory `apps/web`, framework preset **Vite**, build `npm run build`, output
  `dist`. The old Vercel link lives at `Synapse/.vercel/project.json` — repoint
  it to `apps/web` or create a fresh project (owner's call). No SPA rewrite is
  needed (single page, anchor navigation only).
- **Refreshing the demo.** `DEMO_FRAMES` is hand-authored. If you want it to
  mirror real product behavior, it can later be regenerated from
  `synapse demo --json` output (the demo command spins two daemons and a server
  and emits machine-readable state) — deferred, not required.
- **Reviewer focus**: confirm the app imports `@synapse/protocol` **types
  only** (no runtime import — would bloat the bundle and could pull `zod` into
  the browser), and that nothing under `apps/server`/`packages` changed.
- **Conflicts view**: this v1 derives "contested" client-side (≥2 sessions on
  one symbol) rather than running the real `@synapse/conflict-engine` (which
  needs analyzers and isn't browser-ready). If a richer conflict verdict is
  wanted later, expose it from the server on the wire rather than porting the
  engine to the browser.

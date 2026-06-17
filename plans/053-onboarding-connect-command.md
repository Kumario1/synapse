# Plan 053: Onboarding — show the connect command for a claimed Project

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If anything in the "STOP conditions" section occurs, stop and report — do
> not improvise. When done, update the status row for this plan in
> `plans/README.md` — unless a reviewer dispatched you and told you they maintain
> the index.
>
> **Drift check (run first)**:
> `git diff --stat 975fe1d..HEAD -- apps/web/src/auth.ts apps/web/src/App.tsx apps/web/src/feed.ts apps/cli/src/config.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts below against the live code before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S-M
- **Risk**: LOW (web-only + docs; no server or CLI changes)
- **Depends on**: plans/052-claim-repo-via-app-install.md (DONE — merged as PR #118; `GET /auth/projects` returns `{ repoId, projectKey }[]` for the signed-in Owner, and `apps/web/src/auth.ts` already exports `fetchProjects()` + the `Project` type)
- **Category**: direction (feature)
- **Planned at**: commit `975fe1d`, 2026-06-17
- **Issue**: https://github.com/Kumario1/synapse/issues/105

## Why this matters

After an Owner claims a Project (#104), nothing yet walks them to a live daemon.
This adds the onboarding screen: the CLI install step plus the exact daemon-start
command for *this* Project — embedding the hosted server URL and the repo's minted
project-key — with a connected/not-yet-connected indicator. The Owner copies the
command, runs it, and their daemon connects to the hosted server as that repo's
Room. This is the minimum that turns a claimed Project into a live Room. **No
server or CLI change is needed**: the project-key is already returned by
`GET /auth/projects`, and the connected indicator reuses the existing
`/state?repoId=&token=` path (the stored project-key *is*
`deriveProjectKey(masterSecret, repoId)`, which is exactly what `/state`'s
`authorized()` expects in project-key mode).

## Current state

- `apps/web/src/auth.ts` (lines 14–18, 48–72) already has what we consume:
  ```ts
  export interface Project { repoId: string; projectKey: string; }
  export async function fetchProjects(): Promise<Project[]>; // GET /auth/projects {credentials:"include"} → [] on non-2xx
  ```
  Reuse these — do NOT re-fetch projects by hand.
- `apps/web/src/App.tsx` — the SPA root. Current body:
  ```tsx
  export default function App() {
    const feed = useMemo(() => createFeedFromLocation(window.location), []);
    const [snapshot, setSnapshot] = useState<FeedSnapshot>(feed.initial);
    useEffect(() => feed.subscribe(setSnapshot), [feed]);
    return (
      <div className="min-h-screen overflow-x-hidden">
        <Landing mode={snapshot.mode} />
        {snapshot.mode === "demo" ? <NarratedDemo /> : <Dashboard snapshot={snapshot} />}
        <footer ...>...</footer>
      </div>
    );
  }
  ```
  You will add `<Onboarding />` here (one import + one element). The Onboarding
  component self-fetches projects and renders nothing when there are none (so the
  public, signed-out landing is unchanged).
- `apps/web/src/feed.ts` — shows the existing convention for talking to the
  server with a token: the live feed connects with `?server=…&token=…`. The new
  connected-check reuses the same idea via the server's `GET /state` HTTP route.
- The server's `GET /state?repoId=<id>&token=<key>` returns the repo's
  `TeamState` JSON (a `{ sessions: [...] , ... }` object) when the token is valid;
  `401` otherwise (it is rate-limited but that does not matter for a low-frequency
  poll). `sessions.length > 0` means a daemon is connected to that Room.
- **CLI command facts** (verified in `apps/cli/src/config.ts:94–131` and
  `apps/cli/src/commands/up.ts`) — the daemon-start command to display:
  - The long-running, server-connecting command is **`synapse up`** (it runs the
    daemon in-process and connects to `--server`; without `--serve` it does NOT
    start a local server).
  - The project-key rides the **`SYNAPSE_PROJECT_KEY`** env var (or `--key`) —
    `config.ts:125-130` resolves `authToken` from `flags.key ?? SYNAPSE_PROJECT_KEY ?? flags.token ?? SYNAPSE_AUTH_TOKEN`. It is read from env/flag only and never written to disk.
  - The server URL is `--server <ws-url>` (`config.ts:109-114`).
  - The repo id is `--repo-id <id>` (`config.ts:95-100`); pass it explicitly so it
    matches the claimed `repoId` exactly rather than relying on git-remote inference.
  - The install command convention already shown on the landing page / README is
    the `synapse` npm package (the landing uses `npx synapse join`). Use
    `npm install -g synapse` for the install step.

### Conventions to match

- Web tests: `node:test` + `node:assert/strict`, `apps/web/src/*.test.ts`, run by
  `npm test --workspace @synapse/web` (`node --import tsx --test src/*.test.ts`).
  Model on `apps/web/src/auth.test.ts` (pure-function assertions).
- React 18 + TypeScript strict, Vite, shadcn UI. Reuse the existing shadcn
  components already imported in `apps/web/src/components/TopbarAuth.tsx` and
  `Landing.tsx`: `Button` from `@/components/ui/button`, `Card`/`CardHeader`/
  `CardContent`/`CardTitle`/`CardDescription` from `@/components/ui/card`,
  `Badge` from `@/components/ui/badge`. Do NOT add a new UI dependency.
- `.js` import specifiers are NOT used in the web app (Vite/bundler resolution) —
  match the existing web imports (`./auth`, `@/components/...`), no `.js`.

## Commands you will need (run from repo root /private/tmp/synapse-issue-105)

| Purpose | Command | Expected |
|---|---|---|
| Install (FIRST, fresh worktree) | `npm install` | exit 0 |
| Typecheck web | `npm run typecheck --workspace @synapse/web` | exit 0 |
| Test web | `npm test --workspace @synapse/web` | all pass |
| Build web | `npm run build --workspace @synapse/web` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Format check | `npm run format:check` | exit 0 |

(No server/CLI build needed — this plan changes neither.)

## Scope

**In scope** (create unless noted):
- `apps/web/src/onboarding.ts` (create — pure command/url/state helpers + a connected-poll)
- `apps/web/src/onboarding.test.ts` (create — pure helper assertions)
- `apps/web/src/components/Onboarding.tsx` (create — the onboarding view)
- `apps/web/src/App.tsx` (modify — render `<Onboarding />`)
- `README.md` (modify — document the onboarding/connect step)

**Out of scope** (do NOT touch):
- Anything under `apps/server/` or `apps/cli/` or `packages/` — no server route,
  no CLI flag, no protocol change. If you think you need one, STOP.
- `apps/web/src/auth.ts` — `fetchProjects` already exists; consume it, don't edit it.
- The dashboard project-list rendering and per-project routing — that is #106.
  Keep the onboarding a single self-contained panel listing the Owner's projects.
- The marketing `Landing.tsx` topbar — the "Add project" affordance is #104's;
  don't rework it.

## Git workflow

- Already on branch `feat/onboarding-connect` in this worktree. Do NOT create a new branch.
- Conventional commits (e.g. `feat(web): project onboarding connect command (#105)`).
- Do NOT push or open a PR — the reviewer/operator handles that.

## Steps

### Step 1: Pure helpers — `apps/web/src/onboarding.ts`

```ts
import type { Project } from "./auth";

export const INSTALL_COMMAND = "npm install -g synapse";

/** ws/wss origin for the hosted server, derived from the page origin. */
export function serverWsUrl(origin: string = window.location.origin): string {
  return origin.replace(/^http/, "ws"); // https→wss, http→ws
}

/** The exact daemon-start command for this Project (key via env, never persisted). */
export function daemonCommand(project: Project, wsUrl: string = serverWsUrl()): string {
  return `SYNAPSE_PROJECT_KEY=${project.projectKey} synapse up --server ${wsUrl} --repo-id ${project.repoId}`;
}

/** A daemon is connected to the Room iff the Room has at least one Session. */
export function isRoomConnected(state: unknown): boolean {
  return (
    typeof state === "object" && state !== null &&
    Array.isArray((state as { sessions?: unknown }).sessions) &&
    (state as { sessions: unknown[] }).sessions.length > 0
  );
}

/** Poll the Room state with the Owner's project-key. Reuses the existing /state route. */
export async function fetchRoomConnected(project: Project): Promise<boolean> {
  try {
    const url = `/state?repoId=${encodeURIComponent(project.repoId)}&token=${encodeURIComponent(project.projectKey)}`;
    const response = await fetch(url);
    if (!response.ok) return false;
    return isRoomConnected(await response.json());
  } catch {
    return false;
  }
}
```

**Verify**: `npm run typecheck --workspace @synapse/web` → exit 0 (after Step 2 also exists; you may build after Step 3).

### Step 2: Tests — `apps/web/src/onboarding.test.ts`

Model on `apps/web/src/auth.test.ts`. Assert:
- `INSTALL_COMMAND === "npm install -g synapse"`.
- `serverWsUrl("https://app.example")` === `"wss://app.example"`;
  `serverWsUrl("http://localhost:4010")` === `"ws://localhost:4010"`.
- `daemonCommand({ repoId: "o/r", projectKey: "KEY" }, "wss://h")` ===
  `"SYNAPSE_PROJECT_KEY=KEY synapse up --server wss://h --repo-id o/r"`.
- `isRoomConnected({ sessions: [{}] })` === true; `isRoomConnected({ sessions: [] })` === false;
  `isRoomConnected(null)` === false; `isRoomConnected({})` === false.

**Verify**: `npm test --workspace @synapse/web` → all pass, including the new file.

### Step 3: Onboarding view — `apps/web/src/components/Onboarding.tsx`

A client component:
- `const [projects, setProjects] = useState<Project[]>([]);`
  `useEffect(() => { fetchProjects().then(setProjects).catch(() => setProjects([])); }, []);`
- If `projects.length === 0` → `return null;` (signed-out / no-projects renders nothing).
- Otherwise render a section (use the existing page container classes seen in
  `Landing.tsx`, e.g. `mx-auto w-full max-w-7xl px-4 ...`) with a heading like
  "Connect your Project" and one `Card` per project showing:
  - the `repoId` as the card title,
  - a "1. Install the CLI" block with `INSTALL_COMMAND` in a `<pre><code>` + a Copy button,
  - a "2. Start the daemon" block with `daemonCommand(project)` in a `<pre><code>` + a Copy button,
  - a connected indicator `Badge` ("Connected" vs "Waiting for daemon…") driven by
    a small child component that polls `fetchRoomConnected(project)` on an interval
    (e.g. every 5s via `setInterval` in a `useEffect`, cleared on unmount).
- Copy buttons: `onClick={() => void navigator.clipboard.writeText(text)}`.
  Keep it simple; a transient "Copied" state is optional, not required.
- Put the per-project connected polling in a small inner component
  (`function ConnectionStatus({ project }: { project: Project })`) so each card
  manages its own interval cleanly.

Keep the component presentational and dependency-free beyond the shadcn pieces
already used elsewhere. Do NOT add routing.

**Verify**: `npm run typecheck --workspace @synapse/web` → exit 0; `npm run build --workspace @synapse/web` → exit 0.

### Step 4: Wire into `apps/web/src/App.tsx`

Add `import Onboarding from "./components/Onboarding";` and render it inside the
root `<div>`, after the `{snapshot.mode === "demo" ? ... : ...}` line and before
the `<footer>`:
```tsx
<Onboarding />
```
That is the only change to App.tsx. The component renders `null` for signed-out
visitors, so the public landing is visually unchanged.

**Verify**: `npm run build --workspace @synapse/web` → exit 0.

### Step 5: Documentation — `README.md`

Under the "Claim a Project" section, add a short "Connect a daemon (onboarding)"
note: after claiming, the dashboard shows the install command
(`npm install -g synapse`) and the per-Project start command
`SYNAPSE_PROJECT_KEY=<key> synapse up --server <wss-url> --repo-id <repoId>`; the
project-key is the same one minted at claim time and is shown only to the owning
Owner; the onboarding view polls the Room and flips to "Connected" once the daemon
joins. State the dev-parity caveat (the onboarding is same-origin: it works when
the SPA is served from the Synapse server origin; plain `vite dev` shows
signed-out). No new ADR, no manual CHANGELOG.

**Verify**: `npm run format:check` and `npm run lint` → exit 0.

## Test plan

- New `apps/web/src/onboarding.test.ts` covering: install command constant, the
  `http→ws`/`https→wss` conversion, the exact daemon command string (the
  acceptance artifact — server URL + repoId + key in the right shape), and
  `isRoomConnected` true/false/edge cases. Model on `apps/web/src/auth.test.ts`.
- The `Onboarding.tsx` component itself is presentational glue (fetch + render +
  interval) and is not unit-tested — its logic lives in the pure helpers above,
  which are. This matches how `TopbarAuth.tsx` (untested) pairs with the tested
  `authView` helper.
- Verification: `npm test --workspace @synapse/web` → all pass including the new file.

## Done criteria (ALL must hold)

- [ ] `npm run typecheck --workspace @synapse/web` exits 0
- [ ] `npm test --workspace @synapse/web` exits 0, including the new
      `onboarding.test.ts` (command string, ws-url conversion, connected logic)
- [ ] `npm run build --workspace @synapse/web` exits 0
- [ ] `npm run lint` exits 0 and `npm run format:check` exits 0
- [ ] `git diff --name-only 975fe1d..HEAD` lists ONLY: `apps/web/src/onboarding.ts`,
      `apps/web/src/onboarding.test.ts`, `apps/web/src/components/Onboarding.tsx`,
      `apps/web/src/App.tsx`, `README.md`, and `plans/053-*.md` (+ `plans/README.md`
      if you update the index)
- [ ] `git diff 975fe1d..HEAD -- apps/server apps/cli packages` is EMPTY (no server/CLI/protocol change)
- [ ] `plans/README.md` status row for 053 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `auth.ts`, `App.tsx`, `feed.ts`, or `config.ts` changed
  since `975fe1d` and the excerpts no longer match (especially if `fetchProjects`
  or the `Project` shape differs, or the CLI flag resolution in `config.ts`
  differs from `SYNAPSE_PROJECT_KEY`/`--server`/`--repo-id`).
- You conclude the connected indicator cannot work without a new server endpoint
  (it should work via `GET /state?repoId=&token=`). If `/state` does not accept
  the project-key, STOP and report rather than adding a server route.
- A step's verification fails twice after a reasonable fix attempt.
- You find you must modify anything under `apps/server`, `apps/cli`, or `packages`.

## Maintenance notes

- The displayed `daemonCommand` is the contract with the CLI. If the CLI ever
  renames `synapse up`, the `--server`/`--repo-id` flags, or the
  `SYNAPSE_PROJECT_KEY` env, this command string must be updated in lockstep —
  `onboarding.test.ts` pins the exact string so a CLI rename surfaces as a failing
  web test (intentional coupling; the test is the tripwire).
- The connected poll sends the project-key in the `/state` query string — this is
  the Owner's own per-repo credential and mirrors the existing live-feed
  `?token=` convention; it is not the cookie session. Don't "upgrade" it to use
  the cookie — `/state` is the machine boundary by design.
- **#106** will render the claimed-projects list / per-project Room; it can reuse
  `fetchProjects` and may fold this onboarding panel into a per-project view.
- Dev parity: same-origin only (no vite proxy), like the rest of the auth surface.
- Deferred (not built here): an end-to-end verify script that boots a project-key
  server + a daemon with the derived key and asserts a Session appears — AC "the
  command connects a daemon" is covered by the verified flag mapping (config.ts)
  plus the live connected indicator; a heavier integration test can be added later
  if onboarding regressions appear.

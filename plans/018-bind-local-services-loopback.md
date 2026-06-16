# Plan 018: Bind local services to loopback by default

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. When done, update this plan's row in `plans/README.md` unless your
> reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- apps/cli/src/daemon.ts apps/server/src/index.ts apps/cli/src/commands/up.ts docker-compose.yml apps/server/Dockerfile README.md`
> If any in-scope file changed since this plan was written, compare the
> excerpts below against live code before proceeding. On mismatch, stop.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `e3c46f2`, 2026-06-12

## Why this matters

The local daemon exposes powerful unauthenticated endpoints such as `/state`
and `/tools/synapse_report`. The server can also run in open mode for local
development. Both currently call `listen(port)` without a host, which lets
Node bind to the unspecified address on many systems while logs say
`localhost`. Defaulting to loopback preserves local behavior and requires an
explicit opt-in for LAN/public binds.

## Current state

Relevant files:

- `apps/cli/src/daemon.ts` - daemon HTTP server and local MCP tool endpoints.
- `apps/server/src/index.ts` - server HTTP/WS listener and open-mode auth.
- `apps/cli/src/commands/up.ts` - starts the embedded server for `synapse up --serve`.
- `docker-compose.yml` and `apps/server/Dockerfile` - production container path.
- `README.md` - server auth and operations docs.

Current daemon listener:

```ts
// apps/cli/src/daemon.ts:610
localServer.listen(config.daemonPort, () => {
  console.log(
    `synapse daemon ${config.sessionId} listening on http://localhost:${config.daemonPort}`
  );
});
```

Current server listener:

```ts
// apps/server/src/index.ts:332
httpServer.listen(port, () => {
  console.log(`synapse server listening on http://localhost:${port}`);
});
```

Current Docker compose publishes the server port but does not set a host env:

```yaml
# docker-compose.yml:17
ports:
  - "${SYNAPSE_SERVER_PORT:-4010}:${SYNAPSE_SERVER_PORT:-4010}"
```

Repo conventions:

- TypeScript ESM, two-space indent, `.js` extensions for relative imports.
- Verification scripts live under `scripts/verify-*.mjs` and are listed in
  `README.md`.
- Keep local/dev defaults hermetic; Docker may explicitly opt into
  `0.0.0.0` because the container port is intentionally published.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | exit 0 |
| Security verify | `npm run verify:security` | exit 0 |

Use Node `20.19.x` or newer Node 20 for verification. Do not use Node 25 for
package-level `node --test` runs; this repo has known source-test discovery
differences there.

## Scope

**In scope**:

- `apps/cli/src/daemon.ts`
- `apps/server/src/index.ts`
- `apps/cli/src/commands/up.ts` only if the embedded server needs an env pass-through
- `docker-compose.yml`
- `apps/server/Dockerfile`
- `README.md`
- `scripts/verify-security.mjs` if you add an automated regression check

**Out of scope**:

- Adding authentication to the daemon. That is a larger design decision.
- Changing tunnel token behavior.
- Changing project-key/shared-token auth semantics.

## Git workflow

- Branch: `advisor/018-bind-local-services-loopback`
- Commit style: conventional commits, e.g.
  `fix(security): bind local services to loopback by default`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add explicit bind hosts

In `apps/cli/src/daemon.ts`, bind the daemon to
`process.env.SYNAPSE_DAEMON_HOST ?? "127.0.0.1"`. Update the log to print the
actual host.

In `apps/server/src/index.ts`, bind the server to
`process.env.SYNAPSE_SERVER_HOST ?? "127.0.0.1"`. Update the log to print the
actual host. Keep the port behavior unchanged.

If `synapse up --serve` starts the server child with a custom env object, make
sure it preserves any existing `SYNAPSE_SERVER_HOST` value from the parent
environment.

**Verify**: `npm run typecheck` -> exit 0.

### Step 2: Preserve Docker behavior explicitly

Set `SYNAPSE_SERVER_HOST: "0.0.0.0"` in `docker-compose.yml` for the server
service, because Compose intentionally publishes the port. If the Dockerfile
documents runtime env vars, include `SYNAPSE_SERVER_HOST` beside
`SYNAPSE_SERVER_PORT`.

Update `README.md` operations/auth prose to say local defaults bind to
loopback and LAN/public listeners require `SYNAPSE_SERVER_HOST=0.0.0.0` or an
equivalent explicit host.

**Verify**: `rg -n "SYNAPSE_SERVER_HOST|SYNAPSE_DAEMON_HOST" README.md docker-compose.yml apps/server/Dockerfile apps/cli/src/daemon.ts apps/server/src/index.ts` -> shows the new envs.

### Step 3: Add or extend a regression check

Prefer extending `scripts/verify-security.mjs` if it already starts the server
and daemon. The check should prove both services still answer on loopback.
It does not need to prove a negative LAN bind, which is environment-specific.

Also add a static assertion in the verifier or test that no production listener
uses bare `listen(port)` for the local daemon/server.

**Verify**: `npm run verify:security` -> exit 0.

## Test plan

- Existing security verifier continues to pass.
- New or extended check covers:
  - daemon health still reachable on `127.0.0.1`;
  - server health still reachable on `127.0.0.1`;
  - source no longer contains `localServer.listen(config.daemonPort,` or
    `httpServer.listen(port,` without a host.

## Done criteria

- [ ] `npm run typecheck` exits 0.
- [ ] `npm test` exits 0.
- [ ] `npm run verify:security` exits 0.
- [ ] Docker compose explicitly sets `SYNAPSE_SERVER_HOST=0.0.0.0`.
- [ ] Local daemon and server listeners both pass an explicit host argument.
- [ ] No files outside the scope list are modified.

## STOP conditions

Stop and report if:

- You find an existing documented LAN workflow that depends on the default
  unspecified bind and has no explicit host/tunnel alternative.
- Docker cannot reach the server after setting `SYNAPSE_SERVER_HOST`.
- A verification failure requires changing auth, tunnel, or protocol behavior.

## Maintenance notes

Reviewers should scrutinize compatibility for `synapse up --serve --tunnel`
and Docker. Future server deployment docs should mention host binding whenever
they mention `SYNAPSE_SERVER_PORT`.

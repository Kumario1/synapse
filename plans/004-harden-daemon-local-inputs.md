# Plan 004: Harden local daemon JSON and server-message parsing

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a STOP condition occurs, stop and report instead of improvising. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 3a0b685..HEAD -- apps/cli/src/http.ts apps/cli/src/daemon.ts packages/protocol/src/wire-schema.ts packages/protocol/src/wire-schema.test.ts scripts/verify-security.mjs scripts/verify-mcp-adapter.mjs`
> If any in-scope file changed since this plan was written, compare the current-state excerpts below against the live code before proceeding.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security, reliability
- **Planned at**: commit `3a0b685`, 2026-06-11

## Why this matters

The shared server already caps payloads and validates inbound wire messages, but the local daemon accepts unbounded JSON bodies and blindly parses server WebSocket frames. The daemon is localhost-facing by design, but any local process can currently force memory growth with a huge POST, and a bad or misconfigured server can crash the daemon with malformed JSON.

## Current state

- `apps/cli/src/http.ts` has shared local HTTP helpers.
- `apps/cli/src/daemon.ts` uses `readJson` for every local tool POST and parses server WebSocket messages.
- `packages/protocol/src/wire-schema.ts` validates client messages only; no server-message parser exists yet.
- `packages/protocol/src/wire-schema.test.ts` shows the runtime schema test style.

Relevant excerpts:

```ts
// apps/cli/src/http.ts:28
export async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
```

```ts
// apps/cli/src/daemon.ts:181
socket.on("message", (data) => {
  const message = JSON.parse(data.toString()) as ServerMessage;
  if (message.type === "state.snapshot" || message.type === "state.delta") {
    teamState = message.payload.teamState;
  }
});
```

```ts
// apps/server/src/index.ts:649
async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_PAYLOAD_BYTES) {
      request.destroy();
      throw new Error("payload_too_large");
    }
  }
  return body;
}
```

Repo conventions to match:

- Server ingress validation uses zod schemas in `packages/protocol/src/wire-schema.ts`.
- Local hooks must not interrupt the editor; daemon errors should be clear but not noisy.
- Verification scripts prefer hermetic local servers and no external services.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit 0 |
| Protocol tests | `npm test --workspace @synapse/protocol` | exit 0 |
| Security verify | `npm run verify:security` | exit 0 |
| MCP smoke | `npm run verify:mcp-adapter` | exit 0 |
| Hook smoke | `npm run verify:hooks` | exit 0 |

## Scope

**In scope**:

- `apps/cli/src/http.ts`
- `apps/cli/src/daemon.ts`
- `packages/protocol/src/wire-schema.ts`
- `packages/protocol/src/wire-schema.test.ts`
- `scripts/verify-security.mjs` if adding daemon-local regressions fits the existing script.

**Out of scope**:

- Adding auth to the localhost daemon.
- Changing public tool request/response schemas.
- Changing server rate limits or webhook policy.

## Git workflow

- Branch: `advisor/004-harden-daemon-inputs`
- Suggested commit: `fix(daemon): bound local JSON and validate server frames`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add bounded JSON reading for local HTTP

In `apps/cli/src/http.ts`, replace unbounded chunk accumulation with byte counting.

Implementation guidance:

- Default to the server's payload cap: `1_048_576` bytes.
- Allow an optional override parameter only if needed for tests; avoid a public env knob unless the daemon already uses one.
- Throw a typed error or an error with a stable code/message such as `payload_too_large`.
- Return `{}` for an empty body, preserving current behavior.
- For malformed JSON, throw a stable `invalid_json` style error.

In `apps/cli/src/daemon.ts`, update the top-level local-server catch so:

- `payload_too_large` returns HTTP 413.
- malformed JSON returns HTTP 400.
- existing unexpected errors still return HTTP 500.

**Verify**: `npm run typecheck` -> exit 0.

### Step 2: Add server-message runtime validation

Extend `packages/protocol/src/wire-schema.ts` with a `serverMessageSchema` and `parseServerMessage(value: unknown)` modeled after `parseClientMessage`.

Minimum accepted server messages:

- `state.snapshot` with `{ teamState }`
- `state.delta` with `{ teamState }`
- `ack` with `{ forId, ok, error? }`

Reuse existing zod object definitions where possible. If a full `TeamState` schema is too large, define the minimal complete schema using existing `session`, `contractDelta`, `contractResolution`, `sessionSummary`, `conflictFeedback`, and recent-push/repo-event shapes. Keep objects loose for forward compatibility, matching `clientMessageSchema`.

Add protocol tests:

- Valid snapshot parses.
- Valid ack parses.
- Unknown message type rejects with an `invalid_message` prefix.
- Snapshot missing `payload.teamState` rejects.

**Verify**: `npm test --workspace @synapse/protocol` -> exit 0.

### Step 3: Use safe parsing in the daemon WebSocket client

In `apps/cli/src/daemon.ts`, update `socket.on("message")`:

- Wrap JSON parsing in `try/catch`.
- Pass parsed values through `parseServerMessage`.
- For invalid frames, log a warning with the parser error and ignore the frame.
- Continue updating `teamState` only for `state.snapshot` and `state.delta`.
- Ignore `ack` frames for now, preserving current behavior.

Do not close the socket for one malformed frame.

**Verify**: `npm run typecheck` -> exit 0.

### Step 4: Add local daemon hardening regression

Add coverage either to `scripts/verify-security.mjs` or a new focused script wired into `package.json` only if that is consistent with existing scripts. The regression should:

- Start a daemon or a minimal route using the same `readJson` path.
- POST a body larger than the local cap to a `/tools/*` route.
- Assert HTTP 413 and that the daemon stays healthy afterward.
- POST malformed JSON and assert HTTP 400.

If adding a full daemon script is too heavy, add focused unit tests around `readJson` with a fake `IncomingMessage`; still run the integration smoke commands below.

**Verify**:

- `npm run verify:security` -> exit 0.
- `npm run verify:mcp-adapter` -> exit 0.
- `npm run verify:hooks` -> exit 0.

## Test plan

- Protocol tests for server-message parser.
- Local HTTP tests or security verifier coverage for 413 and 400 responses.
- Existing MCP and hook verifiers prove normal daemon requests still work.

## Done criteria

- [ ] Local daemon JSON bodies are bounded before `Buffer.concat`.
- [ ] Malformed local JSON returns 400, oversized local JSON returns 413.
- [ ] Invalid server WebSocket frames no longer crash the daemon.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm test --workspace @synapse/protocol` exits 0.
- [ ] `npm run verify:security` exits 0.
- [ ] `npm run verify:mcp-adapter` exits 0.
- [ ] `npm run verify:hooks` exits 0.
- [ ] `plans/README.md` status row for Plan 004 is updated.

## STOP conditions

Stop and report if:

- Adding server-message validation requires changing the `ServerMessage` public type in a breaking way.
- Existing hook behavior begins surfacing daemon failures to the editor.
- The security verifier becomes dependent on external services.
- A verification command fails twice after a focused fix attempt.

## Maintenance notes

If future local daemon routes are added, they should use the same `readJson` helper and inherit the cap. Reviewers should look for any new direct `JSON.parse` on network or local IPC input.


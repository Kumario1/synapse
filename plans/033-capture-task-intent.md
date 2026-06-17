# Plan 033: Capture the developer's task intent via a UserPromptSubmit hook

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat e3c46f2..HEAD -- packages/protocol/src/index.ts packages/protocol/src/wire-schema.ts packages/protocol/src/wire-schema.test.ts apps/server/src/state.ts apps/cli/src/daemon.ts apps/cli/src/hooks.ts scripts/verify-hooks.mjs`
> If any of these changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.
>
> **Known concurrent plans (verified 2026-06-13)**: a separate audit at this
> same commit produced plans 017–031, executed in isolated worktrees NOT merged
> into HEAD. Overlapping touch points: 028 (`state.delta` → protocol + `state.ts`
> + `daemon.ts`), 022 (`daemon.ts` `/tools/synapse_session` handler), 017/029
> (`hooks.ts`/`connect.ts` guidance). If any land first, the drift check will
> report them — re-anchor by symbol/handler name, treat as expected, not a STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/032-session-liveness-and-intent-persistence.md`
  (032 adds the `currentTask` daemon variable this plan also updates, and makes
  the captured task survive reconnect — without it the captured intent is wiped
  on the next blip)
- **Category**: direction
- **Planned at**: commit `e3c46f2`, 2026-06-13

## Why this matters

Synapse's whole Layer II promise — "your agent knows what the team is *building*,
not just which files changed" — rests on the session field `lastTask`. The
protocol carries it (`Session.lastTask`), the briefings render it
(`apps/cli/src/briefings.ts:109`, `:245`, `:428`), and the vision's own example
state shows it as `"refactoring token validation to use new JWT library"`. But
in the flagship Claude Code flow it is **never populated**: the PreToolUse hook
calls `synapse_check` with only `{ repoId, sessionId, files }`
(`apps/cli/src/hooks.ts:133-137`) and nothing else carries intent, so every
session shows "No task recorded" and briefings can only say "alice edited
`token.ts`." Claude Code already exposes a `UserPromptSubmit` hook that receives
the developer's prompt text — exactly the task intent. This plan installs it and
forwards the prompt as the session's task, so briefings finally describe intent.

The mechanism mirrors how `branch` was added to heartbeats (Plan 006, merged):
an additive optional `task` field on `session.heartbeat`, set by `touchSession`,
sent by the daemon, and now driven by a new hook stage.

## Current state

- `packages/protocol/src/index.ts:644` — the heartbeat wire payload (no `task`
  yet); `branch` was already added the same additive way:

  ```ts
  | WireEnvelope<"session.heartbeat", { repoId: string; sessionId: string; branch?: string }>
  ```

- `packages/protocol/src/wire-schema.ts:177-185` — the matching runtime schema:

  ```ts
  z.looseObject({
    ...envelope,
    type: z.literal("session.heartbeat"),
    payload: z.looseObject({
      repoId: z.string().min(1),
      sessionId: z.string().min(1),
      branch: z.string().min(1).optional()
    })
  }),
  ```

- `apps/server/src/state.ts:48-50` + `:181-202` — heartbeat handling and
  `touchSession` (currently takes `branch?`; add `task?` the same way, set
  `lastTask` when present, preserve when absent):

  ```ts
  case "session.heartbeat":
    touchSession(state, repoId, store, message.payload.sessionId, now, message.payload.branch);
    break;
  ```

- `apps/cli/src/daemon.ts:293-301` (periodic heartbeat) and `:584-590`
  (the `/tools/synapse_session` heartbeat branch) — both send `session.heartbeat`
  with `branch` but no `task`:

  ```ts
  } else {
    sendToServer("session.heartbeat", {
      repoId: config.repoId,
      sessionId: config.sessionId,
      branch: currentGitBranch(config.worktreeRoot)
    });
  }
  ```

- `apps/cli/src/hooks.ts:26-59` — `installClaudeCodeHooks` writes the
  `PreToolUse`/`PostToolUse`/`SessionStart` entries; `:70-94` `withSynapseHook`
  builds a **matcher** group. `UserPromptSubmit` takes **no matcher** — its
  config shape is `{ "UserPromptSubmit": [ { "hooks": [ { "type": "command",
  "command": "…" } ] } ] }` — so it needs a small matcher-less variant.

- `apps/cli/src/hooks.ts:107-155` — `runHook(rawArgs)` and `hookStage`. The hook
  is dispatched as `node "<cli>" hook <stage>`; `hookCommand(stage)` builds that
  string (`:17-19`). Add a `"user-prompt"` stage.

- `apps/cli/src/hooks.ts:276-293` — `parseHookInput` reads `tool_input.file_path`
  from the hook JSON; extend it to also capture `prompt` (the UserPromptSubmit
  payload field).

- The opt-out convention is `SYNAPSE_*=0` (e.g. `SYNAPSE_FILE_WATCHER=0`,
  `SYNAPSE_HOOK_NONBLOCKING=1`).

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Protocol unit tests | `npm test --workspace @synapse/protocol` | exit 0 |
| Server unit tests | `npm test --workspace @synapse/server` | exit 0 |
| Hooks E2E | `npm run verify:hooks` | exit 0 |
| Protocol compat E2E | `npm run verify:protocol-compat` | exit 0 |

## Scope

**In scope**:
- `packages/protocol/src/index.ts`
- `packages/protocol/src/wire-schema.ts`
- `packages/protocol/src/wire-schema.test.ts`
- `apps/server/src/state.ts`
- `apps/server/src/state.test.ts` (add a heartbeat-sets-task test)
- `apps/cli/src/daemon.ts`
- `apps/cli/src/hooks.ts`
- `scripts/verify-hooks.mjs` (extend)

**Out of scope** (do NOT touch):
- The PreToolUse/PostToolUse logic and the `synapse_check`/`synapse_report`
  request shapes — intent capture rides the heartbeat, not the check.
- The `SynapseCheckRequest.task` field — it already exists and feeds the LLM
  enrichment; leave it. This plan is about the **session** task.
- Protocol version negotiation — `task` is an additive v1 field (loose schemas),
  no version bump.

## Git workflow

- Branch: `advisor/033-capture-task-intent`
- Suggested commits:
  - `feat(protocol): carry task on session heartbeat`
  - `feat(cli): UserPromptSubmit hook records the developer's task`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `task` to the heartbeat protocol type and schema

In `packages/protocol/src/index.ts`, extend the heartbeat payload:
```ts
| WireEnvelope<"session.heartbeat", { repoId: string; sessionId: string; branch?: string; task?: string }>
```

In `packages/protocol/src/wire-schema.ts`, add to the heartbeat payload schema:
```ts
task: z.string().min(1).optional()
```

In `packages/protocol/src/wire-schema.test.ts`, add a heartbeat case carrying a
task (and keep an existing case without one to prove backward compatibility):
```ts
{ ...base, type: "session.heartbeat", payload: { repoId: "local", sessionId: "alice", task: "add JWT refresh" } }
```

**Verify**: `npm test --workspace @synapse/protocol` → exit 0.

### Step 2: Set `lastTask` from the heartbeat in `touchSession`

In `apps/server/src/state.ts`:
- Pass the task through the `session.heartbeat` case:
  ```ts
  case "session.heartbeat":
    touchSession(state, repoId, store, message.payload.sessionId, now, message.payload.branch, message.payload.task);
    break;
  ```
- Extend `touchSession`'s signature with `task?: string` and, when present and
  non-empty, set `session.lastTask = task;` (leave `lastTask` unchanged when the
  task is absent — same preserve-on-omit rule as `branch`).

Add a `state.test.ts` case: a heartbeat with `task: "X"` sets the session's
`lastTask` to `"X"`; a later heartbeat without a task leaves it `"X"`.

**Verify**: `npm test --workspace @synapse/server` → exit 0.

### Step 3: Send the task on daemon heartbeats

In `apps/cli/src/daemon.ts`, in the `/tools/synapse_session` heartbeat branch
(`:584-590`), include the task and (from Plan 032) remember it:
```ts
} else {
  currentTask = body.task ?? currentTask;
  sendToServer("session.heartbeat", {
    repoId: config.repoId,
    sessionId: config.sessionId,
    branch: currentGitBranch(config.worktreeRoot),
    ...(currentTask ? { task: currentTask } : {})
  });
}
```
Leave the periodic 30s heartbeat (`:293-301`) sending the remembered
`currentTask` too, so the task keeps refreshing:
```ts
setInterval(() => {
  sendToServer("session.heartbeat", {
    repoId: config.repoId,
    sessionId: config.sessionId,
    branch: currentGitBranch(config.worktreeRoot),
    ...(currentTask ? { task: currentTask } : {})
  });
}, 30_000).unref();
```
(`currentTask` is the `let` added in Plan 032. If Plan 032 has not landed, STOP —
see STOP conditions.)

**Verify**: `npm run build` → exit 0.

### Step 4: Install and handle the UserPromptSubmit hook

In `apps/cli/src/hooks.ts`:

(a) Add a `UserPromptSubmit` entry in `installClaudeCodeHooks`'s `settings.hooks`
object. Because this event takes no matcher, add a small variant of
`withSynapseHook` that manages a **matcher-less** group. Target shape produced in
`.claude/settings.json`:
```json
"UserPromptSubmit": [
  { "hooks": [ { "type": "command", "command": "node \"<cli>\" hook user-prompt" } ] }
]
```
Make it idempotent the same way `withSynapseHook` is: identify our command by
`\bhook user-prompt\b`, drop any prior copy, push the current one, preserve any
non-Synapse `UserPromptSubmit` hooks.

(b) In `hookStage`, map `"user-prompt"` → `"user-prompt"`; widen the return type
to include it.

(c) In `runHook`, before the file-path logic, handle the new stage:
```ts
if (stage === "user-prompt") {
  await runUserPromptHook(baseUrl, defaults, input);
  return;
}
```
and add:
```ts
/**
 * UserPromptSubmit hook: record the developer's prompt as this session's task
 * so teammates' briefings describe intent, not just file churn. Best-effort and
 * silent — never writes to stdout (the prompt proceeds unchanged) and never
 * throws. SYNAPSE_TASK_CAPTURE=0 disables it.
 */
async function runUserPromptHook(
  baseUrl: string,
  defaults: { repoId: string; sessionId: string },
  input: HookInput
): Promise<void> {
  if (process.env.SYNAPSE_TASK_CAPTURE === "0") {
    return;
  }
  const task = (input.prompt ?? "").replace(/\s+/gu, " ").trim().slice(0, 200);
  if (!task) {
    return;
  }
  await postJson(`${baseUrl}/tools/synapse_session`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    action: "heartbeat",
    task
  }).catch(() => undefined);
}
```

(d) In `parseHookInput`, capture the prompt:
```ts
prompt: typeof parsed.prompt === "string" ? parsed.prompt : undefined
```
and add `prompt?: string` to the `HookInput` interface.

**Verify**: `npm run build` → exit 0, then `npm run typecheck` → exit 0.

### Step 5: Extend the hooks verifier

In `scripts/verify-hooks.mjs` (read it first — it runs `synapse join` then drives
`hook pre`/`hook post` as Claude Code would, talking to a live daemon and
server), add coverage:

1. After `join`, assert `.claude/settings.json` now contains a `UserPromptSubmit`
   entry whose command includes `hook user-prompt`.
2. Drive the new stage as Claude Code would: spawn `node <cli> hook user-prompt`
   with hook JSON on **stdin** containing a `prompt`, e.g.
   `{ "prompt": "add JWT refresh to auth", "cwd": "<repo>" }`.
3. Wait for the daemon to flush a heartbeat (or call the daemon's
   `/tools/synapse_session` heartbeat path the script already uses), then read
   `GET /state` and assert the session's `lastTask` equals the captured prompt
   (trimmed/truncated).

Match the script's existing spawn + assertion helpers; do not add a framework.

**Verify**: `npm run verify:hooks` → exit 0, with the new assertions passing.

### Step 6: Confirm backward compatibility

**Verify**: `npm run verify:protocol-compat` → exit 0 (the `task` field is an
additive, optional v1 payload field; old clients omit it).

## Test plan

- Protocol unit: heartbeat schema accepts a payload with and without `task`.
- Server unit: a heartbeat with `task` sets `lastTask`; a subsequent heartbeat
  without `task` preserves it.
- E2E (`verify:hooks`): `join` installs the UserPromptSubmit hook, and driving
  `hook user-prompt` with a prompt on stdin updates the session's `lastTask`
  visible in `/state`.
- Model the protocol test after the existing heartbeat cases in
  `wire-schema.test.ts`; the server test after the heartbeat/branch tests in
  `state.test.ts`.

## Done criteria

ALL must hold:

- [ ] `grep -n "task" packages/protocol/src/wire-schema.ts` shows `task` in the
      heartbeat payload schema
- [ ] `grep -n "user-prompt" apps/cli/src/hooks.ts` → ≥ 3 matches
      (hookCommand/install, stage map, runHook dispatch)
- [ ] `grep -n "UserPromptSubmit" apps/cli/src/hooks.ts` → ≥ 1 match
- [ ] `npm run typecheck` exits 0
- [ ] `npm test --workspace @synapse/protocol` and
      `npm test --workspace @synapse/server` exit 0, with the new tests
- [ ] `npm run verify:hooks` and `npm run verify:protocol-compat` exit 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 033 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `apps/cli/src/daemon.ts` has no `currentTask` variable (Plan 032 has not
  landed). This plan depends on it; do not invent a parallel mechanism.
- Claude Code rejects the `UserPromptSubmit` settings shape during
  `verify:hooks` (the event name or config schema differs from the excerpt) —
  report the exact settings.json the verifier produced and the error.
- A verification command fails twice after a focused fix attempt.
- Capturing the prompt as `lastTask` would require sending anything beyond the
  trimmed/truncated prompt string (e.g. file contents) — it must not; report.

## Maintenance notes

- Privacy: `lastTask` is the developer's prompt text, shown to teammates in
  briefings — consistent with the vision's `last_task` example and the
  "distillations, not raw content" principle (it is prose, capped at 200 chars,
  never code). `SYNAPSE_TASK_CAPTURE=0` opts out. Document the env var and the
  behavior in the README.
- This is the first signal source that lets `synapse whatsup`/`onboard` describe
  intent; Plan 034 (a direct decision/coordination channel) builds on the same
  "agent reports prose intent" seam — keep them consistent (truncation, opt-out).
- A reviewer should confirm the hook never writes to stdout (so it cannot
  corrupt the prompt) and never throws (so a down daemon can't block prompting).
- Non-Claude agents (Cursor/etc. via MCP) can set the task by passing `task` to
  the `synapse_session`/`synapse_check` MCP tools — already supported; this plan
  only closes the gap for the hook-driven Claude Code path.

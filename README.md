# Synapse

Synapse is a realtime coordination layer for teams using coding agents. Agents still write the code; Synapse gives them current team context before they edit, then records contract-level changes after they edit so other agents can avoid collisions.

The planning source of truth lives in:

- [synapse-context.md](/Users/princekumar/Documents/synapseWork/synapse-context.md)
- [synapse-build-plan.md](/Users/princekumar/Documents/synapseWork/synapse-build-plan.md)
- [synapse-technical-spec.md](/Users/princekumar/Documents/synapseWork/synapse-technical-spec.md)

## Current Build Track

The repository now has the local realtime loop in place:

1. TypeScript monorepo, shared protocol types, and in-memory fanout server.
2. Local daemon/CLI with `synapse_check`, `synapse_report`, `synapse_push`, and session tools.
3. TypeScript contract extraction, file-only checks, dependency checks, compatibility analysis, and
   deterministic/optional-LLM contract resolution.
4. Deterministic `synapse whatsup` team-state briefing from the daemon's warm cache.
5. Stdio MCP adapter so MCP-capable agents can call the same daemon tools without shell-specific
   integration code.

The implementation is still intentionally local and in-memory. It proves the hot loop before adding
persistence, auth, Python analysis, or real hook installation.

## Architecture Shape

```text
apps/
  cli/          local daemon, CLI commands, and MCP stdio adapter
  server/       local websocket fanout server
packages/
  analyzer-ts/ TypeScript contract extraction
  protocol/     shared wire, state, and symbol types
  conflict-engine/
                pure conflict evaluator
```

## Local Development

Prerequisite: Node.js 20+ and npm.

```bash
npm install
npm run build
npm test
```

Inspect TypeScript contracts from a file:

```bash
npm run build
npm run dev --workspace @synapse/cli -- analyze --file packages/analyzer-ts/src/index.ts
```

Start the local coordination server:

```bash
npm run dev --workspace @synapse/server
```

Start two local daemon sessions in separate terminals:

```bash
npm run dev --workspace @synapse/cli -- daemon --member alice --session alice --port 4011
npm run dev --workspace @synapse/cli -- daemon --member bob --session bob --port 4012
```

Report an unpushed contract change from Alice:

```bash
npm run dev --workspace @synapse/cli -- report --port 4011 --file src/auth/token.ts --symbol ts:src/auth/token.ts#TokenValidator.validate --summary "TokenValidator.validate now returns Result<Token, AuthError>"
```

When `--symbol` is omitted for a TypeScript/JavaScript file, the daemon reads the file, extracts
contracts locally, compares against its previous snapshot, and reports only public contract changes.

Check the same symbol from Bob:

```bash
npm run dev --workspace @synapse/cli -- check --port 4012 --file src/auth/token.ts --symbol ts:src/auth/token.ts#TokenValidator.validate
```

Expected result: Bob receives a `warn` verdict for `same_symbol_unpushed`.

Ask Bob's daemon for the current team-state briefing:

```bash
npm run dev --workspace @synapse/cli -- whatsup --port 4012
npm run verify:whatsup
```

The briefing summarizes active sessions, unpushed contract deltas, edit locks, recent pushes, and
shared contract resolutions. It is deterministic and reads from the daemon's local warm cache.

Verify the automatic TypeScript report path:

```bash
npm run verify:daemon-ts-report
```

Verify that a check with only a TypeScript file path can still find symbol-level conflicts:

```bash
npm run verify:file-only-ts-check
```

Verify that a checked TypeScript file warns when it depends on another file's unpushed contract
change:

```bash
npm run verify:dependency-ts-check
```

Run the recorded conflict eval suite:

```bash
npm run eval:conflicts
```

The eval fixtures cover the current warning/no-warning contract: no overlap, same-symbol breaking,
same-symbol compatible, direct dependency, divergent contracts, stale base, and same-file low-noise.

Notify Synapse that pushed files should leave live unpushed state:

```bash
npm run dev --workspace @synapse/cli -- push --port 4011 --file src/auth/token.ts --sha abc123 --summary "Pushed auth token changes"
npm run verify:push-state-reset
```

The server also accepts GitHub `push` webhooks at `POST /webhooks/github`. For local/dev repos,
pass `?repoId=local`; otherwise the webhook uses `repository.full_name` as the Synapse repo id.
Set `SYNAPSE_GITHUB_WEBHOOK_SECRET` to require GitHub's `X-Hub-Signature-256` HMAC check.

```bash
npm run verify:github-webhook
```

Expose the same daemon tools to MCP-capable agents:

```bash
npm run dev --workspace @synapse/cli -- mcp --port 4012
npm run verify:mcp-adapter
```

The MCP adapter is intentionally thin. It runs over stdio, registers `synapse_check`,
`synapse_report`, `synapse_push`, `synapse_session`, and `synapse_whatsup`, then forwards each call
to the local daemon. The daemon remains the single place that owns contract extraction, conflict
detection, LLM analysis, resolution, and briefing.

## Contract-Level Conflict Classification

A check no longer just reports that two agents touched the same symbol — it compares the
actual `before`/`after` signatures and classifies whether the change is really a conflict:

- The deterministic comparator (`compareSignatures` in `@synapse/conflict-engine`) labels each
  change `breaking`, `compatible`, `identical`, or `unknown` and lists concrete reasons.
- Each `Conflict` carries a structured `change` (the real before -> after) and an `analysis` —
  an actionable, both-sides verdict: an `assessment`, a `recommendation`
  (`block`/`warn`/`info`/`proceed`), and `actions` addressed to each side (`you` /
  `counterpart` / `both`). Backward-compatible changes are demoted to `info`; breaking and
  unclassifiable changes stay `warn`.
- When both agents have an unpushed change to the same symbol with different resulting shapes, the
  engine raises `contract_divergent` — the strongest "you two must agree" signal.

```bash
npm run verify:contract-compat
```

## Contract Resolution (converging two agents on one contract)

Beyond *advice*, a `contract_divergent` conflict carries a `resolution` (`ProposedResolution`) — a
concrete merged contract both agents adopt so their edits converge:

- **Deterministic baseline (always present, no key).** `contract_divergent` resolves to an
  *escalate* (`reconciled:false`, `recommendation:"block"`) naming both sides' contracts — it never
  guesses a merge. `same_symbol_unpushed` resolves to *adopt-the-counterpart* (`reconciled:true`),
  since only one side changed the symbol.
- **Canonical & converged.** A computed resolution is stored once in the server's `TeamState`, keyed
  by `symbol + inputsHash` (a symmetric hash of both diffs), first-writer-wins, and broadcast — so
  both agents read the *same* object. Any new delta or push for the symbol invalidates it.
- **Optional LLM resolver (with a key).** For `contract_divergent` only, the daemon asks the model
  (temperature 0, symmetric A/B prompt, caller-aware via the file + dependency-graph neighbors) to
  synthesize one signature. The proposed contract must parse via the real analyzer or it falls back
  to the deterministic escalate. Unreconcilable intents return `block` with a reason.

```bash
npm run verify:resolution   # fully deterministic, no key required
```

### Optional LLM analysis (OpenRouter)

Detection stays fully deterministic. An optional layer turns the conflict — including the **code
diffs from both sides** — into a richer, task-aware actionable analysis. It runs through
[OpenRouter](https://openrouter.ai) (any chat model) over plain HTTP, so there is no extra SDK
dependency and it never affects the verdict.

Set the key in one place (`.env`, see `.env.example`) and start the daemon with Node's env-file
support:

```bash
cp .env.example .env   # then paste your OPENROUTER_API_KEY
node --env-file=.env apps/cli/dist/index.js daemon --member bob --session bob --port 4012
```

The model defaults to `anthropic/claude-haiku-4.5` (per the build plan) and is overridable via
`SYNAPSE_LLM_MODEL`. The same key enables the contract resolver (above); `SYNAPSE_LLM_EXPLAIN=0` and
`SYNAPSE_LLM_RESOLVE=0` disable each layer independently. With no key set, the daemon runs fully
offline on the deterministic analysis and resolution.

To verify the OpenRouter path locally:

```bash
set -a
source .env
set +a

npm run verify:contract-compat
npm run verify:resolution
```

When OpenRouter is used, the output's `analysis.source` or `analysis.resolution.source` is the model
slug. If the model fails or times out, Synapse falls back to `source:"deterministic"`. The model can
raise a recommendation, but it cannot downgrade a deterministic warning into `info` or `proceed`.

## Decisions In Force

These are already resolved in the planning docs and should guide implementation unless we explicitly revise them:

- Single repo first.
- Self-hosted first.
- TypeScript server/daemon with polyglot analyzers later.
- Local daemon keeps raw code local.
- Agents query; agents decide. Synapse warns inline, never auto-blocks.
- TypeScript/JS and Python analyzers are the first language targets.
- Dependency-graph-grade conflict detection is the moat.

## Open Decisions

Before changing these, ask the project owner:

- Exact session lifecycle and idle timeout.
- Edit lock granularity for v1: symbol-level only, file-level fallback, or both.
- Python resolver packaging: pyright, jedi, or both behind the sidecar.
- Graph cache format and acceptable initial index time.
- Self-host packaging strategy for the Python sidecar.
- Wire-protocol auth and token rotation.

## Roadmap

- Milestone 0: runnable skeleton and realtime stub loop.
- Milestone 1: TS/Python contract extraction, contract delta diffing, Redis/Postgres-backed live state, severity scoring.
- Milestone 2: dependency graph, MCP adapter, GitHub webhooks, cross-agent support.
- Milestone 3: team briefings.
- Milestone 4: persistent memory.

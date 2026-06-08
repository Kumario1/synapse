# OpenRouter Demo

This document records the manual OpenRouter demo run for Synapse. It shows how to start the local
server, run two agent daemons, create competing TypeScript contract changes, and interpret the
OpenRouter-backed analysis and resolution output.

The concrete IDs and timestamps in your terminal will differ from the examples below. The important
fields are the `rule`, `verdict`, `analysis.source`, `analysis.recommendation`, and
`analysis.resolution`.

## Manual Result Summary

The manual run looks good. It proves the OpenRouter path is active and that Synapse is still keeping
the deterministic conflict detector in control of the top-level verdict.

Your run covered two important cases:

- Alice changed `validate(input: string): boolean` to
  `validate(input: string): Result<Token>`. Bob's check returned `same_symbol_unpushed` with
  `verdict: "warn"`, `analysis.source: "anthropic/claude-haiku-4.5"`, and `degraded: false`.
- Bob then changed the same function to `validate(input: string): Promise<Token>`. Bob's check
  returned `contract_divergent`, OpenRouter identified the synchronous-vs-async contract split, and
  the resolver returned `reconciled: false` with `recommendation: "block"`.

The only nuance is intentional: in the divergent-contract case the top-level `verdict` stayed
`"warn"` while `analysis.recommendation` and `analysis.resolution.recommendation` were `"block"`.
That means the deterministic engine found a warning-level conflict, and OpenRouter added a stronger
advisory action plan. If the product should hard-stop the command whenever OpenRouter recommends
`block`, that is a separate behavior change to implement later.

## What This Demo Proves

- Synapse detects an unpushed contract change from another agent before you edit the same symbol.
- Synapse sends both sides' contract context to OpenRouter when `OPENROUTER_API_KEY` is loaded.
- OpenRouter can enrich the action plan without changing deterministic conflict detection.
- For one-sided changes, deterministic resolution tells the other side to adopt the changed
  contract.
- For two incompatible changes to the same symbol, Synapse raises `contract_divergent` and the
  OpenRouter resolver either proposes one validated contract or safely blocks.
- The model cannot downgrade a deterministic warning into a weaker recommendation.

## Prerequisites

Run all commands from the real repo path:

```bash
cd /Users/princekumar/Documents/synapseWork
```

Make sure `.env` has an OpenRouter key:

```bash
OPENROUTER_API_KEY=your_openrouter_key_here
SYNAPSE_LLM_MODEL=anthropic/claude-haiku-4.5
```

Build the repo:

```bash
npm run build
```

## Create Demo Worktrees

Use two isolated folders so Alice and Bob can edit the same file differently:

```bash
export DEMO=/tmp/synapse-openrouter-demo
rm -rf "$DEMO"
mkdir -p "$DEMO/alice/src/auth" "$DEMO/bob/src/auth"

cat > "$DEMO/alice/src/auth/token.ts" <<'EOF'
export interface Token {
  value: string;
}

export interface Result<T> {
  value: T;
}

export function validate(input: string): boolean {
  return input.length > 0;
}
EOF

cp "$DEMO/alice/src/auth/token.ts" "$DEMO/bob/src/auth/token.ts"
```

`DEMO` is a shell variable. If you open a new terminal and need to use `$DEMO`, run this again:

```bash
export DEMO=/tmp/synapse-openrouter-demo
```

## Start Synapse

Use separate terminals.

Terminal 1, start the server:

```bash
cd /Users/princekumar/Documents/synapseWork
SYNAPSE_SERVER_PORT=4010 npm run dev --workspace @synapse/server
```

Expected:

```text
synapse server listening on http://localhost:4010
```

Terminal 2, start Alice's daemon with OpenRouter environment loaded:

```bash
cd /Users/princekumar/Documents/synapseWork
node --env-file=.env apps/cli/dist/index.js daemon \
  --member alice \
  --session alice \
  --port 4011 \
  --server ws://localhost:4010 \
  --worktree-root /tmp/synapse-openrouter-demo/alice
```

Terminal 3, start Bob's daemon with OpenRouter environment loaded:

```bash
cd /Users/princekumar/Documents/synapseWork
node --env-file=.env apps/cli/dist/index.js daemon \
  --member bob \
  --session bob \
  --port 4012 \
  --server ws://localhost:4010 \
  --worktree-root /tmp/synapse-openrouter-demo/bob
```

## Baseline Both Agents

Terminal 4:

```bash
cd /Users/princekumar/Documents/synapseWork

node apps/cli/dist/index.js report --port 4011 --file src/auth/token.ts
node apps/cli/dist/index.js report --port 4012 --file src/auth/token.ts
```

The first report for each daemon stores a local contract snapshot. It usually returns no deltas
because there is no previous snapshot to diff against.

## Scenario 1: Alice Changes The Contract

Alice changes `validate` from returning `boolean` to returning `Result<Token>`:

```bash
export DEMO=/tmp/synapse-openrouter-demo

cat > "$DEMO/alice/src/auth/token.ts" <<'EOF'
export interface Token {
  value: string;
}

export interface Result<T> {
  value: T;
}

export function validate(input: string): Result<Token> {
  return { value: { value: input } };
}
EOF

node apps/cli/dist/index.js report --port 4011 --file src/auth/token.ts
sleep 1
node apps/cli/dist/index.js check \
  --port 4012 \
  --file src/auth/token.ts \
  --task "Use validate before editing login flow"
```

Your successful report created a signature delta:

```json
{
  "ok": true,
  "delta": {
    "symbolId": {
      "raw": "ts:src/auth/token.ts#validate"
    },
    "changeKind": "signature_changed",
    "summary": "Changed signature for ts:src/auth/token.ts#validate"
  }
}
```

Bob's check returned a warning:

```json
{
  "verdict": "warn",
  "conflicts": [
    {
      "severity": "warn",
      "rule": "same_symbol_unpushed",
      "detail": "alice has a breaking change to ts:src/auth/token.ts#validate [function validate(input: string): boolean => function validate(input: string): Result<Token>]: Changed signature for ts:src/auth/token.ts#validate",
      "change": {
        "compatibility": "breaking",
        "breakingReasons": [
          "Return type changed: boolean -> Result<Token>."
        ]
      },
      "analysis": {
        "assessment": "Alice changed validate's return type from boolean to Result<Token>, a breaking change. Your task requires using validate before editing login flow, but you're working against the old contract. The signatures are incompatible.",
        "recommendation": "warn",
        "actions": [
          {
            "audience": "you",
            "step": "Sync with alice's branch to adopt the new contract: function validate(input: string): Result<Token>. Update your login flow code to handle Result<Token> instead of boolean."
          },
          {
            "audience": "counterpart",
            "step": "Push your changes to unblock dependent work and ensure both agents work against the same contract."
          }
        ],
        "source": "anthropic/claude-haiku-4.5",
        "resolution": {
          "reconciled": true,
          "proposedContract": "function validate(input: string): Result<Token>",
          "recommendation": "warn",
          "source": "deterministic"
        }
      }
    }
  ],
  "degraded": false
}
```

### Interpretation

- `verdict: "warn"` means Bob should not blindly continue against the old contract.
- `rule: "same_symbol_unpushed"` means only Alice has changed this symbol so far.
- `change.compatibility: "breaking"` is deterministic and comes from comparing signatures.
- `analysis.source: "anthropic/claude-haiku-4.5"` proves OpenRouter was called for the action plan.
- `analysis.recommendation: "warn"` proves the model did not downgrade the deterministic warning.
- `analysis.resolution.source: "deterministic"` is expected here. Since only Alice changed the
  symbol, the safe resolution is deterministic: Bob should adopt Alice's new contract.
- `degraded: false` means Bob's daemon was connected to the server while checking.

## Scenario 2: Bob Also Changes The Same Contract Differently

Bob changes `validate` to return `Promise<Token>`:

```bash
export DEMO=/tmp/synapse-openrouter-demo

cat > "$DEMO/bob/src/auth/token.ts" <<'EOF'
export interface Token {
  value: string;
}

export interface Result<T> {
  value: T;
}

export function validate(input: string): Promise<Token> {
  return Promise.resolve({ value: input });
}
EOF

node apps/cli/dist/index.js report --port 4012 --file src/auth/token.ts
sleep 1
node apps/cli/dist/index.js check \
  --port 4012 \
  --file src/auth/token.ts \
  --task "Choose final validate contract"
```

Your successful report created Bob's competing delta:

```json
{
  "ok": true,
  "delta": {
    "symbolId": {
      "raw": "ts:src/auth/token.ts#validate"
    },
    "changeKind": "signature_changed",
    "summary": "Changed signature for ts:src/auth/token.ts#validate"
  }
}
```

Bob's check returned a stronger conflict:

```json
{
  "verdict": "warn",
  "conflicts": [
    {
      "severity": "warn",
      "rule": "contract_divergent",
      "detail": "alice and you both changed ts:src/auth/token.ts#validate to different contracts: theirs function validate(input: string): Result<Token> vs yours function validate(input: string): Promise<Token>.",
      "change": {
        "after": {
          "raw": "function validate(input: string): Result<Token>"
        },
        "compatibility": "breaking"
      },
      "selfChange": {
        "after": {
          "raw": "function validate(input: string): Promise<Token>"
        },
        "compatibility": "breaking"
      },
      "analysis": {
        "assessment": "Both agents changed validate's return type from boolean to incompatible contracts: alice->Result<Token>, you->Promise<Token>. Parameter signatures match, but return types diverge fundamentally. Deterministic reconciliation impossible.",
        "recommendation": "block",
        "actions": [
          {
            "audience": "both",
            "step": "Decide: should validate return Result<Token> (synchronous, error-as-value) or Promise<Token> (async)? Document rationale."
          },
          {
            "audience": "you",
            "step": "Align your Promise<Token> contract to the agreed choice, then rebase and re-run validation."
          },
          {
            "audience": "counterpart",
            "step": "Align your Result<Token> contract to the agreed choice, then rebase and re-run validation."
          }
        ],
        "source": "anthropic/claude-haiku-4.5",
        "resolution": {
          "reconciled": false,
          "proposedContract": null,
          "recommendation": "block",
          "source": "anthropic/claude-haiku-4.5"
        }
      }
    }
  ],
  "degraded": false
}
```

The resolver explained why it blocked:

```text
Side A proposes synchronous Result<Token> wrapper; Side B proposes async Promise<Token>.
These are fundamentally incompatible execution models.
```

### Interpretation

- `rule: "contract_divergent"` means both agents changed the same symbol, and the resulting
  contracts differ.
- `change.after.raw` is Alice's proposed contract: `Result<Token>`.
- `selfChange.after.raw` is Bob's proposed contract: `Promise<Token>`.
- `analysis.source: "anthropic/claude-haiku-4.5"` proves OpenRouter generated the action plan.
- `analysis.recommendation: "block"` is stronger than the deterministic warning and is allowed.
- `analysis.resolution.source: "anthropic/claude-haiku-4.5"` proves the OpenRouter resolver ran.
- `resolution.reconciled: false` and `proposedContract: null` are correct here. A synchronous
  `Result<Token>` API and an async `Promise<Token>` API require different caller behavior, so the
  safe answer is to block and ask the team to choose the final contract.
- `degraded: false` again confirms the daemon was connected to the server.

## Expected Source Values

OpenRouter path working:

```json
"source": "anthropic/claude-haiku-4.5"
```

Deterministic fallback:

```json
"source": "deterministic"
```

Fallback is not a failure by itself. It means OpenRouter was unavailable, timed out, returned invalid
JSON, or proposed an invalid contract. Synapse keeps the deterministic verdict and safe resolution.

## Cleanup

Stop the server and daemon terminals with `Ctrl-C`, then remove the demo files:

```bash
rm -rf /tmp/synapse-openrouter-demo
```

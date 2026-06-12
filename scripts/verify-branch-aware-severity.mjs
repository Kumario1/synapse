import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProcessTracker,
  freePort,
  postJson,
  waitForHttp,
  waitForState
} from "./lib/verify-harness.mjs";

// Branch-aware severity (M6.5): a conflict whose counterpart works on a
// *different* branch is less immediately pressing when the rule is
// dependency_changed or stale_base — those only bite at merge time — so warn
// demotes to info. Merge-blocking rules (same_symbol_active,
// same_symbol_unpushed, contract_divergent) are never demoted, same-branch
// conflicts keep their severity, and SYNAPSE_BRANCH_AWARE_SEVERITY=0 keeps
// the old behavior.
process.env.SYNAPSE_REPO_ID ??= "local";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const { startProcess, stopChildren } = createProcessTracker(rootDir);

const serverPort = await freePort();
const alicePort = await freePort(); // branch feature-x
const bobPort = await freePort(); // branch main
const carolPort = await freePort(); // branch main
const optOutPort = await freePort(); // branch main, knob off
const filePath = "src/auth/token.ts";

const worktrees = {
  alice: { branch: "feature-x", root: await mkdtemp(join(tmpdir(), "synapse-branch-alice-")) },
  bob: { branch: "main", root: await mkdtemp(join(tmpdir(), "synapse-branch-bob-")) },
  carol: { branch: "main", root: await mkdtemp(join(tmpdir(), "synapse-branch-carol-")) },
  optout: { branch: "main", root: await mkdtemp(join(tmpdir(), "synapse-branch-optout-")) }
};

try {
  // Each daemon gets its own worktree on its own branch; the daemons capture
  // the branch from `.git/HEAD`, so a no-commit `git init -b <branch>` is all
  // the fixture needs.
  for (const { branch, root } of Object.values(worktrees)) {
    const init = spawnSync("git", ["init", "-b", branch], { cwd: root, stdio: "ignore" });
    assert.equal(init.status, 0, `git init -b ${branch} failed`);
    await mkdir(join(root, "src/auth"), { recursive: true });
    await writeFixture(root, `
      export function validate(input: string): boolean {
        return input.length > 0;
      }
    `);
  }

  startProcess("server", ["apps/server/dist/index.js"], {
    SYNAPSE_SERVER_PORT: String(serverPort)
  });
  await waitForHttp(`http://localhost:${serverPort}/health`);

  startDaemon("alice", alicePort, worktrees.alice.root, {});
  startDaemon("bob", bobPort, worktrees.bob.root, {});
  startDaemon("carol", carolPort, worktrees.carol.root, {});
  startDaemon("optout", optOutPort, worktrees.optout.root, {
    SYNAPSE_BRANCH_AWARE_SEVERITY: "0"
  });
  await Promise.all([
    waitForHttp(`http://localhost:${alicePort}/health`),
    waitForHttp(`http://localhost:${bobPort}/health`),
    waitForHttp(`http://localhost:${carolPort}/health`),
    waitForHttp(`http://localhost:${optOutPort}/health`)
  ]);
  await waitForState(serverPort, (state) => state.sessions.length === 4);

  // 1. Alice (feature-x) pushes a change touching the file everyone works on.
  await push(alicePort, "alice push from feature-x");
  await waitForState(serverPort, (state) => state.recentPushes.length === 1);
  const alicePush = await fetchState(serverPort);
  assert.equal(alicePush.recentPushes[0].branch, "feature-x", "push carries its branch");

  // Bob (main): the cross-branch stale_base is demoted to info.
  const crossBranch = await check(bobPort, "bob");
  const crossStale = onlyRule(crossBranch.conflicts, "stale_base");
  assert.equal(crossStale.severity, "info", "cross-branch stale_base demoted to info");
  assert.equal(crossBranch.verdict, "info", "verdict follows the demotion");

  // Opt-out daemon on the same state keeps the warning.
  const optOut = await check(optOutPort, "optout");
  assert.equal(
    onlyRule(optOut.conflicts, "stale_base").severity,
    "warn",
    "SYNAPSE_BRANCH_AWARE_SEVERITY=0 keeps the warn"
  );

  // 2. Bob (main) pushes too: carol (main) now sees both pushes — alice's
  // cross-branch one stays info, bob's same-branch one stays warn.
  await push(bobPort, "bob push from main");
  await waitForState(serverPort, (state) => state.recentPushes.length === 2);

  const mixed = await check(carolPort, "carol");
  const staleBases = mixed.conflicts.filter((conflict) => conflict.rule === "stale_base");
  assert.equal(staleBases.length, 2, "carol sees both pushes");
  const fromAlice = staleBases.find((conflict) => conflict.detail.includes("alice push"));
  const fromBob = staleBases.find((conflict) => conflict.detail.includes("bob push"));
  assert.equal(fromAlice?.severity, "info", "cross-branch push stays demoted");
  assert.equal(fromBob?.severity, "warn", "same-branch push still warns");
  assert.equal(mixed.verdict, "warn");

  // 3. Alice changes the validate() contract incompatibly on feature-x:
  // same_symbol_unpushed is merge-blocking, so it must warn for bob even
  // though the counterpart is on another branch.
  await report(alicePort);
  await writeFixture(worktrees.alice.root, `
    export function validate(input: string): { value: string } | null {
      return input ? { value: input } : null;
    }
  `);
  await report(alicePort);
  await waitForState(serverPort, (state) => state.unpushedDeltas.length === 1);

  const neverDemoted = await check(bobPort, "bob");
  const sameSymbol = onlyRule(neverDemoted.conflicts, "same_symbol_unpushed");
  assert.equal(sameSymbol.severity, "warn", "merge-blocking rules are never demoted");
  assert.equal(sameSymbol.counterpart.branch, "feature-x", "counterpart branch is surfaced");
  assert.equal(neverDemoted.verdict, "warn");

  // 4. Mid-session checkout (plan 006): alice switches feature-x → feature-y
  // without restarting her daemon. A manual heartbeat refreshes the session
  // branch on the server, and the next check's counterpart reflects it.
  const switchBranch = spawnSync("git", ["symbolic-ref", "HEAD", "refs/heads/feature-y"], {
    cwd: worktrees.alice.root,
    stdio: "ignore"
  });
  assert.equal(switchBranch.status, 0, "branch switch in alice's worktree failed");

  await postJson(`http://localhost:${alicePort}/tools/synapse_session`, {
    repoId: "local",
    action: "heartbeat"
  });
  await waitForState(
    serverPort,
    (state) => state.sessions.find((session) => session.id === "alice")?.branch === "feature-y"
  );

  const afterSwitch = await check(bobPort, "bob");
  const refreshed = onlyRule(afterSwitch.conflicts, "same_symbol_unpushed");
  assert.equal(refreshed.counterpart.branch, "feature-y", "heartbeat refreshed the counterpart branch");
  assert.equal(refreshed.severity, "warn", "merge-blocking rule still warns after the switch");

  console.log("Branch-aware severity verification passed:");
  console.log(
    JSON.stringify(
      {
        crossBranchStaleBase: crossStale.severity,
        optOutStaleBase: "warn",
        sameBranchStaleBase: fromBob.severity,
        crossBranchSameSymbol: sameSymbol.severity,
        heartbeatRefreshedBranch: refreshed.counterpart.branch
      },
      null,
      2
    )
  );
} finally {
  await stopChildren();
  await Promise.all(
    Object.values(worktrees).map(({ root }) => rm(root, { recursive: true, force: true }))
  );
}

function onlyRule(conflicts, rule) {
  const matches = conflicts.filter((conflict) => conflict.rule === rule);
  assert.equal(matches.length, 1, `expected exactly one ${rule} conflict`);
  return matches[0];
}

function startDaemon(member, port, worktreeRoot, env) {
  startProcess(member, [
    "apps/cli/dist/index.js",
    "daemon",
    "--member", member,
    "--session", member,
    "--port", String(port),
    "--server", `ws://localhost:${serverPort}`,
    "--worktree-root", worktreeRoot
  ], env);
}

async function check(port, sessionId) {
  return postJson(`http://localhost:${port}/tools/synapse_check`, {
    repoId: "local",
    sessionId,
    files: [filePath]
  });
}

async function push(port, summary) {
  return postJson(`http://localhost:${port}/tools/synapse_push`, {
    repoId: "local",
    summary,
    files: [filePath]
  });
}

async function report(port) {
  return postJson(`http://localhost:${port}/tools/synapse_report`, {
    repoId: "local",
    sessionId: "alice",
    filePath
  });
}

async function writeFixture(root, source) {
  await writeFile(join(root, filePath), `${source.trim()}\n`);
}

async function fetchState(port) {
  const response = await fetch(`http://localhost:${port}/state?repoId=local`);
  assert.equal(response.ok, true);
  return response.json();
}

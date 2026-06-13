#!/usr/bin/env node
import { runAnalyze } from "./commands/analyze.js";
import { runCheck } from "./commands/check.js";
import { runConnect } from "./commands/connect.js";
import { runDemo } from "./commands/demo.js";
import { runDoctor } from "./commands/doctor.js";
import { runFeedback } from "./commands/feedback.js";
import { runJoin } from "./commands/join.js";
import { runKeygen } from "./commands/keygen.js";
import { runOnboard } from "./commands/onboard.js";
import { runPrBrief } from "./commands/pr-brief.js";
import { runPush } from "./commands/push.js";
import { runReport } from "./commands/report.js";
import { runSession } from "./commands/session.js";
import { runUp } from "./commands/up.js";
import { runWhatsup } from "./commands/whatsup.js";
import { runWhy } from "./commands/why.js";
import { configFromArgs } from "./config.js";
import { startDaemon } from "./daemon.js";
import { runHook } from "./hooks.js";
import { runMcp } from "./mcp.js";

const args = process.argv.slice(2);
const command = args[0] ?? "help";

switch (command) {
  case "daemon":
    await startDaemon(configFromArgs(args.slice(1)));
    break;
  case "check":
    await runCheck(args.slice(1));
    break;
  case "report":
    await runReport(args.slice(1));
    break;
  case "push":
    await runPush(args.slice(1));
    break;
  case "feedback":
    await runFeedback(args.slice(1));
    break;
  case "session":
    await runSession(args.slice(1));
    break;
  case "whatsup":
    await runWhatsup(args.slice(1));
    break;
  case "why":
    await runWhy(args.slice(1));
    break;
  case "onboard":
    await runOnboard(args.slice(1));
    break;
  case "pr-brief":
    await runPrBrief(args.slice(1));
    break;
  case "mcp":
    await runMcp(args.slice(1));
    break;
  case "join":
    await runJoin(args.slice(1));
    break;
  case "connect":
    await runConnect(args.slice(1));
    break;
  case "up":
    await runUp(args.slice(1));
    break;
  case "keygen":
    runKeygen(args.slice(1));
    break;
  case "doctor":
    await runDoctor(args.slice(1));
    break;
  case "hook":
    await runHook(args.slice(1));
    break;
  case "analyze":
    await runAnalyze(args.slice(1));
    break;
  case "demo":
    await runDemo(args.slice(1));
    break;
  case "help":
  default:
    printHelp();
    break;
}


function printHelp(): void {
  console.log(`Synapse CLI

Commands:
  daemon   Start the local daemon
  check    Call the local synapse_check endpoint
  report   Call the local synapse_report endpoint
  push     Notify Synapse that files were pushed
  feedback Record explicit acted/dismissed feedback for a conflict warning
  session  Start, heartbeat, or end a local session
  whatsup  Show the daemon's current team-state briefing
  why      Search Synapse memory with source citations
  onboard  First-session deep briefing: team digest + cited decision history
  pr-brief Local PR handoff briefing for a base/head branch pair
  mcp      Run a stdio MCP server that forwards tools to the local daemon
  join     Write .synapse/config.json, install Claude Code hooks, and connect other agents
  connect  Wire other agents (Cursor, VS Code, Gemini, Windsurf, any MCP client) to the MCP server
  up       One command: join + preflight + start daemon (--serve / --tunnel for the host)
  keygen   Mint a project-scoped key for this repo (needs SYNAPSE_MASTER_SECRET)
  doctor   Preflight a setup: identity, server reachability, auth, and live peers
  hook     Claude Code hook entrypoint (pre|post); reads hook JSON on stdin
  analyze  Extract TypeScript contract symbols from a file
  demo            run a sandboxed two-agent conflict demo (no setup)

Examples:
  synapse up                                   # teammate: inherits .synapse/team.json
  synapse up --serve --tunnel                  # host: run the server + expose it publicly
  SYNAPSE_MASTER_SECRET=… synapse keygen       # operator: mint this project's key
  SYNAPSE_PROJECT_KEY=… synapse up             # teammate: connect with the project key
  synapse doctor                               # diagnose why two machines aren't coordinating
  synapse join --member alice --session alice --port 4011 --server ws://localhost:4010
  synapse connect                              # wire every other agent to the MCP server
  synapse connect --agent cursor,vscode        # only specific agents
  synapse daemon
  synapse mcp --port 4011
  synapse pr-brief --base main --head my-branch
  synapse report --port 4011 --file src/auth/token.ts --symbol ts:src/auth/token.ts#TokenValidator.validate
  synapse push --port 4011 --file src/auth/token.ts --sha abc123 --summary "Pushed auth token changes"
  synapse check --port 4012 --file src/auth/token.ts --symbol ts:src/auth/token.ts#TokenValidator.validate
  synapse feedback --port 4012 --conflict-id conflict:abc123 --outcome acted --note "Adjusted caller"
  synapse whatsup --port 4012
  synapse why --port 4012 --question "why did auth validation change?"
  synapse analyze --file packages/analyzer-ts/src/index.ts
`);
}

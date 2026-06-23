#!/usr/bin/env node
// PROTOTYPE — throwaway. Delete or fold the winner into apps/cli/src/commands/up.ts.
//
// Question: what should the terminal UI for `synapse up --serve --tunnel` (host)
// and the teammate-join flow look like? Four radically-different directions,
// switchable live. No networking — all state is faked. See NOTES.md for the verdict.
//
// Run:    node apps/cli/prototype/up-tui.mjs
// Keys:   ←/→ or 1-4 switch variant · h/t toggle host vs teammate · q quit
// Check:  node apps/cli/prototype/up-tui.mjs --check
//
// ponytail: hand-drawn ANSI, fixed widths, fake data. Upgrade path is to port the
// winning layout into the real command with a tiny renderer, not to grow this file.

import readline from "node:readline";

// ── ANSI helpers ────────────────────────────────────────────────────────────
const E = "\x1b[";
const R = `${E}0m`;
const sgr = (code) => (s) => `${E}${code}m${s}${R}`;
const bold = sgr("1");
const dim = sgr("2");
const inv = sgr("7");
const green = sgr("32");
const cyan = sgr("36");
const mag = sgr("35");
const yellow = sgr("33");
const gray = sgr("90");
const blue = sgr("34");
const accent = (s) => `${E}38;5;213m${s}${R}`; // soft synapse-pink

const STRIP = /\x1b\[[0-9;]*m/g;
const vlen = (s) => s.replace(STRIP, "").length;
const padR = (s, w) => s + " ".repeat(Math.max(0, w - vlen(s)));
const center = (s, w) => {
  const t = Math.max(0, w - vlen(s));
  const l = Math.floor(t / 2);
  return " ".repeat(l) + s + " ".repeat(t - l);
};
const rule = (w, ch = "─") => dim(ch.repeat(w));

// Rounded box around content padded to inner width `w`.
function box(lines, w) {
  const top = dim("╭" + "─".repeat(w + 2) + "╮");
  const bot = dim("╰" + "─".repeat(w + 2) + "╯");
  const body = lines.map((l) => dim("│") + " " + padR(l, w) + " " + dim("│"));
  return [top, ...body, bot];
}
// Two fixed-width columns joined with a gutter (for the dashboard variant).
function cols(left, right, lw, rw, gutter = "  ") {
  const h = Math.max(left.length, right.length);
  const out = [];
  for (let i = 0; i < h; i++) {
    out.push(padR(left[i] ?? "", lw) + gutter + padR(right[i] ?? "", rw));
  }
  return out;
}

// ── Faked, hard-coded session state ─────────────────────────────────────────
const D = {
  ver: "0.4.1",
  repo: "acme/payments-api",
  port: 4010,
  url: "wss://calm-river-4821.synapse.live",
  code: "PAY-7F3K-92",
  token: "a7K9c2Qp…",
  host: "prince",
  mate: "sam",
  files: "1,204",
  ping: "38ms",
};
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ── Variant A — Stream (Codex/git-style sequential log, no chrome) ───────────
function variantA({ sp, joined, peers }) {
  const row = (g, k, v) => `  ${g}  ${bold(padR(k, 9))} ${v}`;
  const host = [
    bold("synapse") + "  " + dim(`v${D.ver}`),
    "",
    row(green("✓"), "identity", dim(`${D.repo} · ${D.host}@laptop`)),
    row(green("✓"), "server", dim(`listening on :${D.port}`)),
    row(green("✓"), "tunnel", cyan(D.url)),
    row(joined ? green("✓") : cyan(sp), "doctor", dim(joined ? "preflight 6/6" : "running preflight…")),
    "",
    "  " + dim("Share with your team"),
    "",
    "    " + bold("synapse join ") + accent(D.code),
    "    " + dim(`or  synapse up --join ${D.url} --token ${D.token}`),
    "    " + green("✓ ") + dim("token copied to clipboard"),
    "",
    "  " + rule(50),
    "  " + dim("Ctrl-C to stop") + dim("   ·   ") + (peers ? green(`${peers} teammate connected`) : dim("0 teammates")),
  ];
  const mate = [
    bold("synapse") + "  " + dim(`v${D.ver}`),
    "",
    row(green("✓"), "joined", dim(D.repo)),
    row(green("✓"), "connected", cyan(D.url) + dim(`  · ${D.ping}`)),
    row(green("✓"), "daemon", dim(`watching ${D.files} files`)),
    row(joined ? green("✓") : cyan(sp), "syncing", dim(joined ? "contract graph up to date" : "contract graph…")),
    "",
    "  " + dim("In session   ") + green("● ") + `${D.host} ${dim("(host)")}` + dim("   ") + green("● ") + `${D.mate} ${dim("(you)")}`,
    "",
    "  " + rule(50),
    "  " + dim("Ctrl-C to leave"),
  ];
  return { host, mate };
}

// ── Variant B — Hero card (Claude-Code welcome box, join code is the hero) ───
function variantB({ sp, joined, peers }) {
  const W = 48;
  const host = box(
    [
      "",
      accent("◇") + "  " + bold("SYNAPSE") + dim("  is live"),
      "",
      dim("Join code"),
      "  " + accent("┃ ") + bold(accent(D.code)) + dim("   (copied)"),
      "  " + dim(`or  synapse join ${D.code}`),
      "",
      `server  ${green("●")} :${D.port}` + dim("      ") + `tunnel  ${green("●")} public`,
      `repo    ${dim(D.repo)}`,
      `peers   ${peers ? green(`${peers} connected`) : dim("0 connected")}`,
      "",
    ],
    W
  );
  host.push("  " + (peers ? green("● teammate joined") : cyan(sp) + dim(" waiting for teammates…")) + dim("   Ctrl-C to stop"));

  const mate = box(
    [
      "",
      green("✓") + "  " + bold(`Connected to ${D.repo}`),
      "",
      `host   ${green("●")} ${D.host}`,
      `you    ${green("●")} ${D.mate}  ${joined ? dim("· synced") : dim("· joining")}`,
      "",
      dim("latency ") + D.ping + dim("     contracts ") + D.files + dim(" files"),
      "",
    ],
    W
  );
  mate.push("  " + green("live") + dim(" · changes sync automatically"));
  return { host, mate };
}

// ── Variant C — Dashboard (full-screen TUI: header, columns, feed, status) ───
function variantC({ sp, joined, peers }) {
  const LW = 30, RW = 36, TOT = LW + 2 + RW;
  const header = (badge) =>
    dim("┌ ") + bold("SYNAPSE") + dim(" ─ ") + cyan(D.repo) + dim(" " + "─".repeat(Math.max(1, TOT - 14 - vlen(D.repo) - vlen(badge))) + " ") + badge;
  const status = (s) => dim(" " + "─".repeat(TOT)) + "\n " + s;

  const feedHost = [
    dim("10:42 ") + "server up :" + D.port,
    dim("10:42 ") + "tunnel ready",
    dim("10:42 ") + green("doctor ✓ 6/6"),
    dim("10:43 ") + (peers ? green(`${D.mate} joined`) : dim("waiting for peers…")),
  ];
  const hostBody = cols(
    [
      bold("JOIN"),
      rule(LW),
      cyan("wss://calm-river-4821"),
      cyan("      .synapse.live"),
      "",
      dim("code  ") + accent(bold(D.code)),
      dim("token ") + D.token + green(" ✓"),
      "",
      bold("PEERS") + dim(` (${1 + peers})`),
      `${green("●")} ${D.host} ${dim("· you")}`,
      peers ? `${green("●")} ${D.mate} ${dim("· just now")}` : dim("—"),
    ],
    [bold("ACTIVITY"), rule(RW), ...feedHost],
    LW,
    RW
  );
  const host = [
    header(green("● serving") + dim(" · ") + cyan("◍ tunnel")),
    "",
    ...hostBody,
    "",
    status(dim("↑ serving · ") + (peers ? green(`${peers} teammate`) : dim("0 teammates")) + dim(" · cpu 2% · ")) + bold("Ctrl-C") + dim(" quit"),
  ];

  const feedMate = [
    dim("10:51 ") + "joined " + D.repo,
    dim("10:51 ") + green(`connected · ${D.ping}`),
    dim("10:51 ") + `daemon watching ${D.files}`,
    dim("10:52 ") + (joined ? green("graph synced") : dim("syncing…")),
  ];
  const mateBody = cols(
    [
      bold("SESSION"),
      rule(LW),
      `${green("●")} ${D.host} ${dim("· host")}`,
      `${green("●")} ${D.mate} ${dim("· you")}`,
      "",
      dim("latency  ") + D.ping,
      dim("files    ") + D.files,
    ],
    [bold("ACTIVITY"), rule(RW), ...feedMate],
    LW,
    RW
  );
  const mate = [
    header(green("● connected")),
    "",
    ...mateBody,
    "",
    status(dim("● live · auto-sync on · ")) + bold("Ctrl-C") + dim(" leave"),
  ];
  return { host, mate };
}

// ── Variant D — Calm hero (ngrok/Vercel-style whitespace + status table) ─────
function variantD({ sp, joined, peers }) {
  const W = 56;
  const tbl = (rows) =>
    [rule(W), ...rows.map(([k, v]) => " " + dim(padR(k, 10)) + v), rule(W)].map((l) => center(l, W));
  const host = [
    "",
    "",
    center(dim("Session ready — share with your team ↓"), W),
    "",
    center(cyan(bold(D.url)), W),
    center(dim("synapse join ") + accent(bold(D.code)), W),
    "",
    "",
    ...tbl([
      ["server", green("online") + dim(`   127.0.0.1:${D.port}`)],
      ["tunnel", green("online") + dim("   public")],
      ["repo", D.repo],
      ["peers", peers ? green(String(peers)) : dim("0")],
    ]),
    "",
    center((peers ? green("● teammate joined") : cyan(sp) + dim(" waiting")) + dim("  ·  Ctrl-C to stop"), W),
  ];
  const mate = [
    "",
    "",
    center(green(bold("You're in.")), W),
    center(dim(`coordinating ${D.repo}`), W),
    "",
    "",
    ...tbl([
      ["host", green("● ") + D.host],
      ["you", green("● ") + D.mate],
      ["latency", D.ping],
      ["contracts", D.files + dim(" files")],
    ]),
    "",
    center(green("live") + dim(" · changes sync automatically · Ctrl-C to leave"), W),
  ];
  return { host, mate };
}

const VARIANTS = { A: variantA, B: variantB, C: variantC, D: variantD };
const NAMES = { A: "Stream", B: "Hero", C: "Dashboard", D: "Calm" };

// ── Switcher footer (terminal equivalent of UI.md's floating bottom bar) ─────
function footer(state) {
  const seg = ["A", "B", "C", "D"]
    .map((k) => (k === state.variant ? inv(bold(` ${k} ${NAMES[k]} `)) : dim(` ${k} ${NAMES[k]} `)))
    .join(dim("·"));
  const flow =
    (state.flow === "host" ? bold(green("h HOST")) : dim("h host")) +
    dim(" / ") +
    (state.flow === "mate" ? bold(green("t TEAMMATE")) : dim("t teammate"));
  return ["", rule(67), "  " + seg, "  " + dim("←/→ or 1-4 variant   ·   ") + flow + dim("   ·   q quit")];
}

// ── Render loop ─────────────────────────────────────────────────────────────
const state = { variant: "A", flow: "host", tick: 0 };
function render() {
  const peers = state.flow === "host" ? (state.tick > 22 ? 1 : 0) : 1;
  const ctx = { sp: cyan(SPIN[state.tick % SPIN.length]), joined: state.tick > 22, peers };
  const v = VARIANTS[state.variant](ctx);
  const view = state.flow === "host" ? v.host : v.mate;
  const lines = ["", ...view.map((l) => "  " + l), ...footer(state)];
  process.stdout.write(`${E}2J${E}H` + lines.join("\n") + "\n");
}

function main() {
  process.stdout.write(`${E}?1049h${E}?25l`); // alt screen, hide cursor
  const restore = () => process.stdout.write(`${E}?25h${E}?1049l`);
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("keypress", (_s, key) => {
    if (!key) return;
    const k = key.name;
    if (k === "q" || (key.ctrl && k === "c")) {
      restore();
      process.exit(0);
    } else if (k === "right") state.variant = "ABCD"["ABCD".indexOf(state.variant) + 1] ?? "A";
    else if (k === "left") state.variant = "ABCD"["ABCD".indexOf(state.variant) - 1] ?? "D";
    else if ("1234".includes(k)) state.variant = "ABCD"["1234".indexOf(k)];
    else if (k === "h") state.flow = "host";
    else if (k === "t") state.flow = "mate";
    render();
  });
  // ponytail: single 120ms ticker drives the spinner + the faked "teammate joins"
  // transition so every variant shows a live state change. Per-event redraw if it matters.
  setInterval(() => {
    state.tick++;
    render();
  }, 120);
  render();
}

// ── Self-check (the one runnable test ponytail asks for) ────────────────────
function check() {
  const w = 20;
  const colored = green("hi") + dim(" there");
  console.assert(vlen(colored) === "hi there".length, "vlen must ignore ANSI");
  console.assert(vlen(padR(colored, w)) === w, "padR must pad to visible width");
  const b = box([green("x"), "yy"], w);
  const widths = new Set(b.map(vlen));
  console.assert(widths.size === 1, `box rows must share width, got ${[...widths]}`);
  for (const id of Object.keys(VARIANTS)) {
    const v = VARIANTS[id]({ sp: cyan("⠋"), joined: false, peers: 0 });
    console.assert(v.host.length > 0 && v.mate.length > 0, `${id} must render both flows`);
  }
  console.log("ok — vlen/padR/box aligned, all 4 variants render host+mate");
}

// Static dump of every variant × flow — for non-TTY review / screenshots.
function snapshot() {
  const ctxFor = (peers) => ({ sp: cyan("⠋"), joined: peers > 0, peers });
  for (const id of Object.keys(VARIANTS)) {
    for (const flow of ["host", "mate"]) {
      const peers = flow === "host" ? 1 : 1;
      const v = VARIANTS[id](ctxFor(peers));
      const view = flow === "host" ? v.host : v.mate;
      process.stdout.write(`\n${inv(bold(` ${id} ${NAMES[id]} `))} ${dim("·")} ${flow}\n\n`);
      process.stdout.write(view.map((l) => "  " + l).join("\n") + "\n");
    }
  }
}

if (process.argv.includes("--check")) check();
else if (process.argv.includes("--snapshot")) snapshot();
else main();

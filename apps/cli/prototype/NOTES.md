# Prototype — `synapse up` terminal UI

**Question:** What should the terminal UI look like for the host (`synapse up --serve --tunnel`)
and for a teammate joining the same server? Clean, Claude-Code/Codex-grade, minimal.

**Artifact:** `up-tui.mjs` — zero-dep, throwaway. Fakes all state (no networking).

```
node apps/cli/prototype/up-tui.mjs            # interactive: ←/→ or 1-4 variant · h/t flow · q quit
node apps/cli/prototype/up-tui.mjs --snapshot # static dump of all 4 × both flows
node apps/cli/prototype/up-tui.mjs --check     # self-check (alignment + renders)
```

## The four directions

| Key | Name | Shape | Vibe |
|-----|------|-------|------|
| A | **Stream** | sequential status lines, no chrome | Codex / git — calm, scrolls, log-like |
| B | **Hero** | one rounded card, join code is the hero | Claude-Code welcome box |
| C | **Dashboard** | full-screen, 2 columns + activity feed + status bar | htop / blessed — takes over the terminal |
| D | **Calm** | whitespace-heavy centered share block + status table | ngrok / Vercel — quiet, share-first |

Each renders both the host and the teammate flow, and shows the live `0 → 1 teammate`
transition (~2.7s in) so the dynamic state is visible.

## Verdict — _fill in after review_

- Winner: _____
- Steal from others: _____ (the useful feedback is usually "header from B + feed from C")
- Then: fold the winner into `apps/cli/src/commands/up.ts` (replace the `console.log`
  calls), and **delete this `prototype/` directory**.

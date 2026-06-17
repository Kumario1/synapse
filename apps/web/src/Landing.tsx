import {
  ArrowRightIcon,
  BotIcon,
  GaugeIcon,
  GitCompareIcon,
  LanguagesIcon,
  PlugIcon,
  ShieldCheckIcon,
  WaypointsIcon
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import TopbarAuth from "@/components/TopbarAuth";
import type { FeedMode } from "./feed";

const steps = [
  {
    label: "Check before edit",
    copy: "An agent joins a room and gets live team context — who's editing what, which symbols are locked, recent contract deltas."
  },
  {
    label: "Edit",
    copy: "Agents still write the code. Synapse stays out of the way while the work happens."
  },
  {
    label: "Report after edit",
    copy: "The contract change is recorded — before→after signatures — so the next agent avoids the collision."
  }
];

const features = [
  {
    icon: GitCompareIcon,
    title: "Contract-level conflicts",
    copy: "Compares real before→after signatures and classifies them breaking / compatible / identical / divergent — not just “same file touched.”"
  },
  {
    icon: LanguagesIcon,
    title: "Polyglot analyzers",
    copy: "TypeScript in-process, Python via a tree-sitter + jedi sidecar, Go via a go/parser sidecar. Same conflict engine for all three."
  },
  {
    icon: ShieldCheckIcon,
    title: "Deterministic first",
    copy: "Detection is never the LLM. An optional OpenRouter layer only enriches — it can raise, never downgrade, a verdict."
  },
  {
    icon: PlugIcon,
    title: "Claude Code hooks",
    copy: "synapse join installs PreToolUse / PostToolUse / SessionStart hooks so checks fire automatically — no manual tool calls."
  },
  {
    icon: BotIcon,
    title: "Any-agent onboarding",
    copy: "synapse connect registers the stdio MCP server in Cursor, VS Code/Copilot, Gemini CLI, and Windsurf, with matching rules files."
  },
  {
    icon: GaugeIcon,
    title: "Live room state",
    copy: "Members, edit locks, contract deltas, and repository events — one shared, realtime picture of what the team is doing right now."
  }
];

export default function Landing({ mode }: { mode: FeedMode }) {
  return (
    <>
      <nav
        className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-md"
        aria-label="Primary"
      >
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6 lg:px-8">
          <a className="flex items-center gap-2" href="#top">
            <WaypointsIcon className="size-5 text-primary" />
            <span className="font-heading text-lg font-medium tracking-tight">Synapse</span>
          </a>
          <div className="flex items-center gap-2">
            <Badge className="hidden sm:inline-flex" variant="secondary">
              {mode === "demo" ? "Seeded demo" : "Live server"}
            </Badge>
            <Button asChild size="sm" variant="outline">
              <a href="#dashboard">See the room</a>
            </Button>
            <TopbarAuth />
          </div>
        </div>
      </nav>

      <header className="mx-auto flex w-full max-w-7xl flex-col gap-24 px-4 pt-10 pb-16 sm:px-6 lg:px-8 lg:pt-16">
        <section
          className="grid items-center gap-12 py-4 lg:grid-cols-[1.1fr_minmax(0,0.9fr)] lg:gap-16 lg:py-8"
          id="top"
        >
          <div className="flex max-w-2xl min-w-0 flex-col gap-7">
            <Badge className="w-fit" variant="outline">
              A realtime coordination layer for coding agents
            </Badge>
            <h1 className="font-heading text-5xl leading-[0.98] font-medium tracking-tight text-balance sm:text-6xl lg:text-[4.5rem]">
              Shared context before the next edit lands.
            </h1>
            <p className="max-w-xl text-base leading-8 text-muted-foreground sm:text-lg">
              Agents still write the code. Synapse gives them current team context before they edit,
              then records contract-level changes after, so other agents avoid collisions.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg">
                <a href="#dashboard">
                  See it live
                  <ArrowRightIcon data-icon="inline-end" />
                </a>
              </Button>
              <Button asChild size="lg" variant="secondary">
                <a href="https://github.com/Kumario1/synapse" rel="noreferrer" target="_blank">
                  GitHub
                </a>
              </Button>
            </div>
            <div className="flex flex-col gap-2 pt-2">
              <span className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
                Works with
              </span>
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
                {["Claude Code", "Cursor", "Copilot", "Gemini CLI", "Windsurf"].map((agent) => (
                  <span key={agent}>{agent}</span>
                ))}
              </div>
            </div>
          </div>
          <TerminalCard />
        </section>

        <section className="flex flex-col gap-8" aria-label="How it works">
          <SectionHeading kicker="How it works" title="Check before edit. Edit. Report after." />
          <div className="grid gap-4 md:grid-cols-3">
            {steps.map(({ copy, label }, index) => (
              <Card className="bg-card/70" key={label} size="sm">
                <CardHeader>
                  <Badge className="w-fit" variant="outline">
                    {String(index + 1).padStart(2, "0")}
                  </Badge>
                  <CardTitle>{label}</CardTitle>
                  <CardDescription className="leading-6">{copy}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-8" aria-label="Features">
          <SectionHeading
            kicker="What it does"
            title="Deterministic conflict detection across your agents."
          />
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {features.map(({ copy, icon: Icon, title }) => (
              <Card className="bg-card/60 transition-colors hover:bg-card" key={title} size="sm">
                <CardHeader>
                  <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
                    <Icon className="size-4.5" />
                  </span>
                  <CardTitle className="pt-3 text-base">{title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm leading-6 text-muted-foreground">{copy}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-8" aria-label="Get started">
          <SectionHeading
            kicker="Get started"
            title="One command. Hooks and MCP wired automatically."
          />
          <Card className="bg-card/70">
            <CardContent className="flex flex-col gap-4 py-5">
              <pre className="overflow-x-auto rounded-lg border bg-background/60 p-4 font-mono text-sm leading-7">
                <code>
                  <span className="text-muted-foreground">$ </span>npx synapse join{"\n"}
                  <span className="text-primary">{"✓"}</span> hooks installed (PreToolUse /
                  PostToolUse / SessionStart){"\n"}
                  <span className="text-primary">{"✓"}</span> MCP server registered for connected
                  agents
                </code>
              </pre>
              <p className="text-sm text-muted-foreground">
                <code className="font-mono">join</code> also runs{" "}
                <code className="font-mono">connect</code>, so non-Claude agents get hook-equivalent
                behavior with zero manual setup.
              </p>
            </CardContent>
          </Card>
        </section>
      </header>
    </>
  );
}

function SectionHeading({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-xs font-medium tracking-[0.18em] text-primary uppercase">
        {kicker}
      </span>
      <h2 className="font-heading max-w-2xl text-3xl leading-[1.05] font-medium tracking-tight text-balance sm:text-[2.6rem]">
        {title}
      </h2>
    </div>
  );
}

function TerminalCard() {
  return (
    <div
      className="w-full min-w-0 overflow-hidden rounded-xl border bg-card shadow-[0_24px_60px_-30px_rgba(0,0,0,0.8)]"
      aria-hidden="true"
    >
      <div className="flex items-center gap-2 border-b bg-background/40 px-4 py-3">
        <span className="size-2.5 rounded-full bg-destructive/60" />
        <span className="size-2.5 rounded-full bg-primary/60" />
        <span className="size-2.5 rounded-full bg-chart-3/60" />
        <span className="ml-2 font-mono text-xs text-muted-foreground">synapse state.snapshot</span>
      </div>
      <div className="flex flex-col gap-3.5 p-5 font-mono text-[13px]">
        <Row label="repo" value="demo/playground" />
        <Separator />
        <div className="flex items-center justify-between">
          <span className="text-foreground">alice</span>
          <span className="text-primary">{"▸"} loadRoom</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-foreground">bob</span>
          <span className="flex items-center gap-2 text-destructive">
            {"▸"} renderRoom
            <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] tracking-wide text-destructive uppercase">
              contested
            </span>
          </span>
        </div>
        <Separator />
        <div className="flex items-center justify-between text-muted-foreground">
          <span>2 active · 1 lock</span>
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 animate-pulse rounded-full bg-chart-3" />
            live
          </span>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}

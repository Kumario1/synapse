import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon } from "lucide-react";
import type { TeamState } from "@synapse/protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { activeSessions, deriveContestedSymbols } from "./derive";
import { demoFrames } from "./fixture";
import FlowGraph from "./FlowGraph";
import { narrationSteps, type PanelKey } from "./narration";
import { CommitsPanel, OnlinePanel, SignalsPanel } from "./panels";

const stepIntervalMs = 4200;

function renderPanel(panel: PanelKey, state: TeamState): ReactNode {
  switch (panel) {
    case "online":
      return <OnlinePanel sessions={activeSessions(state)} />;
    case "signals":
      return <SignalsPanel state={state} contested={deriveContestedSymbols(state)} />;
    case "flow":
      return <FlowGraph state={state} />;
    case "commits":
      return <CommitsPanel pushes={state.recentPushes} events={state.recentRepoEvents} />;
  }
}

const panelOrder: PanelKey[] = ["online", "signals", "flow", "commits"];

export default function NarratedDemo() {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const last = narrationSteps.length - 1;

  useEffect(() => {
    if (!playing) {
      return;
    }
    const timer = window.setInterval(() => setStep((current) => (current + 1) % narrationSteps.length), stepIntervalMs);
    return () => window.clearInterval(timer);
  }, [playing]);

  const current = narrationSteps[step];
  const state = demoFrames[step];

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 pt-12 pb-16 sm:px-6 lg:px-8" id="dashboard">
      <div className="flex flex-col gap-2">
        <span className="font-mono text-xs font-medium tracking-[0.18em] text-primary uppercase">See it live</span>
        <h2 className="font-heading max-w-2xl text-3xl leading-[1.05] font-medium tracking-tight text-balance sm:text-[2.6rem]">
          A collision, caught in four steps.
        </h2>
      </div>
      <div className="flex flex-col gap-4 rounded-xl border bg-card/60 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2" aria-label={`Step ${step + 1} of ${narrationSteps.length}`}>
            {narrationSteps.map((_, index) => (
              <span
                key={index}
                className={`size-2 rounded-full transition-colors ${index === step ? "bg-primary" : "bg-muted-foreground/30"}`}
              />
            ))}
            <Badge className="ml-1" variant="secondary">
              {step + 1} / {narrationSteps.length}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button
              aria-label="Previous step"
              onClick={() => {
                setPlaying(false);
                setStep((current) => (current === 0 ? last : current - 1));
              }}
              size="icon"
              variant="outline"
            >
              <ChevronLeftIcon />
            </Button>
            <Button aria-label={playing ? "Pause" : "Autoplay"} onClick={() => setPlaying((value) => !value)} size="icon" variant="outline">
              {playing ? <PauseIcon /> : <PlayIcon />}
            </Button>
            <Button
              aria-label="Next step"
              onClick={() => {
                setPlaying(false);
                setStep((current) => (current === last ? 0 : current + 1));
              }}
              size="icon"
              variant="outline"
            >
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="font-heading text-2xl leading-tight font-medium tracking-normal sm:text-3xl">{current.title}</h2>
          <p className="max-w-3xl text-base leading-7 text-muted-foreground">{current.caption}</p>
        </div>
      </div>

      <section className="grid items-start gap-5 lg:grid-cols-2" aria-label="Synapse room walkthrough">
        {panelOrder.map((panel) => (
          <div
            key={panel}
            className={`rounded-xl transition-all duration-500 ${
              panel === current.highlight
                ? "opacity-100 ring-1 ring-primary/40 shadow-[0_0_0_4px_rgba(184,138,95,0.06)]"
                : "opacity-55 grayscale-[0.3]"
            }`}
          >
            {renderPanel(panel, state)}
          </div>
        ))}
      </section>
    </main>
  );
}

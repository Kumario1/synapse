"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { TeamState } from "@synapse/protocol";
import { activeSessions } from "../../src/derive";
import { demoFrames } from "../../src/fixture";
import FlowGraph from "../../src/FlowGraph";
import { narrationSteps, type PanelKey } from "../../src/narration";
import { CommitsPanel, OnlinePanel, SignalsPanel } from "../../src/panels";

const stepIntervalMs = 4200;
const panelOrder: PanelKey[] = ["online", "signals", "flow", "commits"];

function renderPanel(panel: PanelKey, state: TeamState): ReactNode {
  switch (panel) {
    case "online":
      return <OnlinePanel sessions={activeSessions(state)} />;
    case "signals":
      return <SignalsPanel state={state} />;
    case "flow":
      return <FlowGraph state={state} />;
    case "commits":
      return <CommitsPanel pushes={state.recentPushes} events={state.recentRepoEvents} />;
  }
}

export default function NarratedDemo() {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const last = narrationSteps.length - 1;

  useEffect(() => {
    if (!playing) {
      return;
    }
    const timer = setInterval(() => setStep((current) => (current + 1) % narrationSteps.length), stepIntervalMs);
    return () => clearInterval(timer);
  }, [playing]);

  const current = narrationSteps[step];
  const state = demoFrames[step];

  return (
    <div className="narrated" id="dashboard">
      <div className="narrated__head">
        <div className="narrated__progress" aria-label={`Step ${step + 1} of ${narrationSteps.length}`}>
          <div className="narrated__dots" aria-hidden="true">
            {narrationSteps.map((_, index) => (
              <span key={index} className={index === step ? "is-active" : ""} />
            ))}
          </div>
          <span className="narrated__count">
            {step + 1} / {narrationSteps.length}
          </span>
        </div>
        <div className="narrated__controls">
          <button
            type="button"
            aria-label="Previous step"
            onClick={() => {
              setPlaying(false);
              setStep((value) => (value === 0 ? last : value - 1));
            }}
          >
            ‹
          </button>
          <button type="button" aria-label={playing ? "Pause" : "Autoplay"} onClick={() => setPlaying((value) => !value)}>
            {playing ? "❚❚" : "▶"}
          </button>
          <button
            type="button"
            aria-label="Next step"
            onClick={() => {
              setPlaying(false);
              setStep((value) => (value === last ? 0 : value + 1));
            }}
          >
            ›
          </button>
        </div>
      </div>

      <div className="narrated__caption">
        <h3>{current.title}</h3>
        <p>{current.caption}</p>
      </div>

      <div className="narrated__grid" aria-label="Synapse room walkthrough">
        {panelOrder.map((panel) => (
          <div
            key={panel}
            className={[
              "narrated__panel",
              panel === "flow" ? "narrated__panel--wide" : "",
              panel === current.highlight ? "is-lit" : "is-dim"
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {renderPanel(panel, state)}
          </div>
        ))}
      </div>
    </div>
  );
}

import type { TeamState } from "@synapse/protocol";
import { deriveGraph } from "./derive";

const sessionX = 120;
const serverX = 420;
const symbolX = 720;

export default function FlowGraph({ state }: { state: TeamState }) {
  const graph = deriveGraph(state);
  const sessionPositions = distribute(graph.sessions.map((session) => session.id), sessionX);
  const symbolPositions = distribute(graph.symbols, symbolX);
  const server = { x: serverX, y: 180 };
  const waiting = graph.sessions.length === 0 && graph.symbols.length === 0;

  return (
    <article className="panel panel--flow">
      <header className="panel__header">
        <p className="eyebrow">Data flow</p>
        <strong>{graph.edges.length}</strong>
      </header>
      {waiting ? (
        <p className="empty">Waiting for agents and symbols.</p>
      ) : (
        <svg className="flow-graph" viewBox="0 0 840 360" role="img" aria-label="Sessions flowing through the Synapse server into symbols">
          <g className="flow-labels">
            <text x={sessionX} y="28">Sessions</text>
            <text x={serverX} y="28">Server</text>
            <text x={symbolX} y="28">Symbols</text>
          </g>
          <g>
            {graph.edges.map((edge) => {
              const from = edge.from === "server" ? server : sessionPositions.get(edge.from);
              const to = edge.to === "server" ? server : symbolPositions.get(edge.to);
              if (!from || !to) {
                return null;
              }
              const mid = (from.x + to.x) / 2;
              return (
                <path
                  className={edge.contested ? "flow-edge flow-edge--contested" : "flow-edge"}
                  d={`M ${from.x + 62} ${from.y} C ${mid} ${from.y}, ${mid} ${to.y}, ${to.x - 62} ${to.y}`}
                  key={`${edge.from}-${edge.to}`}
                />
              );
            })}
          </g>
          <g>
            {graph.sessions.map((session) => {
              const position = sessionPositions.get(session.id);
              if (!position) {
                return null;
              }
              return (
                <FlowNode
                  group="session"
                  key={session.id}
                  label={session.memberLogin ?? session.memberId}
                  sublabel={session.status}
                  x={position.x}
                  y={position.y}
                />
              );
            })}
            <FlowNode group="server" label={state.repoId} sublabel="state.snapshot" x={server.x} y={server.y} />
            {graph.symbols.map((symbol) => {
              const position = symbolPositions.get(symbol);
              if (!position) {
                return null;
              }
              return (
                <FlowNode
                  group="symbol"
                  key={symbol}
                  label={symbolLabel(symbol)}
                  sublabel={symbol.includes("#") ? symbol.split("#")[0] : "symbol"}
                  x={position.x}
                  y={position.y}
                />
              );
            })}
          </g>
        </svg>
      )}
    </article>
  );
}

function FlowNode({ group, label, sublabel, x, y }: { group: string; label: string; sublabel: string; x: number; y: number }) {
  return (
    <g className={`flow-node flow-node--${group}`} transform={`translate(${x}, ${y})`}>
      <rect x="-68" y="-24" width="136" height="48" rx="8" />
      <text y="-3">{shortLabel(label, 20)}</text>
      <text className="flow-node__sub" y="14">{shortLabel(sublabel, 22)}</text>
    </g>
  );
}

function distribute(ids: string[], x: number) {
  const positioned = new Map<string, { x: number; y: number }>();
  const gap = 280 / Math.max(ids.length, 1);
  ids.forEach((id, index) => {
    positioned.set(id, { x, y: 72 + gap * index + gap / 2 });
  });
  return positioned;
}

function symbolLabel(raw: string) {
  const [, name] = raw.split("#");
  return name || raw;
}

function shortLabel(label: string, limit: number) {
  return label.length > limit ? `${label.slice(0, limit - 3)}...` : label;
}

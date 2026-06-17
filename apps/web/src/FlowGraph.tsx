import { WorkflowIcon } from "lucide-react";
import type { TeamState } from "@synapse/protocol";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from "@/components/ui/empty";
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
    <Card className="bg-card/85 lg:col-span-2">
      <CardHeader>
        <CardTitle>Data flow</CardTitle>
        <CardDescription>Sessions flowing through Synapse into symbols currently changing.</CardDescription>
        <CardAction>
          <Badge variant="secondary">{graph.edges.length}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {waiting ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <WorkflowIcon />
              </EmptyMedia>
              <EmptyTitle>Waiting for flow</EmptyTitle>
              <EmptyDescription>Agents and symbols will appear as the room changes.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="rounded-lg border bg-muted/30">
            <svg
              className="block h-60 w-full sm:h-64"
              viewBox="0 0 840 360"
              role="img"
              aria-label="Sessions flowing through the Synapse server into symbols"
            >
              <g fill="var(--muted-foreground)" fontSize="13" textAnchor="middle">
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
                      d={`M ${from.x + 62} ${from.y} C ${mid} ${from.y}, ${mid} ${to.y}, ${to.x - 62} ${to.y}`}
                      fill="none"
                      key={`${edge.from}-${edge.to}`}
                      stroke={edge.contested ? "var(--destructive)" : "var(--primary)"}
                      strokeDasharray="8 12"
                      strokeLinecap="round"
                      strokeWidth={edge.contested ? 3 : 2}
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
                      key={session.id}
                      label={session.memberLogin ?? session.memberId}
                      sublabel={session.status}
                      tone="primary"
                      x={position.x}
                      y={position.y}
                    />
                  );
                })}
                <FlowNode label={state.repoId} sublabel="state.snapshot" tone="accent" x={server.x} y={server.y} />
                {graph.symbols.map((symbol) => {
                  const position = symbolPositions.get(symbol);
                  if (!position) {
                    return null;
                  }
                  return (
                    <FlowNode
                      key={symbol}
                      label={symbolLabel(symbol)}
                      sublabel={symbol.includes("#") ? symbol.split("#")[0] : "symbol"}
                      tone="secondary"
                      x={position.x}
                      y={position.y}
                    />
                  );
                })}
              </g>
            </svg>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FlowNode({
  label,
  sublabel,
  tone,
  x,
  y
}: {
  label: string;
  sublabel: string;
  tone: "accent" | "primary" | "secondary";
  x: number;
  y: number;
}) {
  const stroke = tone === "primary" ? "var(--primary)" : tone === "accent" ? "var(--accent)" : "var(--secondary)";

  return (
    <g transform={`translate(${x}, ${y})`}>
      <rect fill="var(--card)" height="50" rx="8" stroke={stroke} width="136" x="-68" y="-25" />
      <text fill="var(--foreground)" fontSize="12" textAnchor="middle" y="-4">
        {shortLabel(label, 20)}
      </text>
      <text fill="var(--muted-foreground)" fontSize="10" textAnchor="middle" y="14">
        {shortLabel(sublabel, 22)}
      </text>
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

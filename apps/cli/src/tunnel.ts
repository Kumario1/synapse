import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { networkInterfaces } from "node:os";
import { commandCwd } from "./config.js";

/**
 * Spawn a quick tunnel (cloudflared, else ngrok) wrapping the local server and
 * return its public `wss://` URL. Overridable via SYNAPSE_TUNNEL_CMD for tests.
 * Falls back to a LAN URL hint (and returns null) when no tunnel binary exists.
 */
export async function startTunnel(serverPort: number, children: ChildProcess[]): Promise<string | null> {
  const override = process.env.SYNAPSE_TUNNEL_CMD;
  const spec = override
    ? { cmd: "sh", args: ["-c", override] }
    : detectTunnel(serverPort);

  if (!spec) {
    console.warn("synapse: no tunnel binary found (install cloudflared: `brew install cloudflared`).");
    const lan = lanFallbackUrl(serverPort);
    if (lan) {
      console.warn(`synapse: teammates on the same network can use --server ${lan} (LAN only).`);
    }
    return null;
  }

  const child = spawn(spec.cmd, spec.args, {
    cwd: commandCwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  child.stdout?.on("data", (chunk) => process.stdout.write(`[tunnel] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[tunnel] ${chunk}`));

  const httpUrl = await captureTunnelUrl(child);
  if (!httpUrl) {
    console.warn("synapse: could not determine the tunnel URL within the timeout.");
    return null;
  }

  // The tunnel terminates TLS, so the daemon speaks wss to the public host.
  return httpUrl.replace(/^http/u, "ws");
}

function detectTunnel(serverPort: number): { cmd: string; args: string[] } | null {
  if (hasBinary("cloudflared")) {
    return { cmd: "cloudflared", args: ["tunnel", "--url", `http://localhost:${serverPort}`] };
  }
  if (hasBinary("ngrok")) {
    return { cmd: "ngrok", args: ["http", String(serverPort), "--log", "stdout"] };
  }
  return null;
}

function hasBinary(name: string): boolean {
  const lookup = process.platform === "win32" ? "where" : "which";
  try {
    return spawnSync(lookup, [name], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** Watch a tunnel child's output for its public https URL (timeout → null). */
function captureTunnelUrl(child: ChildProcess, timeoutMs = 20_000): Promise<string | null> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let buffer = "";
    const pattern =
      /https:\/\/[a-z0-9-]+\.(?:trycloudflare\.com|ngrok-free\.app|ngrok\.io|ngrok\.app)\b[^\s"']*/iu;

    const settle = (url: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      resolvePromise(url);
    };

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const match = pattern.exec(buffer);
      if (match) {
        settle(match[0]);
      }
    };

    const timer = setTimeout(() => settle(null), timeoutMs);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
  });
}

/** First non-internal IPv4 address as a ws URL, for the no-tunnel LAN fallback. */
function lanFallbackUrl(serverPort: number): string | null {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) {
        return `ws://${info.address}:${serverPort}`;
      }
    }
  }
  return null;
}


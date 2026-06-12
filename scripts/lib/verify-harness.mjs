import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";

export async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

export async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

export async function waitForHttp(url, timeoutMs = 5000) {
  await waitFor(async () => {
    const response = await fetch(url).catch(() => null);
    return response?.ok === true;
  }, timeoutMs);
}

export async function waitForState(port, predicate, timeoutMs = 5000, repoId = "local") {
  await waitFor(async () => {
    const response = await fetch(`http://localhost:${port}/state?repoId=${repoId}`).catch(() => null);
    if (!response?.ok) {
      return false;
    }
    return predicate(await response.json());
  }, timeoutMs);
}

export async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${url} failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}

export function createProcessTracker(rootDir) {
  const children = [];

  function startProcess(label, args, env) {
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.push(child);
    child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
    child.once("exit", (code, signal) => {
      if (code !== 0 && signal !== "SIGTERM") {
        process.stderr.write(`[${label}] exited with code ${code ?? signal}\n`);
      }
    });
    return child;
  }

  async function stopChildren() {
    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            child.once("exit", resolve);
            child.kill("SIGTERM");
            setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGKILL");
              }
            }, 1000).unref();
          })
      )
    );
  }

  return { startProcess, stopChildren };
}

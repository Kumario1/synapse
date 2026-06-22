import assert from "node:assert/strict";
import test from "node:test";
import type { RecallResponse } from "@synapse/protocol";
import type { RuntimeConfig } from "./config.js";
import { fetchRecall } from "./recall.js";

const config = {
  repoId: "repo",
  serverUrl: "ws://localhost:9999",
  authToken: undefined
} as unknown as RuntimeConfig;

function withFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("fetchRecall posts to the http(s) form of the server url and returns matches", async () => {
  let seenUrl = "";
  const payload: RecallResponse = {
    degraded: false,
    matches: [
      {
        kind: "session_summary",
        title: "t",
        summary: "s",
        reference: "r",
        createdAt: "c",
        score: 1
      }
    ]
  };

  await withFetch(
    async (url) => {
      seenUrl = url;
      return new Response(JSON.stringify(payload), { status: 200 });
    },
    async () => {
      const matches = await fetchRecall(config, "why?");
      assert.equal(seenUrl, "http://localhost:9999/recall");
      assert.equal(matches.length, 1);
      assert.equal(matches[0].title, "t");
    }
  );
});

test("fetchRecall returns [] when the server marks recall degraded", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({ degraded: true, matches: [] }), { status: 200 }),
    async () => {
      assert.deepEqual(await fetchRecall(config, "why?"), []);
    }
  );
});

test("fetchRecall returns [] on a non-OK status", async () => {
  await withFetch(
    async () => new Response("nope", { status: 500 }),
    async () => {
      assert.deepEqual(await fetchRecall(config, "why?"), []);
    }
  );
});

test("fetchRecall swallows network errors and returns []", async () => {
  await withFetch(
    async () => {
      throw new Error("ECONNREFUSED");
    },
    async () => {
      assert.deepEqual(await fetchRecall(config, "why?"), []);
    }
  );
});

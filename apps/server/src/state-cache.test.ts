import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyTeamState, type TeamState } from "@synapse/protocol";
import { getCachedState } from "./state-cache.js";

test("failed loads are cleared and retried on the next read", async () => {
  const cache = createCache();
  const repoId = "repo-retry";
  const failure = new Error("transient database failure");
  let calls = 0;
  const loaded = createEmptyTeamState(repoId);

  await assert.rejects(
    getCachedState(repoId, {
      ...cache,
      load: async () => {
        calls += 1;
        if (calls === 1) {
          throw failure;
        }
        return loaded;
      }
    }),
    failure
  );

  assert.equal(cache.loadsInFlight.has(repoId), false, "rejected promise is not cached");
  assert.equal(cache.dirtyRepos.has(repoId), true, "failed load keeps repo eligible for retry");

  const state = await getCachedState(repoId, {
    ...cache,
    load: async () => {
      calls += 1;
      return loaded;
    }
  });

  assert.equal(state, loaded);
  assert.equal(calls, 2);
  assert.equal(cache.dirtyRepos.has(repoId), false);
  assert.equal(cache.loadsInFlight.has(repoId), false);
});

test("concurrent reads during a load share one promise", async () => {
  const cache = createCache();
  const repoId = "repo-concurrent";
  const loaded = createEmptyTeamState(repoId);
  let calls = 0;
  let resolveLoad: (state: TeamState) => void = () => {};

  const first = getCachedState(repoId, {
    ...cache,
    load: () => {
      calls += 1;
      return new Promise<TeamState>((resolve) => {
        resolveLoad = resolve;
      });
    }
  });
  const second = getCachedState(repoId, {
    ...cache,
    load: () => {
      calls += 1;
      return Promise.resolve(createEmptyTeamState(repoId));
    }
  });

  assert.equal(calls, 1);
  resolveLoad(loaded);

  const [firstState, secondState] = await Promise.all([first, second]);
  assert.equal(firstState, loaded);
  assert.equal(secondState, loaded);
  assert.equal(cache.loadsInFlight.has(repoId), false);
});

function createCache(): {
  states: Map<string, TeamState>;
  dirtyRepos: Set<string>;
  loadsInFlight: Map<string, Promise<TeamState>>;
  createEmpty(repoId: string): TeamState;
} {
  return {
    states: new Map<string, TeamState>(),
    dirtyRepos: new Set<string>(),
    loadsInFlight: new Map<string, Promise<TeamState>>(),
    createEmpty: createEmptyTeamState
  };
}

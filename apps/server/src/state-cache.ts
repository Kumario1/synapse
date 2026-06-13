import { type TeamState } from "@synapse/protocol";

interface StateLoadCache {
  states: Map<string, TeamState>;
  dirtyRepos: Set<string>;
  loadsInFlight: Map<string, Promise<TeamState>>;
  load(repoId: string): Promise<TeamState | null>;
  createEmpty(repoId: string): TeamState;
  onLoaded?(repoId: string, state: TeamState): void;
}

export async function getCachedState(repoId: string, cache: StateLoadCache): Promise<TeamState> {
  let state = cache.states.get(repoId);
  // Cache miss or remote change: rebuild from persisted rows. One load per
  // repo is in flight at a time and every caller awaits the same promise, so
  // a slow load can never overwrite a cache entry that a faster path (or a
  // local mutation) refreshed in the meantime. Loop: a dirty mark set while a
  // load was already in flight needs one more pass to be observed.
  while (!state || cache.dirtyRepos.has(repoId)) {
    let inFlight = cache.loadsInFlight.get(repoId);
    if (!inFlight) {
      inFlight = (async () => {
        cache.dirtyRepos.delete(repoId);
        try {
          const fresh = (await cache.load(repoId)) ?? cache.createEmpty(repoId);
          cache.states.set(repoId, fresh);
          cache.onLoaded?.(repoId, fresh);
          return fresh;
        } catch (error) {
          cache.dirtyRepos.add(repoId);
          throw error;
        } finally {
          cache.loadsInFlight.delete(repoId);
        }
      })();
      cache.loadsInFlight.set(repoId, inFlight);
    }
    state = await inFlight;
  }

  return state;
}

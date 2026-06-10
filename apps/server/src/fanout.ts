import { createLogger } from "@synapse/protocol";
import type { StateStore } from "./store.js";

const log = createLogger("synapse-fanout");

/**
 * Cross-instance change notification (plan M9, selected by
 * `SYNAPSE_REDIS_URL`): after an instance applies a mutation, it PUBLISHes the
 * repo's channel; every other instance re-reads that repo from the shared
 * store (M8's per-entity rows) and re-broadcasts the fresh snapshot to its
 * local room. Redis carries no state — it is purely the wake-up signal, so
 * lock/session liveness needs no Redis TTLs: expiry stays timestamp-based
 * (`acquiredAt + ttlSec`, `lastSeen`) and every instance evaluates it at read
 * time against the shared rows, which gives the same guarantees as the 90s
 * in-memory TTL without a second source of truth.
 *
 * Unset `SYNAPSE_REDIS_URL` → this module is never imported and the server
 * keeps today's single-instance path (the `redis` driver loads lazily, like
 * `pg`, so installs that don't use it never need it).
 */
export interface Fanout {
  /**
   * Notify other instances that `repoId` changed. Fire-and-forget: awaits the
   * store's op queue first so a subscriber's re-read can never miss the rows
   * this mutation just wrote.
   */
  publish(repoId: string): void;
  close(): Promise<void>;
}

const CHANNEL_PREFIX = "synapse:repo:";

export async function createRedisFanout(options: {
  redisUrl: string;
  /** Unique per process; lets an instance ignore its own publishes. */
  instanceId: string;
  store: StateStore;
  /** Called with the repoId after a *remote* instance mutated it. */
  onRemoteChange: (repoId: string) => Promise<void>;
}): Promise<Fanout> {
  const { createClient } = await import("redis");
  const publisher = createClient({ url: options.redisUrl });
  const subscriber = publisher.duplicate();
  publisher.on("error", (error: Error) => log.error("redis.error", { error: error.message }));
  subscriber.on("error", (error: Error) => log.error("redis.error", { error: error.message }));
  await publisher.connect();
  await subscriber.connect();

  await subscriber.pSubscribe(`${CHANNEL_PREFIX}*`, (message: string, channel: string) => {
    if (message === options.instanceId) {
      return; // our own publish; the local room already got the broadcast
    }
    const repoId = channel.slice(CHANNEL_PREFIX.length);
    log.debug("fanout.remote_change", { repoId });
    void options.onRemoteChange(repoId).catch((error: unknown) => {
      log.error("fanout.refresh_failed", {
        repoId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });

  log.info("fanout.connected", { url: options.redisUrl });

  return {
    publish(repoId: string): void {
      void options.store
        .flush()
        .then(() => publisher.publish(`${CHANNEL_PREFIX}${repoId}`, options.instanceId))
        .catch((error: unknown) => {
          log.error("fanout.publish_failed", {
            repoId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
    },
    async close(): Promise<void> {
      await subscriber.close();
      await publisher.close();
    }
  };
}

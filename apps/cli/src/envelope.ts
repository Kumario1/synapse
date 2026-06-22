import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, type ClientMessage } from "@synapse/protocol";

/** Wrap a payload in a protocol envelope with a fresh id and timestamp. */
export function envelope(type: ClientMessage["type"], payload: unknown): ClientMessage {
  return {
    v: PROTOCOL_VERSION,
    type,
    id: randomUUID(),
    ts: new Date().toISOString(),
    payload
  } as ClientMessage;
}

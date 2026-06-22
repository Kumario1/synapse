import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ProtocolVersion,
  type ServerMessage,
  type WireEnvelope
} from "@synapse/protocol";

/**
 * Build a server-bound wire envelope. `version` is the per-socket negotiated
 * dialect (plan M15) so legacy clients keep seeing v1 envelopes; it defaults
 * to the current protocol version for callers that have no socket in hand.
 */
export function envelope<TType extends ServerMessage["type"]>(
  type: TType,
  payload: Extract<ServerMessage, WireEnvelope<TType>>["payload"],
  version: ProtocolVersion = PROTOCOL_VERSION
): Extract<ServerMessage, WireEnvelope<TType>> {
  return {
    v: version,
    type,
    id: randomUUID(),
    ts: new Date().toISOString(),
    payload
  } as Extract<ServerMessage, WireEnvelope<TType>>;
}

/**
 * Build a client-shaped envelope. The server synthesizes these to drive its
 * own reducer for GitHub webhooks (push/repo.event) and owner kicks
 * (session.end), so they always carry the current protocol version.
 */
export function clientEnvelope<TType extends ClientMessage["type"]>(
  type: TType,
  payload: Extract<ClientMessage, WireEnvelope<TType>>["payload"]
): Extract<ClientMessage, WireEnvelope<TType>> {
  return {
    v: PROTOCOL_VERSION,
    type,
    id: randomUUID(),
    ts: new Date().toISOString(),
    payload
  } as Extract<ClientMessage, WireEnvelope<TType>>;
}

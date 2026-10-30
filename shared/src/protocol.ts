// Runner <-> server contract. Both sides parse every incoming text message with these schemas.
//
// Text frames carry control messages (JSON). Binary frames carry browser traffic:
//   [4-byte big-endian stream id][CDP message bytes]
// One stream = one CDP WebSocket connection opened by a server-side Playwright client
// (the Playwright MCP, or a plugin script through the launch() shim) to a laptop browser.
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

// ---- runner -> server ----
export const RegisterSchema = z.object({
  type: z.literal("register"),
  protocolVersion: z.number().int(),
  runnerVersion: z.string(),
  capacity: z.number().int().min(1).max(8),
  browser: z.object({ name: z.string(), version: z.string() }),
  os: z.string(),
  features: z.array(z.string()),
});

export const RunnerMessageSchema = z.discriminatedUnion("type", [
  RegisterSchema,
  z.object({ type: z.literal("heartbeat") }),
  z.object({ type: z.literal("browser.opened"), browserId: z.string(), ok: z.boolean(), error: z.string().optional() }),
  z.object({ type: z.literal("browser.closed"), browserId: z.string(), reason: z.string() }),
  z.object({ type: z.literal("cdp.opened"), streamId: z.number().int(), ok: z.boolean(), error: z.string().optional() }),
  z.object({ type: z.literal("cdp.closed"), streamId: z.number().int(), reason: z.string().optional() }),
  // The laptop browser asked for a localhost page; the server serves it from its own loopback.
  z.object({
    type: z.literal("proxy.request"),
    reqId: z.string(),
    browserId: z.string(),
    method: z.string(),
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    body: z.string().optional(), // base64
  }),
]);
export type RunnerMessage = z.infer<typeof RunnerMessageSchema>;

// ---- server -> runner ----
export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), runnerId: z.string(), name: z.string(), heartbeatMs: z.number().int() }),
  z.object({ type: z.literal("browser.open"), browserId: z.string(), taskId: z.string() }),
  z.object({ type: z.literal("browser.close"), browserId: z.string() }),
  z.object({ type: z.literal("cdp.open"), streamId: z.number().int(), browserId: z.string() }),
  z.object({ type: z.literal("cdp.close"), streamId: z.number().int() }),
  z.object({
    type: z.literal("proxy.response"),
    reqId: z.string(),
    status: z.number().int(),
    headers: z.record(z.string(), z.string()),
    body: z.string(), // base64
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// WebSocket close codes the server uses.
export const CLOSE = {
  revoked: 4001,
  replaced: 4002,
  protocol: 4003,
} as const;

// ---- binary frames ----
export function encodeFrame(streamId: number, payload: Buffer | Uint8Array | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(streamId, 0);
  body.copy(frame, 4);
  return frame;
}

export function decodeFrame(frame: Buffer): { streamId: number; payload: Buffer } {
  return { streamId: frame.readUInt32BE(0), payload: frame.subarray(4) };
}

// Hosts the laptop browser sends back through the tunnel (the server's own loopback).
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

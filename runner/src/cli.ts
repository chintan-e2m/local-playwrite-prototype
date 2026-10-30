#!/usr/bin/env -S npx tsx
// teaming-runner: keeps an outbound connection to the Teaming-lite server and lends it
// Chromium browsers on this machine. The server can't connect in; everything travels
// over the WebSocket this process opens.
//
//   teaming-runner login --server https://teaming.example --name my-laptop
//   teaming-runner start [--server URL] [--capacity 2] [--headed]
//
// Credentials: `login` stores the runner token in ~/.teaming-runner/credentials.json (0600).
// Production would use the OS keychain. TEAMING_RUNNER_TOKEN overrides the file (containers).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import WebSocket from "ws";
import {
  CLOSE,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  decodeFrame,
  encodeFrame,
  type RunnerMessage,
} from "@tl/shared";
import { Browsers } from "./browsers.ts";

const RUNNER_VERSION = "0.1.0";
const CRED_FILE = path.join(os.homedir(), ".teaming-runner", "credentials.json");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: "string" },
    name: { type: "string" },
    capacity: { type: "string" },
    headed: { type: "boolean", default: false },
  },
});
const command = positionals[0] ?? "start";

type Credentials = { server: string; runnerId?: string; token: string };

async function loadCredentials(): Promise<Credentials | null> {
  try {
    return JSON.parse(await readFile(CRED_FILE, "utf8"));
  } catch {
    return null;
  }
}

const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- login (device flow)
async function login() {
  const server = (values.server ?? process.env.TEAMING_SERVER ?? "").replace(/\/$/, "");
  if (!server) throw new Error("--server is required");
  const name = values.name ?? os.hostname();
  const start = await fetch(`${server}/device/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!start.ok) throw new Error(`device/start failed: ${start.status}`);
  const d = (await start.json()) as { deviceCode: string; userCode: string; verifyUrl: string; interval: number; expiresIn: number };
  console.log(`\nTo connect this machine, open\n\n  ${d.verifyUrl}\n\nand enter the code\n\n  ${d.userCode}\n`);
  const deadline = Date.now() + d.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(d.interval * 1000);
    const r = await fetch(`${server}/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: d.deviceCode }),
    });
    const body = (await r.json()) as { status: string; runnerId?: string; runnerToken?: string };
    if (body.status === "approved" && body.runnerToken) {
      await mkdir(path.dirname(CRED_FILE), { recursive: true, mode: 0o700 });
      await writeFile(CRED_FILE, JSON.stringify({ server, runnerId: body.runnerId, token: body.runnerToken }, null, 2), { mode: 0o600 });
      console.log(`Approved. This machine is registered as ${name} (${body.runnerId}).\nRun: teaming-runner start`);
      return;
    }
    if (body.status === "denied" || body.status === "expired") throw new Error(`login ${body.status}`);
  }
  throw new Error("login timed out");
}

// ---------------------------------------------------------------- start
async function start() {
  const saved = await loadCredentials();
  const server = (values.server ?? process.env.TEAMING_SERVER ?? saved?.server ?? "").replace(/\/$/, "");
  const token = process.env.TEAMING_RUNNER_TOKEN ?? saved?.token;
  if (!server || !token) throw new Error("not logged in: run `teaming-runner login --server <url>` first");
  const capacity = Number(values.capacity ?? process.env.TEAMING_RUNNER_CAPACITY ?? 2);
  const browserVersion = await chromium.launch().then(async (b) => {
    const v = b.version();
    await b.close();
    return v;
  });

  let ws: WebSocket | null = null;
  const send = (msg: RunnerMessage) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const pendingProxy = new Map<string, (r: { status: number; headers: Record<string, string>; body: string }) => void>();

  const browsers = new Browsers(
    { headed: values.headed ?? false },
    (browserId, req) =>
      new Promise((resolve, reject) => {
        const reqId = `${browserId}:${Math.random().toString(36).slice(2)}`;
        const timer = setTimeout(() => {
          pendingProxy.delete(reqId);
          reject(new Error("proxy timeout"));
        }, 60_000);
        pendingProxy.set(reqId, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        send({ type: "proxy.request", reqId, browserId, ...req });
      }),
    (streamId, data) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(encodeFrame(streamId, data));
    },
    (streamId, reason) => send({ type: "cdp.closed", streamId, reason }),
    (browserId, reason) => send({ type: "browser.closed", browserId, reason }),
  );

  let backoff = 1000;
  for (;;) {
    try {
      // 1. runner token -> short-lived JWT
      const auth = await fetch(`${server}/agent/auth`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
      if (auth.status === 401) throw Object.assign(new Error("runner token rejected (revoked?)"), { fatal: true });
      if (!auth.ok) throw new Error(`auth failed: ${auth.status}`);
      const { jwt } = (await auth.json()) as { jwt: string };

      // 2. outbound WebSocket, JWT in the header
      const wsUrl = server.replace(/^http/, "ws") + "/agent/ws";
      const closeInfo = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const sock = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${jwt}` }, maxPayload: 512 * 1024 * 1024 });
        ws = sock;
        let heartbeat: NodeJS.Timeout | undefined;
        sock.once("unexpected-response", (_req, res) => reject(new Error(`websocket refused: ${res.statusCode}`)));
        sock.once("error", reject);
        sock.once("open", () => {
          // 3. register
          send({
            type: "register",
            protocolVersion: PROTOCOL_VERSION,
            runnerVersion: RUNNER_VERSION,
            capacity,
            browser: { name: "chromium", version: browserVersion },
            os: `${process.platform}-${process.arch}`,
            features: ["cdp-tunnel", "localhost-proxy", "binary-frames"],
          });
        });
        sock.on("message", async (raw, isBinary) => {
          if (isBinary) {
            const { streamId, payload } = decodeFrame(raw as Buffer);
            browsers.writeStream(streamId, payload);
            return;
          }
          const parsed = ServerMessageSchema.safeParse(JSON.parse(raw.toString()));
          if (!parsed.success) return;
          const msg = parsed.data;
          switch (msg.type) {
            case "welcome":
              backoff = 1000;
              log(`connected to ${server} as ${msg.name} (capacity ${capacity}, chromium ${browserVersion})`);
              heartbeat = setInterval(() => send({ type: "heartbeat" }), msg.heartbeatMs);
              break;
            case "browser.open":
              try {
                await browsers.open(msg.browserId, msg.taskId);
                log(`browser opened for task ${msg.taskId}`);
                send({ type: "browser.opened", browserId: msg.browserId, ok: true });
              } catch (err) {
                send({ type: "browser.opened", browserId: msg.browserId, ok: false, error: (err as Error).message });
              }
              break;
            case "browser.close":
              await browsers.close(msg.browserId);
              log(`browser closed (${msg.browserId})`);
              break;
            case "cdp.open":
              browsers.openStream(msg.streamId, msg.browserId).then(
                () => send({ type: "cdp.opened", streamId: msg.streamId, ok: true }),
                (err) => send({ type: "cdp.opened", streamId: msg.streamId, ok: false, error: (err as Error).message }),
              );
              break;
            case "cdp.close":
              browsers.closeStream(msg.streamId);
              break;
            case "proxy.response":
              pendingProxy.get(msg.reqId)?.(msg);
              pendingProxy.delete(msg.reqId);
              break;
          }
        });
        sock.once("close", (code, reason) => {
          clearInterval(heartbeat);
          resolve({ code, reason: reason.toString() });
        });
      });
      // Browsers belong to the tasks of this connection; the server fails or retries those tasks.
      browsers.closeAllStreams();
      await browsers.closeAll();
      if (closeInfo.code === CLOSE.revoked) throw Object.assign(new Error("this runner was revoked"), { fatal: true });
      if (closeInfo.code === CLOSE.protocol) throw Object.assign(new Error(`server rejected runner: ${closeInfo.reason}`), { fatal: true });
      log(`disconnected (${closeInfo.code} ${closeInfo.reason}); reconnecting`);
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal) throw err;
      log(`connection failed: ${(err as Error).message}; retrying in ${backoff / 1000}s`);
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }
}

const run = command === "login" ? login : command === "start" ? start : null;
if (!run) {
  console.error(`unknown command "${command}" (use login or start)`);
  process.exit(1);
}
run().catch((err) => {
  console.error(`teaming-runner: ${(err as Error).message}`);
  process.exit(1);
});

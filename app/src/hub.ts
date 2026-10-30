// Runner Hub: owns every runner's outbound WebSocket and the browser tunnels that ride on it.
//
//   laptop runner ──wss /agent/ws──► hub ◄──ws 127.0.0.1:TUNNEL_PORT/cdp/<browser>/<secret>── Playwright on this server
//
// A server-side Playwright client (the Playwright MCP, or a plugin script through the shim)
// connects to a loopback CDP endpoint here. Each connection becomes a stream: the hub asks
// the runner to open its own CDP connection to the task's browser and relays frames both ways.
import { randomBytes } from "node:crypto";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  CLOSE,
  LOOPBACK_HOSTS,
  PROTOCOL_VERSION,
  RunnerMessageSchema,
  decodeFrame,
  encodeFrame,
  type RunnerMessage,
  type ServerMessage,
} from "@tl/shared";
import { verifyRunnerJwt } from "./auth.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { notify } from "./events.ts";

type LiveRunner = {
  id: string;
  ownerId: string;
  name: string;
  ws: WebSocket;
  capacity: number;
  running: Set<string>; // task ids
  lastSeen: number;
  connectedAt: number;
  version: string;
  browser: string;
  os: string;
};
type LiveBrowser = {
  id: string;
  runnerId: string;
  taskId: string;
  secret: string;
  opened: { resolve: () => void; reject: (e: Error) => void };
  streams: Set<number>;
  bytesToLaptop: number;
  bytesFromLaptop: number;
  proxyRequests: number;
};
type Stream = { id: number; browserId: string; client: WebSocket; open: boolean; pending: Buffer[] };

const MAX_PROXY_BODY = 25 * 1024 * 1024;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "content-encoding", "content-length"]);

class Hub {
  private runners = new Map<string, LiveRunner>();
  private browsers = new Map<string, LiveBrowser>();
  private streams = new Map<number, Stream>();
  private nextStream = 1;

  // Set by the worker.
  onCapacity: () => void = () => {};
  onBrowserLost: (taskId: string, reason: string) => void = () => {};

  // ------------------------------------------------------------------ runner side
  attach(server: http.Server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 * 1024, perMessageDeflate: false });
    server.on("upgrade", async (req, socket, head) => {
      if (req.url !== "/agent/ws") return socket.destroy();
      const runnerId = verifyRunnerJwt(req.headers.authorization);
      const runner = runnerId ? await db.runners.findOne({ _id: runnerId, revokedAt: { $exists: false } }) : null;
      if (!runner) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.handleRunner(ws, runner._id, runner.ownerId, runner.name));
    });
    setInterval(() => this.sweep(), 5000).unref();
  }

  private handleRunner(ws: WebSocket, runnerId: string, ownerId: string, name: string) {
    const send = (m: ServerMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    let live: LiveRunner | null = null;

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        const { streamId, payload } = decodeFrame(raw as Buffer);
        const s = this.streams.get(streamId);
        const b = s && this.browsers.get(s.browserId);
        if (!s || !b || b.runnerId !== runnerId) return;
        b.bytesFromLaptop += payload.length;
        if (s.client.readyState === WebSocket.OPEN) s.client.send(payload.toString("utf8"));
        return;
      }
      let msg: RunnerMessage;
      try {
        msg = RunnerMessageSchema.parse(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (msg.type !== "register" && !live) return;
      switch (msg.type) {
        case "register": {
          if (msg.protocolVersion !== PROTOCOL_VERSION) {
            ws.close(CLOSE.protocol, `protocol ${msg.protocolVersion} not supported, update the runner`);
            return;
          }
          const previous = this.runners.get(runnerId);
          if (previous) {
            this.dropRunner(previous, "replaced by a new connection");
            previous.ws.close(CLOSE.replaced, "replaced");
          }
          live = {
            id: runnerId,
            ownerId,
            name,
            ws,
            capacity: msg.capacity,
            running: new Set(),
            lastSeen: Date.now(),
            connectedAt: Date.now(),
            version: msg.runnerVersion,
            browser: `${msg.browser.name} ${msg.browser.version}`,
            os: msg.os,
          };
          this.runners.set(runnerId, live);
          void db.runners.updateOne(
            { _id: runnerId },
            { $set: { lastSeen: new Date(), version: live.version, browser: live.browser, os: live.os, capacity: live.capacity } },
          );
          send({ type: "welcome", runnerId, name, heartbeatMs: config.heartbeatMs });
          console.log(`[hub] runner ${name} online (capacity ${msg.capacity}, ${live.browser})`);
          notify({ type: "runner", id: runnerId }, [ownerId]);
          this.onCapacity();
          break;
        }
        case "heartbeat":
          live!.lastSeen = Date.now();
          break;
        case "browser.opened": {
          const b = this.browsers.get(msg.browserId);
          if (!b || b.runnerId !== runnerId) return;
          if (msg.ok) b.opened.resolve();
          else b.opened.reject(new Error(msg.error ?? "browser failed to start"));
          break;
        }
        case "browser.closed": {
          const b = this.browsers.get(msg.browserId);
          if (b && b.runnerId === runnerId) this.onBrowserLost(b.taskId, msg.reason);
          break;
        }
        case "cdp.opened": {
          const s = this.streams.get(msg.streamId);
          if (!s) return;
          if (!msg.ok) {
            s.client.close(1011, (msg.error ?? "cdp open failed").slice(0, 120));
            return;
          }
          s.open = true;
          for (const p of s.pending) this.toRunner(s, p);
          s.pending = [];
          break;
        }
        case "cdp.closed": {
          const s = this.streams.get(msg.streamId);
          if (s) this.closeStream(s, false);
          break;
        }
        case "proxy.request":
          void this.handleProxy(runnerId, msg, send);
          break;
      }
    });

    ws.on("close", () => {
      if (live && this.runners.get(runnerId) === live) {
        this.dropRunner(live, "runner disconnected");
        console.log(`[hub] runner ${name} offline`);
      }
    });
  }

  private dropRunner(r: LiveRunner, reason: string) {
    this.runners.delete(r.id);
    for (const b of [...this.browsers.values()].filter((b) => b.runnerId === r.id)) {
      b.opened.reject(new Error(reason));
      this.forgetBrowser(b);
      this.onBrowserLost(b.taskId, reason);
    }
    void db.runners.updateOne({ _id: r.id }, { $set: { lastSeen: new Date(r.lastSeen) } });
    notify({ type: "runner", id: r.id }, [r.ownerId]);
  }

  private sweep() {
    const now = Date.now();
    for (const r of this.runners.values()) {
      if (now - r.lastSeen > config.staleAfterMs) {
        this.dropRunner(r, "runner stopped sending heartbeats");
        r.ws.terminate();
      }
    }
  }

  // The laptop browser asked for a page on this server's loopback (e.g. a QA http.server).
  private async handleProxy(runnerId: string, msg: Extract<RunnerMessage, { type: "proxy.request" }>, send: (m: ServerMessage) => void) {
    const reply = (status: number, body: string | Buffer, headers: Record<string, string> = { "content-type": "text/plain" }) =>
      send({ type: "proxy.response", reqId: msg.reqId, status, headers, body: Buffer.from(body).toString("base64") });
    const b = this.browsers.get(msg.browserId);
    if (!b || b.runnerId !== runnerId) return reply(403, "unknown browser");
    let url: URL;
    try {
      url = new URL(msg.url);
    } catch {
      return reply(400, "bad url");
    }
    const port = Number(url.port || 80);
    // Only plain HTTP on loopback, and never this server's own ports.
    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.includes(url.hostname) || port === config.port || port === config.tunnelPort) {
      return reply(403, "only the task's local QA servers are reachable");
    }
    b.proxyRequests++;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
        method: msg.method,
        headers: Object.fromEntries(Object.entries(msg.headers).filter(([k]) => k !== "host")),
        body: msg.body && !["GET", "HEAD"].includes(msg.method) ? Buffer.from(msg.body, "base64") : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_PROXY_BODY) return reply(502, "response too large");
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (!HOP_BY_HOP.has(k)) headers[k] = v;
      });
      b.bytesFromLaptop += msg.body?.length ?? 0;
      b.bytesToLaptop += body.length;
      reply(res.status, body, headers);
    } catch (err) {
      reply(502, `local server unreachable: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ worker side
  pickRunner(ownerId: string): LiveRunner | null {
    const free = [...this.runners.values()].filter((r) => r.ownerId === ownerId && r.running.size < r.capacity);
    free.sort((a, b) => a.running.size - b.running.size);
    return free[0] ?? null;
  }

  isOnline = (runnerId: string) => this.runners.has(runnerId);
  live = (runnerId: string) => {
    const r = this.runners.get(runnerId);
    return r ? { online: true, running: r.running.size, capacity: r.capacity, connectedAt: r.connectedAt, lastSeen: r.lastSeen } : { online: false };
  };
  ownerHasRunner = (ownerId: string) => [...this.runners.values()].some((r) => r.ownerId === ownerId);

  reserve(runnerId: string, taskId: string) {
    this.runners.get(runnerId)?.running.add(taskId);
  }
  release(runnerId: string, taskId: string) {
    const r = this.runners.get(runnerId);
    if (r?.running.delete(taskId)) notify({ type: "runner", id: runnerId }, [r.ownerId]);
    this.onCapacity();
  }

  // Ask the runner for a fresh browser for this task. Resolves with the loopback CDP endpoint.
  async openBrowser(runnerId: string, taskId: string): Promise<{ browserId: string; cdpEndpoint: string }> {
    const r = this.runners.get(runnerId);
    if (!r) throw new Error("runner is offline");
    const browserId = `brw_${randomBytes(6).toString("hex")}`;
    const secret = randomBytes(16).toString("hex");
    const opened = new Promise<void>((resolve, reject) => {
      this.browsers.set(browserId, {
        id: browserId,
        runnerId,
        taskId,
        secret,
        opened: { resolve, reject },
        streams: new Set(),
        bytesToLaptop: 0,
        bytesFromLaptop: 0,
        proxyRequests: 0,
      });
    });
    r.ws.send(JSON.stringify({ type: "browser.open", browserId, taskId } satisfies ServerMessage));
    const timeout = setTimeout(() => this.browsers.get(browserId)?.opened.reject(new Error("runner did not start a browser in 30 s")), 30_000);
    try {
      await opened;
    } catch (err) {
      this.browsers.delete(browserId);
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    return { browserId, cdpEndpoint: `ws://127.0.0.1:${config.tunnelPort}/cdp/${browserId}/${secret}` };
  }

  closeBrowser(browserId: string) {
    const b = this.browsers.get(browserId);
    if (!b) return;
    this.forgetBrowser(b);
    const r = this.runners.get(b.runnerId);
    if (r?.ws.readyState === WebSocket.OPEN) r.ws.send(JSON.stringify({ type: "browser.close", browserId } satisfies ServerMessage));
  }

  browserStats(browserId: string) {
    const b = this.browsers.get(browserId);
    return b ? { bytesToLaptop: b.bytesToLaptop, bytesFromLaptop: b.bytesFromLaptop, proxyRequests: b.proxyRequests } : null;
  }

  private forgetBrowser(b: LiveBrowser) {
    for (const id of b.streams) {
      const s = this.streams.get(id);
      if (s) this.closeStream(s, false);
    }
    this.browsers.delete(b.id);
  }

  // Revoking closes the open connection right away; a JWT already issued can't reconnect
  // because the upgrade re-checks the runner record.
  revoke(runnerId: string) {
    const r = this.runners.get(runnerId);
    if (!r) return;
    this.dropRunner(r, "runner revoked");
    r.ws.close(CLOSE.revoked, "revoked");
  }

  // ------------------------------------------------------------------ tunnel (loopback only)
  listenTunnel() {
    const server = http.createServer((_req, res) => {
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 * 1024, perMessageDeflate: false });
    server.on("upgrade", (req, socket, head) => {
      const m = req.url?.match(/^\/cdp\/([\w-]+)\/([0-9a-f]+)$/);
      const b = m ? this.browsers.get(m[1]) : undefined;
      if (!m || !b || b.secret !== m[2]) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (client) => this.openStream(b, client));
    });
    server.listen(config.tunnelPort, "127.0.0.1");
  }

  private openStream(b: LiveBrowser, client: WebSocket) {
    const r = this.runners.get(b.runnerId);
    if (!r) return client.close(1011, "runner offline");
    const s: Stream = { id: this.nextStream++, browserId: b.id, client, open: false, pending: [] };
    this.streams.set(s.id, s);
    b.streams.add(s.id);
    r.ws.send(JSON.stringify({ type: "cdp.open", streamId: s.id, browserId: b.id } satisfies ServerMessage));
    client.on("message", (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (s.open) this.toRunner(s, buf);
      else s.pending.push(buf);
    });
    client.on("close", () => this.closeStream(s, true));
  }

  private toRunner(s: Stream, payload: Buffer) {
    const b = this.browsers.get(s.browserId);
    const r = b && this.runners.get(b.runnerId);
    if (!b || !r || r.ws.readyState !== WebSocket.OPEN) return;
    b.bytesToLaptop += payload.length;
    r.ws.send(encodeFrame(s.id, payload));
  }

  private closeStream(s: Stream, tellRunner: boolean) {
    if (!this.streams.delete(s.id)) return;
    const b = this.browsers.get(s.browserId);
    b?.streams.delete(s.id);
    if (s.client.readyState === WebSocket.OPEN) s.client.close();
    const r = b && this.runners.get(b.runnerId);
    if (tellRunner && r?.ws.readyState === WebSocket.OPEN) r.ws.send(JSON.stringify({ type: "cdp.close", streamId: s.id } satisfies ServerMessage));
  }
}

export const hub = new Hub();

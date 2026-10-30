// One Chromium process per task, started on this machine with a CDP port on loopback.
// The server never reaches that port directly: every CDP connection it wants is opened
// here (cdp.open) and its frames are carried over the runner's own outbound WebSocket.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import WebSocket from "ws";

export type ProxyHandler = (browserId: string, req: { method: string; url: string; headers: Record<string, string>; body?: string }) =>
  Promise<{ status: number; headers: Record<string, string>; body: string }>;

type Browser = {
  id: string;
  taskId: string;
  proc: ChildProcess;
  wsEndpoint: string;
  userDataDir: string;
  proxy: http.Server;
};

const HOP_BY_HOP = new Set(["connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization"]);
const MAX_PROXY_BODY = 25 * 1024 * 1024;

export class Browsers {
  private browsers = new Map<string, Browser>();
  private streams = new Map<number, { ws: WebSocket; pending: string[] }>();

  constructor(
    private opts: { headed: boolean },
    private onProxy: ProxyHandler,
    private onStreamData: (streamId: number, data: Buffer) => void,
    private onStreamClosed: (streamId: number, reason: string) => void,
    private onBrowserExit: (browserId: string, reason: string) => void,
  ) {}

  get count() {
    return this.browsers.size;
  }

  async open(browserId: string, taskId: string): Promise<void> {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "tl-browser-"));
    const proxy = await this.startProxy(browserId);
    const proxyPort = (proxy.address() as { port: number }).port;
    const args = [
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      // All traffic goes to the runner's local proxy: loopback is sent to the server through the
      // tunnel, everything else leaves directly from this machine. Chromium normally bypasses
      // proxies for loopback; <-loopback> removes that rule. (A data: PAC file was tried and is
      // ignored by Chromium.)
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      "--proxy-bypass-list=<-loopback>",
    ];
    if (!this.opts.headed) args.push("--headless=new", "--hide-scrollbars", "--mute-audio");
    // Same default as Playwright's launch() (chromiumSandbox: false); containers can't create
    // the sandbox's user namespaces. TEAMING_CHROMIUM_SANDBOX=1 keeps it on a real machine.
    if (process.env.TEAMING_CHROMIUM_SANDBOX !== "1") args.push("--no-sandbox");
    args.push("about:blank");

    const proc = spawn(chromium.executablePath(), args, { stdio: ["ignore", "ignore", "pipe"] });
    const wsEndpoint = await new Promise<string>((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(new Error(`browser did not start: ${stderr.slice(-400)}`)), 20_000);
      proc.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      proc.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`browser exited during start (code ${code}): ${stderr.slice(-400)}`));
      });
    }).catch(async (err) => {
      proxy.close();
      await rm(userDataDir, { recursive: true, force: true });
      throw err;
    });
    proc.stderr!.resume();
    proc.once("exit", (code) => {
      if (this.browsers.has(browserId)) {
        void this.cleanup(browserId);
        this.onBrowserExit(browserId, `browser exited (code ${code})`);
      }
    });
    this.browsers.set(browserId, { id: browserId, taskId, proc, wsEndpoint, userDataDir, proxy });
  }

  async close(browserId: string) {
    const b = this.browsers.get(browserId);
    if (!b) return;
    b.proc.kill("SIGTERM");
    await this.cleanup(browserId);
  }

  async closeAll() {
    await Promise.all([...this.browsers.keys()].map((id) => this.close(id)));
  }

  private async cleanup(browserId: string) {
    const b = this.browsers.get(browserId);
    if (!b) return;
    this.browsers.delete(browserId);
    b.proxy.close();
    setTimeout(() => void rm(b.userDataDir, { recursive: true, force: true }), 1000);
  }

  // A server-side Playwright client connects: open our own CDP connection to the browser.
  openStream(streamId: number, browserId: string): Promise<void> {
    const b = this.browsers.get(browserId);
    if (!b) return Promise.reject(new Error("unknown browser"));
    const ws = new WebSocket(b.wsEndpoint, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    const entry = { ws, pending: [] as string[] };
    this.streams.set(streamId, entry);
    return new Promise((resolve, reject) => {
      ws.once("open", () => {
        for (const m of entry.pending) ws.send(m);
        entry.pending = [];
        resolve();
      });
      ws.once("error", (err) => reject(err));
      ws.on("message", (data) => this.onStreamData(streamId, data as Buffer));
      ws.on("close", () => {
        if (this.streams.delete(streamId)) this.onStreamClosed(streamId, "browser side closed");
      });
    });
  }

  // CDP is a text protocol; forward as a text frame.
  writeStream(streamId: number, payload: Buffer) {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    const text = payload.toString("utf8");
    // Several clients share the task's browser; one script's browser.close() must only end its
    // own connection, not the browser. Answer it here and drop the stream.
    if (text.includes('"Browser.close"')) {
      const msg = JSON.parse(text) as { id: number; method: string; sessionId?: string };
      if (msg.method === "Browser.close") {
        this.onStreamData(streamId, Buffer.from(JSON.stringify({ id: msg.id, result: {} })));
        setTimeout(() => {
          this.closeStream(streamId);
          this.onStreamClosed(streamId, "client closed its browser");
        }, 50);
        return;
      }
    }
    if (entry.ws.readyState === WebSocket.OPEN) entry.ws.send(text);
    else entry.pending.push(text);
  }

  closeStream(streamId: number) {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    this.streams.delete(streamId);
    entry.ws.close();
  }

  closeAllStreams() {
    for (const id of [...this.streams.keys()]) this.closeStream(id);
  }

  // The browser's proxy. Requests for the server's loopback (QA pages the task serves on the
  // server) go through the tunnel; everything else is forwarded directly from this machine,
  // so ordinary page traffic never touches the server.
  private startProxy(browserId: string): Promise<http.Server> {
    const server = http.createServer(async (req, res) => {
      const target = parseTarget(req.url);
      if (!target) {
        res.writeHead(400).end("teaming runner proxy: absolute URL required");
        return;
      }
      if (!target.loopback) {
        forwardDirect(req, res, target.url);
        return;
      }
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > MAX_PROXY_BODY) throw new Error("request body too large");
          chunks.push(chunk as Buffer);
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (v !== undefined && !HOP_BY_HOP.has(k)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
        }
        const reply = await this.onProxy(browserId, {
          method: req.method ?? "GET",
          url: req.url ?? "/",
          headers,
          body: chunks.length ? Buffer.concat(chunks).toString("base64") : undefined,
        });
        const body = Buffer.from(reply.body, "base64");
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(reply.headers)) if (!HOP_BY_HOP.has(k) && k !== "content-length") out[k] = v;
        out["content-length"] = String(body.length);
        res.writeHead(reply.status, out);
        res.end(body);
      } catch (err) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`teaming runner proxy: ${(err as Error).message}`);
      }
    });
    // HTTPS (and wss) to the internet: a plain TCP tunnel from this machine. HTTPS to the
    // server's loopback isn't supported (the plugin's QA servers there are plain HTTP).
    server.on("connect", (req, socket, head) => {
      const [host, port] = splitHostPort(req.url ?? "", 443);
      if (isLoopback(host)) {
        socket.end("HTTP/1.1 501 Not Implemented\r\n\r\n");
        return;
      }
      const upstream = net.connect(port, host, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(socket).pipe(upstream);
      });
      upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
      socket.on("error", () => upstream.destroy());
    });
    // Plain ws:// to the internet.
    server.on("upgrade", (req, socket, head) => {
      const target = parseTarget(req.url);
      if (!target || target.loopback) {
        socket.end("HTTP/1.1 501 Not Implemented\r\n\r\n");
        return;
      }
      const u = target.url;
      const upstream = net.connect(Number(u.port || 80), u.hostname, () => {
        const lines = [`${req.method} ${u.pathname}${u.search} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          if (req.rawHeaders[i].toLowerCase() !== "proxy-connection") lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        }
        upstream.write(lines.join("\r\n") + "\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(socket).pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
  }
}

const isLoopback = (host: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host.toLowerCase());

function parseTarget(raw: string | undefined): { url: URL; loopback: boolean } | null {
  try {
    const url = new URL(raw ?? "");
    if (url.protocol !== "http:") return null;
    return { url, loopback: isLoopback(url.hostname) };
  } catch {
    return null;
  }
}

function splitHostPort(authority: string, defaultPort: number): [string, number] {
  const m = authority.match(/^\[?([^\]]+?)\]?(?::(\d+))?$/);
  return [m?.[1] ?? authority, Number(m?.[2] ?? defaultPort)];
}

// Plain HTTP to the internet, streamed straight through.
function forwardDirect(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const headers = { ...req.headers };
  delete headers["proxy-connection"];
  delete headers["proxy-authorization"];
  const upstream = http.request(url, { method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.rawHeaders);
    up.pipe(res);
  });
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`teaming runner proxy: ${err.message}`);
  });
  req.pipe(upstream);
}

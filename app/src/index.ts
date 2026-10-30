import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import cookieParser from "cookie-parser";
import express from "express";
import { api, runnerRoutes } from "./api.ts";
import { config } from "./config.ts";
import { connectDb } from "./db.ts";
import { hub } from "./hub.ts";
import { ensureBucket } from "./s3.ts";
import { recoverAfterRestart } from "./worker.ts";

await connectDb();
await ensureBucket();

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.use(runnerRoutes);
app.use("/api", api);

if (existsSync(config.webDist)) {
  app.use(express.static(config.webDist, { index: false, maxAge: "1h" }));
  // Single-page app: every other GET returns index.html.
  app.get(/^\/(?!api\/|agent\/|device\/(start|token)).*/, (_req, res) => res.sendFile(path.join(config.webDist, "index.html")));
}

const server = http.createServer(app);
hub.attach(server);
hub.listenTunnel();
await recoverAfterRestart();
server.listen(config.port, () =>
  console.log(`[app] listening on :${config.port} · tunnel 127.0.0.1:${config.tunnelPort} · Claude agent mode ${config.claudeEnabled ? "on" : "off"}`),
);

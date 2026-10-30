import { createHash } from "node:crypto";

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
};

export const config = {
  port: Number(env("PORT", "8080")),
  // Internal-only listener for CDP endpoints (loopback): server-side Playwright clients connect here.
  tunnelPort: Number(env("TUNNEL_PORT", "9300")),
  publicUrl: env("PUBLIC_URL", "http://localhost:8080").replace(/\/$/, ""),
  mongoUrl: env("MONGO_URL", "mongodb://localhost:27017/teaming"),
  jwtSecret: env("JWT_SECRET"),
  runnerJwtTtlSeconds: 15 * 60,
  sessionTtlSeconds: 12 * 3600,
  heartbeatMs: 15_000,
  staleAfterMs: 45_000,
  maxConcurrentTasks: Number(env("MAX_CONCURRENT_TASKS", "4")),
  workDir: env("WORK_DIR", "/work"),
  webDist: env("WEB_DIST", new URL("../../web/dist", import.meta.url).pathname),
  pluginDir: env("PLUGIN_DIR", "/opt/dev-command/plugins/dev-command"),
  shimDir: env("SHIM_DIR", new URL("../shims", import.meta.url).pathname),
  python: env("PYTHON", "python3"),
  s3: {
    endpoint: env("S3_ENDPOINT", "http://localhost:9000"),
    publicEndpoint: env("S3_PUBLIC_ENDPOINT", "http://localhost:9000"),
    region: env("S3_REGION", "us-east-1"),
    bucket: env("S3_BUCKET", "teaming"),
    accessKeyId: env("S3_ACCESS_KEY", "minioadmin"),
    secretAccessKey: env("S3_SECRET_KEY", "minioadmin"),
  },
  // Agent mode runs Claude Code on the server; scripted mode runs without it.
  claudeEnabled: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  claudeModel: env("CLAUDE_MODEL", "claude-opus-5-5"),
  claudeMaxBudgetUsd: Number(env("CLAUDE_MAX_BUDGET_USD", "5")),
  seedPassword: env("SEED_PASSWORD", "teaming"),
  // "email:runnerName:token,..." — pre-registers runners for the Docker scenario (no device login there).
  seedRunners: env("SEED_RUNNERS", ""),
};

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

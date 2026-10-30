// Task worker: runs each task on this server while its browser runs on the assigned
// developer's machine. Two modes:
//   scripted  the dev-command plugin's own scripts + the official Playwright MCP, driven by code
//             (proves the browser migration without spending Claude tokens)
//   agent     Claude Code (Agent SDK) with the dev-command plugin; questions go to the task page
import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "./config.ts";
import { db, newId, type FileRef, type Question, type Task } from "./db.ts";
import { notify, taskEvent } from "./events.ts";
import { hub } from "./hub.ts";
import { contentTypeFor, downloadTo, uploadFile } from "./s3.ts";

const require = createRequire(import.meta.url);
const MCP_CLI = path.join(path.dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");

type Active = { abort: AbortController; answer?: (answers: Record<string, string>) => void };
const active = new Map<string, Active>();
let dispatching = false;

// ------------------------------------------------------------------ queue
export async function dispatch() {
  if (dispatching) return;
  dispatching = true;
  try {
    const queued = await db.tasks.find({ status: "queued" }).sort({ createdAt: 1 }).toArray();
    for (const task of queued) {
      if (active.size >= config.maxConcurrentTasks) break;
      const runner = hub.pickRunner(task.developerId);
      if (!runner) continue;
      hub.reserve(runner.id, task._id);
      const claimed = await db.tasks.updateOne(
        { _id: task._id, status: "queued" },
        { $set: { status: "running", runnerId: runner.id, startedAt: new Date() } },
      );
      if (!claimed.modifiedCount) {
        hub.release(runner.id, task._id);
        continue;
      }
      const entry: Active = { abort: new AbortController() };
      active.set(task._id, entry);
      void run({ ...task, status: "running", runnerId: runner.id }, runner.id, runner.name, entry);
    }
  } finally {
    dispatching = false;
  }
}

export async function recoverAfterRestart() {
  const stuck = await db.tasks.find({ status: { $in: ["running", "waiting_answer"] } }).toArray();
  for (const t of stuck) await finish(t, "failed", { error: "the server restarted while this task was running" });
  setInterval(() => void dispatch(), 5000).unref();
}

hub.onCapacity = () => void dispatch();
hub.onBrowserLost = (taskId, reason) => active.get(taskId)?.abort.abort(new Error(`${reason} (browser lost)`));

export function cancelTask(taskId: string) {
  const a = active.get(taskId);
  if (a) a.abort.abort(new Error("cancelled"));
  return Boolean(a);
}

export function answerTask(taskId: string, answers: Record<string, string>) {
  const a = active.get(taskId);
  if (!a?.answer) return false;
  a.answer(answers);
  a.answer = undefined;
  return true;
}

async function update(task: Task, set: Partial<Task>, unset?: (keyof Task)[]) {
  Object.assign(task, set);
  await db.tasks.updateOne({ _id: task._id }, { $set: set, ...(unset?.length ? { $unset: Object.fromEntries(unset.map((k) => [k, ""])) } : {}) });
  notify({ type: "task", id: task._id }, [task.clientId, task.developerId]);
}

async function finish(task: Task, status: "completed" | "failed" | "cancelled", extra: Partial<Task> = {}) {
  await update(task, { status, finishedAt: new Date(), ...extra }, ["pending"]);
}

// ------------------------------------------------------------------ one task
type Ctx = {
  task: Task;
  dir: string;
  env: NodeJS.ProcessEnv;
  cdpEndpoint: string;
  signal: AbortSignal;
  metrics: Record<string, number | string>;
  results: { file: string; label: string }[];
  step: (text: string) => Promise<void>;
  info: (text: string) => Promise<void>;
};

async function run(task: Task, runnerId: string, runnerName: string, entry: Active) {
  const dir = path.join(config.workDir, task._id);
  let browserId: string | undefined;
  const metrics: Record<string, number | string> = {};
  const started = Date.now();
  try {
    await taskEvent(task, "step", `Assigned to runner ${runnerName}`);
    await mkdir(path.join(dir, "inputs"), { recursive: true });
    for (const f of task.input.files) await downloadTo(f.key, path.join(dir, "inputs", f.name));
    if (task.input.files.length) await taskEvent(task, "info", `Downloaded ${task.input.files.length} input file(s) into the workspace`);

    await taskEvent(task, "step", `Opening a browser on ${runnerName}`);
    const t0 = Date.now();
    const opened = await hub.openBrowser(runnerId, task._id);
    browserId = opened.browserId;
    metrics.browserStartMs = Date.now() - t0;
    await taskEvent(task, "info", `Browser ready on ${runnerName} in ${metrics.browserStartMs} ms`);

    const ctx: Ctx = {
      task,
      dir,
      cdpEndpoint: opened.cdpEndpoint,
      signal: entry.abort.signal,
      metrics,
      results: [],
      env: {
        ...process.env,
        TEAMING_CDP_ENDPOINT: opened.cdpEndpoint,
        NODE_OPTIONS: `--require ${path.join(config.shimDir, "pw-remote.cjs")}`,
        PYTHONPATH: [path.join(config.shimDir, "python"), process.env.PYTHONPATH].filter(Boolean).join(":"),
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        DEV_COMMAND_NO_AUTO_INSTALL: "1",
      },
      step: (text) => taskEvent(task, "step", text),
      info: (text) => taskEvent(task, "info", text),
    };

    if (task.mode === "agent") await runAgent(ctx, entry);
    else if (task.type === "qa") await runScriptedQa(ctx);
    else throw new Error("Figma to HTML needs agent mode (Claude)");

    const results = await uploadResults(ctx);
    metrics.totalMs = Date.now() - started;
    Object.assign(metrics, prefixed(hub.browserStats(browserId)));
    await finish(task, "completed", { results, metrics });
    await taskEvent(task, "step", `Completed in ${(metrics.totalMs / 1000).toFixed(1)} s`);
  } catch (err) {
    const cancelled = entry.abort.signal.aborted && String((entry.abort.signal.reason as Error)?.message) === "cancelled";
    const message = entry.abort.signal.aborted ? (entry.abort.signal.reason as Error).message : (err as Error).message;
    metrics.totalMs = Date.now() - started;
    if (browserId) Object.assign(metrics, prefixed(hub.browserStats(browserId)));
    await taskEvent(task, "error", message);
    await finish(task, cancelled ? "cancelled" : "failed", { error: message, metrics });
  } finally {
    if (browserId) hub.closeBrowser(browserId);
    active.delete(task._id);
    hub.release(runnerId, task._id);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const prefixed = (stats: Record<string, number> | null) =>
  stats ? { tunnelBytesToLaptop: stats.bytesToLaptop, tunnelBytesFromLaptop: stats.bytesFromLaptop, proxiedRequests: stats.proxyRequests } : {};

async function uploadResults(ctx: Ctx): Promise<FileRef[]> {
  const refs: FileRef[] = [];
  for (const r of ctx.results) {
    const s = await stat(r.file).catch(() => null);
    if (!s?.isFile()) continue;
    const name = path.basename(r.file);
    const key = `projects/${ctx.task.projectId}/tasks/${ctx.task._id}/results/${refs.length}-${name}`;
    await uploadFile(key, r.file, contentTypeFor(name));
    refs.push({ key, name, size: s.size, contentType: contentTypeFor(name), label: r.label });
  }
  await ctx.info(`Uploaded ${refs.length} result file(s) to object storage`);
  return refs;
}

// Runs a command with the task's environment; rejects on non-zero exit or abort.
function exec(ctx: Ctx, cmd: string, args: string[], timeoutMs = 180_000): Promise<{ stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd: ctx.dir, env: ctx.env, signal: ctx.signal, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr, ms: Date.now() - t0 });
      else reject(new Error(`${path.basename(args[0] ?? cmd)} exited with ${code}: ${(stderr || stdout).trim().split("\n").slice(-4).join(" | ")}`));
    });
  });
}

// ------------------------------------------------------------------ scripted QA
async function runScriptedQa(ctx: Ctx) {
  const url = ctx.task.input.url;
  if (!url) throw new Error("this task has no URL");
  const scripts = path.join(config.pluginDir, "scripts");

  // 1. Plugin script (Python): the page's own CSS breakpoints, read in the laptop browser.
  await ctx.step("resolve_qa_widths.py: reading the page's breakpoints");
  let widths = [1920, 1024, 375];
  try {
    const r = await exec(ctx, config.python, [path.join(scripts, "resolve_qa_widths.py"), "--url", url, "--declared", widths.join(",")]);
    const out = JSON.parse(r.stdout) as { widths?: number[]; discovered?: number[] };
    if (out.widths?.length) widths = out.widths;
    ctx.metrics.resolveWidthsMs = r.ms;
    await ctx.info(`Widths to test: ${widths.join(", ")} (discovered from CSS: ${out.discovered?.join(", ") || "none"})`);
  } catch (err) {
    await ctx.info(`Width discovery failed, using defaults: ${(err as Error).message}`);
  }
  const shotWidths = [...new Set([Math.max(...widths), widths.find((w) => w >= 700 && w <= 1100) ?? 1024, Math.min(...widths)])];

  // 2. Plugin script (Node): the capture engine, full-page shots per width.
  await ctx.step("capture_rendered_page.js: capturing the rendered page");
  const captureDir = path.join(ctx.dir, "capture");
  try {
    const r = await exec(ctx, process.execPath, [path.join(scripts, "capture_rendered_page.js"), "--url", url, "--out", captureDir, "--width-list", shotWidths.join(",")], 300_000);
    ctx.metrics.captureMs = r.ms;
    const full = path.join(captureDir, "reference", "full");
    for (const f of (await readdir(full).catch(() => [])).sort()) ctx.results.push({ file: path.join(full, f), label: `Capture engine, ${path.parse(f).name}px` });
    ctx.results.push({ file: path.join(captureDir, "source-ir.json"), label: "Capture engine page model" });
    await ctx.info(`Capture engine finished in ${(r.ms / 1000).toFixed(1)} s`);
  } catch (err) {
    await ctx.info(`Capture engine failed: ${(err as Error).message}`);
  }

  // 3. The official Playwright MCP (what the plugin's agents call), connected to the laptop browser.
  await ctx.step("Playwright MCP: navigate, resize, measure, screenshot");
  const mcpDir = path.join(ctx.dir, "mcp");
  await mkdir(mcpDir, { recursive: true });
  const mcp = new Client({ name: "teaming-worker", version: "0.1.0" });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MCP_CLI, "--cdp-endpoint", ctx.cdpEndpoint, "--output-dir", mcpDir],
      env: ctx.env as Record<string, string>,
      cwd: ctx.dir,
      stderr: "ignore",
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    const t0 = Date.now();
    const res = (await mcp.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as { content: { type: string; text?: string }[]; isError?: boolean };
    const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (res.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
    return { text, ms: Date.now() - t0 };
  };
  const checks: { width: number; overflowPx: number; brokenImages: number; title: string }[] = [];
  let consoleErrors = "";
  try {
    const nav = await call("browser_navigate", { url });
    ctx.metrics.mcpNavigateMs = nav.ms;
    for (const w of shotWidths) {
      await call("browser_resize", { width: w, height: 1000 });
      const probe = await call("browser_evaluate", {
        function: `() => ({
          overflowPx: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
          brokenImages: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length,
          title: document.title,
        })`,
      });
      const m = parseEvaluateResult<{ overflowPx: number; brokenImages: number; title: string }>(probe.text) ?? { overflowPx: -1, brokenImages: -1, title: "" };
      if (m.overflowPx < 0) await ctx.info(`Could not read the evaluate result: ${probe.text.slice(0, 200)}`);
      checks.push({ width: w, ...m });
      const shot = path.join(mcpDir, `mcp-${w}px.png`);
      const s = await call("browser_take_screenshot", { type: "png", fullPage: true, filename: shot });
      ctx.metrics[`mcpScreenshot${w}Ms`] = s.ms;
      ctx.results.push({ file: shot, label: `Playwright MCP, ${w}px full page` });
      await ctx.info(`${w}px: screenshot in ${s.ms} ms, horizontal overflow ${m.overflowPx} px, broken images ${m.brokenImages}`);
    }
    consoleErrors = (await call("browser_console_messages", { level: "error" })).text;

    // 4. The report is served from this server's loopback and opened in the laptop browser,
    //    the same path the plugin's QA servers (python -m http.server) take.
    await ctx.step("Report: rendering it in the laptop browser through the localhost tunnel");
    const reportDir = path.join(ctx.dir, "report");
    await mkdir(reportDir, { recursive: true });
    const reportFile = path.join(reportDir, "report.html");
    await writeFile(reportFile, renderReport(url, widths, checks, consoleErrors, ctx.results));
    const server = await serveLocally(ctx, reportDir);
    try {
      await call("browser_resize", { width: 1280, height: 900 });
      await call("browser_navigate", { url: `http://127.0.0.1:${server.port}/report.html` });
      const preview = path.join(mcpDir, "report-preview.png");
      await call("browser_take_screenshot", { type: "png", fullPage: true, filename: preview });
      ctx.results.unshift({ file: preview, label: "Report, rendered on the laptop" });
      await ctx.info(`Report rendered on the laptop from 127.0.0.1:${server.port} on the server`);
    } finally {
      server.close();
    }
    ctx.results.unshift({ file: reportFile, label: "QA report" });
  } finally {
    await mcp.close().catch(() => {});
  }
  const issues = checks.filter((c) => c.overflowPx > 0 || c.brokenImages > 0).length;
  await update(ctx.task, {
    summary: `${checks.length} widths checked; ${issues ? `${issues} with layout issues` : "no overflow or broken images"}; ${consoleErrors.includes("[ERROR]") ? "console errors present" : "no console errors"}`,
  });
}

// browser_evaluate answers in markdown: a "### Result" section holding the value as JSON.
function parseEvaluateResult<T>(text: string): T | null {
  const section = text.match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/)?.[1]?.trim().replace(/^```\w*\n?|\n?```$/g, "");
  if (!section) return null;
  try {
    let value: unknown = JSON.parse(section);
    if (typeof value === "string") value = JSON.parse(value);
    return value as T;
  } catch {
    return null;
  }
}

function serveLocally(ctx: Ctx, dir: string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, ["-u", "-m", "http.server", "0", "--bind", "127.0.0.1"], { cwd: dir, env: ctx.env });
    const timer = setTimeout(() => reject(new Error("local http.server did not start")), 10_000);
    child.stdout.on("data", (d: Buffer) => {
      const m = d.toString().match(/port (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ port: Number(m[1]), close: () => child.kill() });
      }
    });
    child.on("error", reject);
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function renderReport(url: string, widths: number[], checks: { width: number; overflowPx: number; brokenImages: number; title: string }[], consoleText: string, results: { file: string; label: string }[]) {
  const rows = checks
    .map((c) => `<tr><td>${c.width}px</td><td class="${c.overflowPx > 0 ? "bad" : "ok"}">${c.overflowPx} px</td><td class="${c.brokenImages > 0 ? "bad" : "ok"}">${c.brokenImages}</td></tr>`)
    .join("");
  const errors = consoleText.split("\n").filter((l) => l.includes("[ERROR]")).slice(0, 10);
  return `<!doctype html><html><head><meta charset="utf-8"><title>QA report</title>
<style>
body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2328;background:#fff;margin:40px auto;max-width:880px;padding:0 24px}
h1{font-size:22px;font-weight:600;margin:0 0 4px}.muted{color:#6b7280}h2{font-size:15px;font-weight:600;margin:28px 0 8px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e5e7eb;padding:8px 10px;text-align:left}th{font-weight:500;color:#6b7280}
.ok{color:#15803d}.bad{color:#b91c1c}ul{padding-left:18px}code{font:12px ui-monospace,monospace;background:#f3f4f6;padding:1px 4px;border-radius:4px}
</style></head><body>
<h1>Visual QA report</h1><div class="muted">${esc(url)} · ${new Date().toUTCString()}</div>
<h2>Widths</h2><p>Planned from the page's own CSS by the plugin's <code>resolve_qa_widths.py</code>: ${widths.join(", ")}</p>
<h2>Layout checks (Playwright MCP, laptop browser)</h2>
<table><tr><th>Width</th><th>Horizontal overflow</th><th>Broken images</th></tr>${rows}</table>
<h2>Console errors</h2>${errors.length ? `<ul>${errors.map((e) => `<li><code>${esc(e.slice(0, 200))}</code></li>`).join("")}</ul>` : '<p class="ok">None</p>'}
<h2>Artifacts</h2><ul>${results.map((r) => `<li>${esc(r.label)}</li>`).join("")}</ul>
<p class="muted">Rendered in Chromium on the developer machine; the server ran the plugin scripts and Playwright MCP without a local browser.</p>
</body></html>`;
}

// ------------------------------------------------------------------ agent mode (Claude Code)
async function runAgent(ctx: Ctx, entry: Active) {
  if (!config.claudeEnabled) throw new Error("agent mode needs CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY on the server");
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const task = ctx.task;
  const inputs = task.input.files.map((f) => `./inputs/${f.name}`).join(", ") || "none";
  const prompt =
    task.type === "qa"
      ? `Run a visual QA audit of ${task.input.url} with the dev-command plugin's QA approach (qa / visual-regression-auditor). ` +
        `Test the widths the page's own CSS needs. Save the final HTML report and every screenshot you want the client to see into ./results/. ` +
        `Notes from the client: ${task.input.notes || "none"}.`
      : `Build a static Figma-to-HTML page with the dev-command plugin (/dev-start, static Figma-to-HTML route, then build). ` +
        `Design inputs: ${inputs}. Notes from the client: ${task.input.notes || "none"}. ` +
        `When it is done, copy the finished package and the QA report into ./results/.`;
  const system =
    "You run on the Teaming server. The Playwright MCP server named `playwright` is already connected; its browser runs on the assigned developer's machine. " +
    "Do not install or reconfigure Playwright or browsers, and do not restart Claude Code. Plugin scripts that launch Chromium are redirected to the same remote browser automatically. " +
    "Ask the developer with AskUserQuestion when the plugin needs a decision.";

  await mkdir(path.join(ctx.dir, "results"), { recursive: true });
  await ctx.step("Claude Code: starting the dev-command plugin");
  const q = query({
    prompt,
    options: {
      cwd: ctx.dir,
      model: config.claudeModel,
      env: ctx.env as Record<string, string>,
      plugins: [{ type: "local", path: config.pluginDir }],
      mcpServers: {
        playwright: { type: "stdio", command: process.execPath, args: [MCP_CLI, "--cdp-endpoint", ctx.cdpEndpoint, "--output-dir", path.join(ctx.dir, "mcp")], env: ctx.env as Record<string, string> },
      },
      systemPrompt: { type: "preset", preset: "claude_code", append: system },
      settingSources: ["project"],
      permissionMode: "default",
      maxBudgetUsd: config.claudeMaxBudgetUsd,
      abortController: entry.abort,
      canUseTool: async (toolName, input) => {
        if (toolName !== "AskUserQuestion") return { behavior: "allow", updatedInput: input };
        const answers = await askDeveloper(ctx, entry, (input.questions ?? []) as Question[]);
        return { behavior: "allow", updatedInput: { ...input, answers } };
      },
    },
  });
  for await (const msg of q) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text.trim()) await taskEvent(task, "claude", block.text.trim());
        else if (block.type === "tool_use") await taskEvent(task, "tool", describeTool(block.name, block.input as Record<string, unknown>));
      }
    } else if (msg.type === "result") {
      ctx.metrics.claudeCostUsd = Number(msg.total_cost_usd.toFixed(4));
      ctx.metrics.claudeTurns = msg.num_turns;
      ctx.metrics.claudeMs = msg.duration_ms;
      if (msg.subtype !== "success" || msg.is_error) throw new Error(`Claude stopped: ${msg.subtype}`);
      await update(task, { summary: msg.result.slice(0, 1000) });
    }
  }
  for (const f of await walk(path.join(ctx.dir, "results"))) ctx.results.push({ file: f, label: path.relative(path.join(ctx.dir, "results"), f) });
}

async function askDeveloper(ctx: Ctx, entry: Active, questions: Question[]): Promise<Record<string, string>> {
  const pending = { id: newId("q"), questions, askedAt: new Date() };
  await update(ctx.task, { status: "waiting_answer", pending });
  await taskEvent(ctx.task, "question", questions.map((q) => q.question).join(" / "));
  const answers = await new Promise<Record<string, string>>((resolve, reject) => {
    entry.answer = resolve;
    ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
  });
  await update(ctx.task, { status: "running" }, ["pending"]);
  await taskEvent(ctx.task, "answer", Object.entries(answers).map(([q, a]) => `${q}: ${a}`).join(" / "));
  return answers;
}

function describeTool(name: string, input: Record<string, unknown>) {
  const short = name.replace(/^mcp__playwright__/, "browser: ").replace(/^mcp__/, "");
  const detail = (input.url ?? input.command ?? input.file_path ?? input.description ?? "") as string;
  return `${short}${detail ? ` ${String(detail).slice(0, 160)}` : ""}`;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out.slice(0, 200);
}

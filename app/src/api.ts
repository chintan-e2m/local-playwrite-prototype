import { randomBytes, randomInt } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { canSeeTask, checkPassword, clearSession, issueRunnerJwt, requireRole, requireUser, setSession, taskFilter, type SessionUser } from "./auth.ts";
import { config, sha256 } from "./config.ts";
import { db, newId, type Task } from "./db.ts";
import { notify, sse } from "./events.ts";
import { hub } from "./hub.ts";
import { presignGet, presignPut } from "./s3.ts";
import { answerTask, cancelTask, dispatch } from "./worker.ts";

const me = (res: Response) => res.locals.user as SessionUser;
const bad = (res: Response, error: string, status = 400) => res.status(status).json({ error });

// ------------------------------------------------------------------ runner endpoints (no user session)
export const runnerRoutes = Router();

runnerRoutes.post("/agent/auth", async (req, res) => {
  const issued = await issueRunnerJwt(req.header("authorization"));
  if (!issued) return bad(res, "invalid runner token", 401);
  res.json(issued);
});

// Device flow: the runner asks for a code, the developer approves it in the web app.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const userCode = () => Array.from({ length: 8 }, (_, i) => (i === 4 ? "-" : "") + USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join("");

runnerRoutes.post("/device/start", async (req, res) => {
  const name = z.object({ name: z.string().min(1).max(60) }).safeParse(req.body);
  if (!name.success) return bad(res, "name required");
  const deviceCode = randomBytes(32).toString("hex");
  const code = userCode();
  await db.devices.insertOne({ _id: sha256(deviceCode), userCode: code, name: name.data.name, status: "pending", expiresAt: new Date(Date.now() + 10 * 60_000) });
  res.json({ deviceCode, userCode: code, verifyUrl: `${config.publicUrl}/device`, interval: 3, expiresIn: 600 });
});

runnerRoutes.post("/device/token", async (req, res) => {
  const deviceCode = String(req.body?.deviceCode ?? "");
  const d = await db.devices.findOne({ _id: sha256(deviceCode) });
  if (!d || d.expiresAt < new Date()) return res.json({ status: "expired" });
  if (d.status !== "approved" || !d.token) return res.json({ status: d.status });
  // The plaintext token is handed out exactly once; only its hash stays on the server.
  await db.devices.deleteOne({ _id: d._id });
  res.json({ status: "approved", runnerId: d.runnerId, runnerToken: d.token });
});

// ------------------------------------------------------------------ user API
export const api = Router();

api.post("/auth/login", async (req, res) => {
  const body = z.object({ email: z.string(), password: z.string() }).safeParse(req.body);
  const user = body.success ? await checkPassword(body.data.email, body.data.password) : null;
  if (!user) return bad(res, "wrong email or password", 401);
  setSession(res, user);
  res.json({ _id: user._id, email: user.email, name: user.name, role: user.role });
});
api.post("/auth/logout", (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

api.use(requireUser);
api.get("/me", (_req, res) => res.json({ ...me(res), claudeEnabled: config.claudeEnabled }));
api.get("/events", sse);

api.get("/users", requireRole("admin", "client"), async (req, res) => {
  const role = req.query.role === "developer" ? "developer" : undefined;
  res.json(await db.users.find(role ? { role } : {}, { projection: { passwordHash: 0, salt: 0 } }).sort({ name: 1 }).toArray());
});

// ---- projects
api.get("/projects", async (_req, res) => {
  const u = me(res);
  const filter = u.role === "admin" ? {} : u.role === "client" ? { clientId: u._id } : { developerId: u._id };
  const projects = await db.projects.find(filter).sort({ createdAt: -1 }).toArray();
  const names = await userNames();
  res.json(projects.map((p) => ({ ...p, clientName: names.get(p.clientId), developerName: names.get(p.developerId) })));
});

api.post("/projects", requireRole("admin", "client"), async (req, res) => {
  const body = z.object({ name: z.string().min(1).max(120), developerId: z.string(), siteUrl: z.string().url().optional().or(z.literal("")), clientId: z.string().optional() }).safeParse(req.body);
  if (!body.success) return bad(res, "name and developer are required");
  const dev = await db.users.findOne({ _id: body.data.developerId, role: "developer" });
  if (!dev) return bad(res, "unknown developer");
  const u = me(res);
  const clientId = u.role === "admin" && body.data.clientId ? body.data.clientId : u._id;
  const project = { _id: newId("prj"), name: body.data.name, clientId, developerId: dev._id, siteUrl: body.data.siteUrl || undefined, createdAt: new Date() };
  await db.projects.insertOne(project);
  res.status(201).json(project);
});

// ---- uploads (pre-signed PUT straight to object storage)
api.post("/uploads", requireRole("admin", "client"), async (req, res) => {
  const body = z.object({ filename: z.string().min(1).max(200), contentType: z.string().max(100) }).safeParse(req.body);
  if (!body.success) return bad(res, "filename required");
  const safe = body.data.filename.replace(/[^\w.\-]+/g, "_");
  const key = `uploads/${me(res)._id}/${randomBytes(8).toString("hex")}/${safe}`;
  res.json({ key, url: await presignPut(key, body.data.contentType || "application/octet-stream") });
});

// ---- tasks
const NewTask = z.object({
  projectId: z.string(),
  title: z.string().min(1).max(160),
  type: z.enum(["qa", "figma-html"]),
  mode: z.enum(["scripted", "agent"]),
  url: z.string().url().optional().or(z.literal("")),
  notes: z.string().max(4000).optional(),
  files: z.array(z.object({ key: z.string(), name: z.string(), size: z.number(), contentType: z.string() })).max(10).default([]),
});

api.post("/tasks", requireRole("admin", "client"), async (req, res) => {
  const body = NewTask.safeParse(req.body);
  if (!body.success) return bad(res, body.error.issues[0]?.message ?? "invalid task");
  const t = body.data;
  const u = me(res);
  const project = await db.projects.findOne({ _id: t.projectId });
  if (!project || (u.role !== "admin" && project.clientId !== u._id)) return bad(res, "unknown project", 404);
  if (t.type === "qa" && !t.url) return bad(res, "a QA task needs a URL");
  if (t.type === "figma-html" && t.mode !== "agent") return bad(res, "Figma to HTML runs in agent mode");
  if (t.mode === "agent" && !config.claudeEnabled) return bad(res, "agent mode is not configured on this server");
  if (t.files.some((f) => !f.key.startsWith(`uploads/${u._id}/`))) return bad(res, "unknown upload");
  const task: Task = {
    _id: newId("tsk"),
    projectId: project._id,
    clientId: project.clientId,
    developerId: project.developerId,
    title: t.title,
    type: t.type,
    mode: t.mode,
    input: { url: t.url || undefined, notes: t.notes, files: t.files },
    status: "queued",
    results: [],
    createdAt: new Date(),
  };
  await db.tasks.insertOne(task);
  await db.events.insertOne({ taskId: task._id, ts: new Date(), kind: "step", text: `Created by ${u.name}` });
  notify({ type: "task", id: task._id }, [task.clientId, task.developerId]);
  void dispatch();
  res.status(201).json(task);
});

api.get("/tasks", async (_req, res) => {
  const tasks = await db.tasks.find(taskFilter(me(res))).sort({ createdAt: -1 }).limit(200).toArray();
  res.json(await decorate(tasks));
});

async function loadTask(req: Request, res: Response): Promise<Task | null> {
  const task = await db.tasks.findOne({ _id: String(req.params.id) });
  if (!task || !canSeeTask(me(res), task)) {
    bad(res, "not found", 404);
    return null;
  }
  return task;
}

api.get("/tasks/:id", async (req, res) => {
  const task = await loadTask(req, res);
  if (!task) return;
  const [decorated] = await decorate([task]);
  const events = await db.events.find({ taskId: task._id }).sort({ ts: 1 }).limit(1000).toArray();
  res.json({ ...decorated, events });
});

api.get("/tasks/:id/files/:index", async (req, res) => {
  const task = await loadTask(req, res);
  if (!task) return;
  const list = req.query.input ? task.input.files : task.results;
  const f = list[Number(req.params.index)];
  if (!f) return bad(res, "not found", 404);
  res.redirect(302, await presignGet(f.key, f.name));
});

api.post("/tasks/:id/answer", async (req, res) => {
  const task = await loadTask(req, res);
  if (!task) return;
  const u = me(res);
  if (u.role !== "admin" && task.developerId !== u._id) return bad(res, "only the assigned developer can answer", 403);
  const body = z.object({ questionId: z.string(), answers: z.record(z.string(), z.string()) }).safeParse(req.body);
  if (!body.success || task.pending?.id !== body.data.questionId) return bad(res, "no such question");
  if (!answerTask(task._id, body.data.answers)) return bad(res, "the task is not waiting for an answer", 409);
  res.json({ ok: true });
});

api.post("/tasks/:id/cancel", async (req, res) => {
  const task = await loadTask(req, res);
  if (!task) return;
  if (task.status === "queued") {
    await db.tasks.updateOne({ _id: task._id, status: "queued" }, { $set: { status: "cancelled", finishedAt: new Date() } });
    notify({ type: "task", id: task._id }, [task.clientId, task.developerId]);
  } else if (!cancelTask(task._id)) return bad(res, "the task is not running", 409);
  res.json({ ok: true });
});

api.post("/tasks/:id/retry", async (req, res) => {
  const task = await loadTask(req, res);
  if (!task) return;
  if (!["failed", "cancelled"].includes(task.status)) return bad(res, "only failed or cancelled tasks can be retried", 409);
  await db.tasks.updateOne({ _id: task._id }, { $set: { status: "queued", results: [] }, $unset: { error: "", runnerId: "", finishedAt: "", startedAt: "", summary: "", metrics: "" } });
  await db.events.insertOne({ taskId: task._id, ts: new Date(), kind: "step", text: `Retried by ${me(res).name}` });
  notify({ type: "task", id: task._id }, [task.clientId, task.developerId]);
  void dispatch();
  res.json({ ok: true });
});

async function userNames() {
  const users = await db.users.find({}, { projection: { name: 1 } }).toArray();
  return new Map(users.map((u) => [u._id, u.name]));
}

async function decorate(tasks: Task[]) {
  const names = await userNames();
  const projects = new Map((await db.projects.find({ _id: { $in: [...new Set(tasks.map((t) => t.projectId))] } }).toArray()).map((p) => [p._id, p.name]));
  const runners = new Map((await db.runners.find({ _id: { $in: tasks.map((t) => t.runnerId).filter(Boolean) as string[] } }).toArray()).map((r) => [r._id, r.name]));
  return tasks.map((t) => ({
    ...t,
    projectName: projects.get(t.projectId),
    clientName: names.get(t.clientId),
    developerName: names.get(t.developerId),
    runnerName: t.runnerId ? runners.get(t.runnerId) : undefined,
    developerOnline: hub.ownerHasRunner(t.developerId),
  }));
}

// ---- runners
api.get("/runners", requireRole("admin", "developer"), async (_req, res) => {
  const u = me(res);
  const runners = await db.runners.find(u.role === "admin" ? {} : { ownerId: u._id }, { projection: { tokenHash: 0 } }).sort({ createdAt: -1 }).toArray();
  const names = await userNames();
  res.json(runners.map((r) => ({ ...r, ownerName: names.get(r.ownerId), ...hub.live(r._id) })));
});

api.post("/runners/:id/revoke", requireRole("admin", "developer"), async (req, res) => {
  const u = me(res);
  const r = await db.runners.findOne({ _id: String(req.params.id) });
  if (!r || (u.role !== "admin" && r.ownerId !== u._id)) return bad(res, "not found", 404);
  await db.runners.updateOne({ _id: r._id }, { $set: { revokedAt: new Date() } });
  hub.revoke(r._id);
  notify({ type: "runner", id: r._id }, [r.ownerId]);
  res.json({ ok: true });
});

api.post("/device/approve", requireRole("developer", "admin"), async (req, res) => {
  const code = String(req.body?.userCode ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  const formatted = `${code.slice(0, 4)}-${code.slice(4, 8)}`;
  const d = await db.devices.findOne({ userCode: formatted, status: "pending", expiresAt: { $gt: new Date() } });
  if (!d) return bad(res, "that code is not valid or has expired", 404);
  if (req.body?.deny) {
    await db.devices.updateOne({ _id: d._id }, { $set: { status: "denied" } });
    return res.json({ ok: true, denied: true });
  }
  const token = `rt_${randomBytes(32).toString("base64url")}`;
  const runnerId = newId("rnr");
  await db.runners.insertOne({ _id: runnerId, ownerId: me(res)._id, name: d.name, tokenHash: sha256(token), createdAt: new Date() });
  await db.devices.updateOne({ _id: d._id }, { $set: { status: "approved", ownerId: me(res)._id, runnerId, token } });
  res.json({ ok: true, name: d.name });
});

api.get("/device/lookup", requireRole("developer", "admin"), async (req, res) => {
  const code = String(req.query.code ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  const d = await db.devices.findOne({ userCode: `${code.slice(0, 4)}-${code.slice(4, 8)}`, status: "pending", expiresAt: { $gt: new Date() } });
  if (!d) return bad(res, "that code is not valid or has expired", 404);
  res.json({ name: d.name, expiresAt: d.expiresAt });
});

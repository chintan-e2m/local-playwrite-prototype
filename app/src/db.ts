import { randomBytes, scryptSync } from "node:crypto";
import { MongoClient, type Collection } from "mongodb";
import { config, sha256 } from "./config.ts";

export type Role = "client" | "developer" | "admin";
export type User = { _id: string; email: string; name: string; role: Role; passwordHash: string; salt: string; createdAt: Date };
export type Project = { _id: string; name: string; clientId: string; developerId: string; siteUrl?: string; createdAt: Date };
export type FileRef = { key: string; name: string; size: number; contentType: string; label?: string };
export type TaskType = "qa" | "figma-html";
export type TaskMode = "scripted" | "agent";
export type TaskStatus = "queued" | "running" | "waiting_answer" | "completed" | "failed" | "cancelled";
export type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};
export type Task = {
  _id: string;
  projectId: string;
  clientId: string;
  developerId: string;
  title: string;
  type: TaskType;
  mode: TaskMode;
  input: { url?: string; notes?: string; files: FileRef[] };
  status: TaskStatus;
  runnerId?: string;
  error?: string;
  summary?: string;
  results: FileRef[];
  pending?: { id: string; questions: Question[]; askedAt: Date };
  metrics?: Record<string, number | string>;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
};
export type TaskEvent = { _id?: unknown; taskId: string; ts: Date; kind: "step" | "info" | "error" | "question" | "answer" | "claude" | "tool"; text: string };
export type Runner = {
  _id: string;
  ownerId: string;
  name: string;
  tokenHash: string;
  createdAt: Date;
  revokedAt?: Date;
  // Last values the runner reported; live status lives in the hub.
  lastSeen?: Date;
  version?: string;
  browser?: string;
  os?: string;
  capacity?: number;
};
export type DeviceRequest = {
  _id: string; // sha256(deviceCode)
  userCode: string;
  name: string;
  status: "pending" | "approved" | "denied";
  ownerId?: string;
  runnerId?: string;
  token?: string; // handed out once, then removed
  expiresAt: Date;
};

const client = new MongoClient(config.mongoUrl);
export const db = {
  users: null as unknown as Collection<User>,
  projects: null as unknown as Collection<Project>,
  tasks: null as unknown as Collection<Task>,
  events: null as unknown as Collection<TaskEvent>,
  runners: null as unknown as Collection<Runner>,
  devices: null as unknown as Collection<DeviceRequest>,
};

export const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  return { salt, passwordHash: scryptSync(password, salt, 32).toString("hex") };
}

export async function connectDb() {
  await client.connect();
  const d = client.db();
  db.users = d.collection("users");
  db.projects = d.collection("projects");
  db.tasks = d.collection("tasks");
  db.events = d.collection("task_events");
  db.runners = d.collection("runners");
  db.devices = d.collection("device_requests");
  await db.users.createIndex({ email: 1 }, { unique: true });
  await db.tasks.createIndex({ status: 1, createdAt: 1 });
  await db.tasks.createIndex({ clientId: 1, createdAt: -1 });
  await db.tasks.createIndex({ developerId: 1, createdAt: -1 });
  await db.events.createIndex({ taskId: 1, ts: 1 });
  await db.runners.createIndex({ tokenHash: 1 }, { unique: true });
  await db.devices.createIndex({ userCode: 1 });
  await db.devices.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await seed();
}

async function seed() {
  if ((await db.users.countDocuments()) === 0) {
    const people: [string, string, Role][] = [
      ["admin@teaming.local", "Admin", "admin"],
      ["client@teaming.local", "Acme Corp", "client"],
      ["dev1@teaming.local", "Priya Shah", "developer"],
      ["dev2@teaming.local", "Marco Rossi", "developer"],
    ];
    for (const [email, name, role] of people) {
      await db.users.insertOne({ _id: newId("usr"), email, name, role, ...hashPassword(config.seedPassword), createdAt: new Date() });
    }
    const clientUser = await db.users.findOne({ email: "client@teaming.local" });
    const dev = await db.users.findOne({ email: "dev1@teaming.local" });
    await db.projects.insertOne({
      _id: newId("prj"),
      name: "Acme marketing site",
      clientId: clientUser!._id,
      developerId: dev!._id,
      siteUrl: "https://example.com",
      createdAt: new Date(),
    });
    console.log(`[seed] users created (password "${config.seedPassword === "teaming" ? "teaming" : "from SEED_PASSWORD"}")`);
  }
  for (const entry of config.seedRunners.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [email, name, token] = entry.split(":");
    const owner = await db.users.findOne({ email });
    if (!owner || !token) continue;
    await db.runners.updateOne(
      { tokenHash: sha256(token) },
      { $setOnInsert: { _id: newId("rnr"), ownerId: owner._id, name, tokenHash: sha256(token), createdAt: new Date() } },
      { upsert: true },
    );
  }
}

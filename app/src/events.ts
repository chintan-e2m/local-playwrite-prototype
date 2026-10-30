// In-process notification bus feeding the UI's server-sent events. Messages are tiny
// "something changed" hints; the UI refetches what it shows.
import type { Request, Response } from "express";
import type { SessionUser } from "./auth.ts";
import { db, type TaskEvent } from "./db.ts";

type Hint = { type: "task" | "runner" | "event"; id: string };
type Listener = { user: SessionUser; res: Response };

const listeners = new Set<Listener>();

// audience: user ids allowed to see it (admins always do).
export function notify(hint: Hint, audience: string[]) {
  const line = `data: ${JSON.stringify(hint)}\n\n`;
  for (const l of listeners) {
    if (l.user.role === "admin" || audience.includes(l.user._id)) l.res.write(line);
  }
}

export function sse(req: Request, res: Response) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  res.write(": connected\n\n");
  const l = { user: res.locals.user as SessionUser, res };
  listeners.add(l);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    listeners.delete(l);
  });
}

export async function taskEvent(task: { _id: string; clientId: string; developerId: string }, kind: TaskEvent["kind"], text: string) {
  await db.events.insertOne({ taskId: task._id, ts: new Date(), kind, text: text.slice(0, 4000) });
  notify({ type: "event", id: task._id }, [task.clientId, task.developerId]);
}

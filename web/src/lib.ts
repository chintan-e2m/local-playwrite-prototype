import { useCallback, useEffect, useRef, useState } from "react";

export type Role = "client" | "developer" | "admin";
export type Me = { _id: string; email: string; name: string; role: Role; claudeEnabled: boolean };
export type FileRef = { key: string; name: string; size: number; contentType: string; label?: string };
export type Question = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] };
export type TaskStatus = "queued" | "running" | "waiting_answer" | "completed" | "failed" | "cancelled";
export type Task = {
  _id: string;
  projectId: string;
  projectName?: string;
  clientName?: string;
  developerName?: string;
  developerId: string;
  runnerName?: string;
  developerOnline: boolean;
  title: string;
  type: "qa" | "figma-html";
  mode: "scripted" | "agent";
  input: { url?: string; notes?: string; files: FileRef[] };
  status: TaskStatus;
  error?: string;
  summary?: string;
  results: FileRef[];
  pending?: { id: string; questions: Question[] };
  metrics?: Record<string, number | string>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  events?: { ts: string; kind: string; text: string }[];
};
export type Project = { _id: string; name: string; siteUrl?: string; clientName?: string; developerName?: string; developerId: string; createdAt: string };
export type Runner = {
  _id: string;
  name: string;
  ownerName?: string;
  online: boolean;
  running?: number;
  capacity?: number;
  browser?: string;
  version?: string;
  os?: string;
  lastSeen?: string | number;
  revokedAt?: string;
  createdAt: string;
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth")) window.dispatchEvent(new Event("tl:signed-out"));
    throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  }
  return data as T;
}

// ---- tiny router
export function navigate(to: string) {
  if (to === location.pathname + location.search) return;
  history.pushState(null, "", to);
  window.dispatchEvent(new Event("tl:navigate"));
}
export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    window.addEventListener("tl:navigate", on);
    return () => {
      window.removeEventListener("popstate", on);
      window.removeEventListener("tl:navigate", on);
    };
  }, []);
  return path;
}

// ---- live updates: one EventSource, pages subscribe and refetch
type Hint = { type: "task" | "runner" | "event"; id: string };
const subscribers = new Set<(h: Hint) => void>();
let source: EventSource | null = null;
export function startLive() {
  if (source) return;
  source = new EventSource("/api/events");
  source.onmessage = (e) => {
    const hint = JSON.parse(e.data) as Hint;
    for (const s of subscribers) s(hint);
  };
}
export function stopLive() {
  source?.close();
  source = null;
}

// Loads data and refetches (debounced) when a matching live hint arrives.
export function useData<T>(path: string | null, match: (h: Hint) => boolean = () => true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const matchRef = useRef(match);
  matchRef.current = match;
  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    void load();
    let timer: number | undefined;
    const sub = (h: Hint) => {
      if (!matchRef.current(h)) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 150);
    };
    subscribers.add(sub);
    return () => {
      subscribers.delete(sub);
      clearTimeout(timer);
    };
  }, [load]);
  return { data, error, reload: load };
}

export function ago(value?: string | number) {
  if (!value) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function duration(from?: string, to?: string) {
  if (!from) return "";
  const ms = (to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime();
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting_answer: "Needs answer",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
export const TYPE_LABEL = { qa: "QA audit", "figma-html": "Figma to HTML" } as const;

import { useEffect, useState } from "react";
import { api, bytes, duration, navigate, STATUS_LABEL, TYPE_LABEL, useData, type Me, type Question, type Task } from "../lib.ts";

const METRIC_LABELS: Record<string, string> = {
  browserStartMs: "Browser start on laptop",
  resolveWidthsMs: "Width discovery (Python script)",
  captureMs: "Capture engine (Node script)",
  mcpNavigateMs: "MCP navigate",
  totalMs: "Total",
  tunnelBytesToLaptop: "Tunnel, server to laptop",
  tunnelBytesFromLaptop: "Tunnel, laptop to server",
  proxiedRequests: "Localhost requests proxied",
  claudeCostUsd: "Claude cost",
  claudeTurns: "Claude turns",
  claudeMs: "Claude time",
};

function formatMetric(key: string, value: number | string) {
  if (typeof value !== "number") return value;
  if (key.endsWith("Ms")) return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;
  if (key.startsWith("tunnelBytes")) return bytes(value);
  if (key === "claudeCostUsd") return `$${value.toFixed(2)}`;
  return String(value);
}

export function TaskPage({ id, me }: { id: string; me: Me }) {
  const { data: task, error, reload } = useData<Task>(`/tasks/${id}`, (h) => h.id === id);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  if (error) return <div className="notice bad">{error}</div>;
  if (!task) return null;

  const act = async (path: string) => {
    setBusy(true);
    try {
      await api(`/tasks/${id}/${path}`, { method: "POST" });
      await reload();
    } finally {
      setBusy(false);
    }
  };
  const active = ["queued", "running", "waiting_answer"].includes(task.status);
  const images = task.results.map((r, i) => ({ ...r, i })).filter((r) => r.contentType.startsWith("image/"));
  const others = task.results.map((r, i) => ({ ...r, i })).filter((r) => !r.contentType.startsWith("image/"));
  const canAnswer = me.role === "admin" || me._id === task.developerId;
  const metrics = Object.entries(task.metrics ?? {}).filter(([k]) => !k.startsWith("mcpScreenshot"));

  return (
    <>
      <div style={{ marginBottom: 14 }}>
        <a
          href="/"
          className="muted small"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          Tasks
        </a>
        <span className="faint small"> / {task.projectName}</span>
      </div>
      <div className="page-head">
        <div>
          <h1>{task.title}</h1>
          <div className="sub" style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span className={`pill ${task.status}`}>{STATUS_LABEL[task.status]}</span>
            <span>
              {TYPE_LABEL[task.type]} · {task.mode === "agent" ? "Claude agent" : "Plugin scripts"}
              {task.startedAt && ` · ${duration(task.startedAt, task.finishedAt)}`}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {active && (
            <button className="btn danger" disabled={busy} onClick={() => act("cancel")}>
              Cancel
            </button>
          )}
          {["failed", "cancelled"].includes(task.status) && (
            <button className="btn" disabled={busy} onClick={() => act("retry")}>
              Run again
            </button>
          )}
        </div>
      </div>

      <div className="cols">
        <div className="grid" style={{ gap: 20 }}>
          {task.status === "queued" && (
            <div className="notice">
              {task.developerOnline
                ? "Waiting for a free slot on the developer's machine."
                : `Waiting for ${task.developerName}'s machine to come online. The task starts as soon as their runner connects.`}
            </div>
          )}
          {task.status === "failed" && task.error && <div className="notice bad">{task.error}</div>}
          {task.pending && <QuestionCard task={task} canAnswer={canAnswer} />}
          {task.summary && (
            <div className="card pad">
              <h2>Summary</h2>
              <div style={{ whiteSpace: "pre-wrap" }}>{task.summary}</div>
            </div>
          )}
          {task.results.length > 0 && (
            <div className="card pad">
              <h2>Results</h2>
              {images.length > 0 && (
                <div className="results" style={{ marginBottom: others.length ? 16 : 0 }}>
                  {images.map((r) => (
                    <a key={r.key} className="shot" href={`/api/tasks/${id}/files/${r.i}`} target="_blank" rel="noreferrer">
                      <div className="img" style={{ backgroundImage: `url(/api/tasks/${id}/files/${r.i})` }} />
                      <div className="cap">
                        <div>{r.label ?? r.name}</div>
                        <div className="faint small">{bytes(r.size)}</div>
                      </div>
                    </a>
                  ))}
                </div>
              )}
              {others.length > 0 && (
                <ul className="files">
                  {others.map((r) => (
                    <li key={r.key}>
                      <a href={`/api/tasks/${id}/files/${r.i}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", fontWeight: 500 }}>
                        {r.label ?? r.name}
                      </a>
                      <span className="faint">
                        {r.name} · {bytes(r.size)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="card pad">
            <h2>Activity</h2>
            <ul className="timeline">
              {(task.events ?? []).map((e, i) => (
                <li key={i} className={e.kind}>
                  <span className="t">{new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                  <span className="mark" />
                  <span className="text">{e.text}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="grid">
          <div className="card pad">
            <h2>Details</h2>
            <dl className="kv">
              <dt>Project</dt>
              <dd>{task.projectName}</dd>
              <dt>Client</dt>
              <dd>{task.clientName}</dd>
              <dt>Developer</dt>
              <dd>{task.developerName}</dd>
              <dt>Machine</dt>
              <dd>{task.runnerName ?? <span className="faint">not assigned yet</span>}</dd>
              {task.input.url && (
                <>
                  <dt>URL</dt>
                  <dd>
                    <a href={task.input.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                      {task.input.url}
                    </a>
                  </dd>
                </>
              )}
              {task.input.notes && (
                <>
                  <dt>Notes</dt>
                  <dd style={{ whiteSpace: "pre-wrap" }}>{task.input.notes}</dd>
                </>
              )}
              {task.input.files.length > 0 && (
                <>
                  <dt>Files</dt>
                  <dd>
                    {task.input.files.map((f, i) => (
                      <div key={f.key}>
                        <a href={`/api/tasks/${id}/files/${i}?input=1`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                          {f.name}
                        </a>
                      </div>
                    ))}
                  </dd>
                </>
              )}
              <dt>Created</dt>
              <dd>{new Date(task.createdAt).toLocaleString()}</dd>
            </dl>
          </div>
          {metrics.length > 0 && (
            <div className="card pad">
              <h2>Measurements</h2>
              {metrics.map(([k, v]) => (
                <div className="metric" key={k}>
                  <span className="muted">{METRIC_LABELS[k] ?? k}</span>
                  <span>{formatMetric(k, v)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function QuestionCard({ task, canAnswer }: { task: Task; canAnswer: boolean }) {
  const questions = task.pending!.questions;
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggle = (q: Question, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      return { ...p, [q.question]: q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label] };
    });
  const answerFor = (q: Question) => [...(picked[q.question] ?? []), other[q.question]?.trim()].filter(Boolean).join(", ");
  const ready = questions.every((q) => answerFor(q));

  async function send() {
    setBusy(true);
    setError("");
    try {
      await api(`/tasks/${task._id}/answer`, { body: { questionId: task.pending!.id, answers: Object.fromEntries(questions.map((q) => [q.question, answerFor(q)])) } });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="card pad question">
      <h2>{canAnswer ? "Claude needs a decision" : `Waiting for ${task.developerName} to answer`}</h2>
      <div className="grid" style={{ gap: 18 }}>
        {questions.map((q) => (
          <div key={q.question} className="grid" style={{ gap: 8 }}>
            <div style={{ fontWeight: 500 }}>{q.question}</div>
            {q.options.map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label);
              return (
                <label key={o.label} className={`option ${on ? "on" : ""}`}>
                  <input type={q.multiSelect ? "checkbox" : "radio"} name={q.question} checked={on} disabled={!canAnswer} onChange={() => toggle(q, o.label)} />
                  <span>
                    <div style={{ fontWeight: 500 }}>{o.label}</div>
                    {o.description && <div className="muted small">{o.description}</div>}
                  </span>
                </label>
              );
            })}
            {canAnswer && (
              <input className="input" placeholder="Other answer (optional)" value={other[q.question] ?? ""} onChange={(e) => setOther((o) => ({ ...o, [q.question]: e.target.value }))} />
            )}
          </div>
        ))}
        {error && <div className="error">{error}</div>}
        {canAnswer && (
          <div>
            <button className="btn primary" disabled={!ready || busy} onClick={send}>
              Send answer
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

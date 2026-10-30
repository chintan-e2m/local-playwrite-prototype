import { useState } from "react";
import { NewTask } from "../components/NewTask.tsx";
import { ago, navigate, STATUS_LABEL, TYPE_LABEL, useData, type Me, type Task } from "../lib.ts";

const FILTERS = { all: "All", active: "Active", done: "Done" } as const;
const ACTIVE = new Set(["queued", "running", "waiting_answer"]);

export function TasksPage({ me }: { me: Me }) {
  const { data: tasks, error } = useData<Task[]>("/tasks", (h) => h.type === "task" || h.type === "runner");
  const [filter, setFilter] = useState<keyof typeof FILTERS>("all");
  const [creating, setCreating] = useState(false);

  const shown = (tasks ?? []).filter((t) => (filter === "all" ? true : filter === "active" ? ACTIVE.has(t.status) : !ACTIVE.has(t.status)));
  const canCreate = me.role !== "developer";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Tasks</h1>
          <div className="sub">
            {me.role === "developer" ? "Work assigned to you. It runs on the server and uses a browser on your machine." : "Requests for your projects and their results."}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div className="segmented">
            {Object.entries(FILTERS).map(([k, label]) => (
              <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k as keyof typeof FILTERS)}>
                {label}
              </button>
            ))}
          </div>
          {canCreate && (
            <button className="btn primary" onClick={() => setCreating(true)}>
              New task
            </button>
          )}
        </div>
      </div>

      {error && <div className="notice bad">{error}</div>}
      <div className="card">
        {tasks && shown.length === 0 ? (
          <div className="empty">{tasks.length === 0 ? (canCreate ? "No tasks yet. Create one to get started." : "Nothing assigned to you yet.") : "Nothing here."}</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Type</th>
                <th>Status</th>
                <th>{me.role === "developer" ? "Client" : "Developer"}</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t._id} className="link" onClick={() => navigate(`/tasks/${t._id}`)}>
                  <td>
                    <div className="title-cell">{t.title}</div>
                    <div className="faint small">{t.projectName}</div>
                  </td>
                  <td>
                    <span className="tag">{TYPE_LABEL[t.type]}</span>
                  </td>
                  <td>
                    <span className={`pill ${t.status}`}>{STATUS_LABEL[t.status]}</span>
                    {t.status === "queued" && !t.developerOnline && <div className="faint small" style={{ marginTop: 4 }}>Waiting for the developer's machine</div>}
                  </td>
                  <td className="muted">{me.role === "developer" ? t.clientName : t.developerName}</td>
                  <td className="muted">{ago(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && (
        <NewTask
          me={me}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            navigate(`/tasks/${id}`);
          }}
        />
      )}
    </>
  );
}

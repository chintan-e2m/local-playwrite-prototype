import { useState } from "react";
import { api, ago, useData, type Me, type Project } from "../lib.ts";

type User = { _id: string; name: string; email: string };

export function ProjectsPage({ me }: { me: Me }) {
  const { data: projects, reload } = useData<Project[]>("/projects", () => false);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <div className="sub">Each project has a client and one assigned developer, whose machine runs its browser work.</div>
        </div>
        {me.role !== "developer" && (
          <button className="btn primary" onClick={() => setAdding(true)}>
            New project
          </button>
        )}
      </div>
      <div className="card">
        {projects?.length === 0 ? (
          <div className="empty">No projects yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Client</th>
                <th>Developer</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {(projects ?? []).map((p) => (
                <tr key={p._id}>
                  <td>
                    <div className="title-cell">{p.name}</div>
                    {p.siteUrl && <div className="faint small">{p.siteUrl}</div>}
                  </td>
                  <td className="muted">{p.clientName}</td>
                  <td className="muted">{p.developerName}</td>
                  <td className="muted">{ago(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adding && (
        <NewProject
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            void reload();
          }}
        />
      )}
    </>
  );
}

function NewProject({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { data: developers } = useData<User[]>("/users?role=developer", () => false);
  const [name, setName] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [developerId, setDeveloperId] = useState("");
  const [error, setError] = useState("");
  const dev = developerId || developers?.[0]?._id || "";

  async function submit() {
    try {
      await api("/projects", { body: { name, siteUrl, developerId: dev } });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header>
          <h1 style={{ fontSize: 18 }}>New project</h1>
        </header>
        <div className="body">
          <label className="field">
            Name
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <label className="field">
            <span className="field-label">
              Website <span className="hint">Optional</span>
            </span>
            <input className="input" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://" />
          </label>
          <label className="field">
            Developer
            <select className="input" value={dev} onChange={(e) => setDeveloperId(e.target.value)}>
              {(developers ?? []).map((d) => (
                <option key={d._id} value={d._id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          {error && <div className="error">{error}</div>}
        </div>
        <footer>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name || !dev} onClick={submit}>
            Create project
          </button>
        </footer>
      </div>
    </div>
  );
}

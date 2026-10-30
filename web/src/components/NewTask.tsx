import { useEffect, useState } from "react";
import { api, bytes, useData, type FileRef, type Me, type Project } from "../lib.ts";

type Upload = FileRef & { id: string; progress: number; error?: string };

export function NewTask({ me, onClose, onCreated }: { me: Me; onClose: () => void; onCreated: (id: string) => void }) {
  const { data: projects } = useData<Project[]>("/projects", () => false);
  const [projectId, setProjectId] = useState("");
  const [type, setType] = useState<"qa" | "figma-html">("qa");
  const [mode, setMode] = useState<"scripted" | "agent">("scripted");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (projects?.length && !projectId) {
      setProjectId(projects[0]._id);
      if (projects[0].siteUrl) setUrl(projects[0].siteUrl);
    }
  }, [projects, projectId]);
  useEffect(() => {
    if (type === "figma-html") setMode("agent");
  }, [type]);

  // Files go straight to object storage with a pre-signed PUT; the server only signs.
  async function addFiles(files: FileList | null) {
    for (const file of Array.from(files ?? [])) {
      const id = Math.random().toString(36).slice(2);
      const entry: Upload = { id, key: "", name: file.name, size: file.size, contentType: file.type || "application/octet-stream", progress: 0 };
      setUploads((u) => [...u, entry]);
      const patch = (p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...p } : x)));
      try {
        const { key, url: putUrl } = await api<{ key: string; url: string }>("/uploads", { body: { filename: file.name, contentType: entry.contentType } });
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", putUrl);
          xhr.setRequestHeader("content-type", entry.contentType);
          xhr.upload.onprogress = (e) => patch({ progress: e.total ? e.loaded / e.total : 0 });
          xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`upload failed (${xhr.status})`)));
          xhr.onerror = () => reject(new Error("upload failed"));
          xhr.send(file);
        });
        patch({ key, progress: 1 });
      } catch (err) {
        patch({ error: (err as Error).message });
      }
    }
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const task = await api<{ _id: string }>("/tasks", {
        body: {
          projectId,
          title: title || (type === "qa" ? `QA audit of ${url.replace(/^https?:\/\//, "")}` : "Figma to HTML page"),
          type,
          mode,
          url: type === "qa" ? url : "",
          notes,
          files: uploads.filter((u) => u.key).map(({ key, name, size, contentType }) => ({ key, name, size, contentType })),
        },
      });
      onCreated(task._id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const uploading = uploads.some((u) => !u.key && !u.error);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header>
          <h1 style={{ fontSize: 18 }}>New task</h1>
          <div className="sub">The assigned developer's machine provides the browser.</div>
        </header>
        <div className="body">
          <label className="field">
            Project
            <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {(projects ?? []).map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name} · {p.developerName}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            Type
            <div className="segmented">
              <button className={type === "qa" ? "on" : ""} onClick={() => setType("qa")}>
                QA audit
              </button>
              <button className={type === "figma-html" ? "on" : ""} onClick={() => setType("figma-html")}>
                Figma to HTML
              </button>
            </div>
          </div>
          <div className="field">
            Run with
            <div className="segmented">
              <button className={mode === "scripted" ? "on" : ""} disabled={type === "figma-html"} onClick={() => setMode("scripted")}>
                Plugin scripts
              </button>
              <button className={mode === "agent" ? "on" : ""} disabled={!me.claudeEnabled} onClick={() => setMode("agent")}>
                Claude agent
              </button>
            </div>
            <span className="hint">
              {mode === "scripted"
                ? "Runs the dev-command plugin's capture scripts and the Playwright MCP directly. No Claude tokens."
                : me.claudeEnabled
                  ? "Claude Code with the dev-command plugin. The developer answers its questions on the task page."
                  : "Claude agent mode is not configured on this server."}
            </span>
          </div>
          {type === "qa" && (
            <label className="field">
              Page URL
              <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
            </label>
          )}
          <label className="field">
            <span className="field-label">
              Title <span className="hint">Optional</span>
            </span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">
              Notes for the developer <span className="hint">Optional</span>
            </span>
            <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <div className="field">
            <span className="field-label">Files {type === "figma-html" && <span className="hint">Figma export ZIP, or a design image</span>}</span>
            <label className="btn sm" style={{ width: "fit-content" }}>
              Add files
              <input type="file" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
            </label>
            {uploads.length > 0 && (
              <ul className="files">
                {uploads.map((u) => (
                  <li key={u.id}>
                    <span>{u.name}</span>
                    <span className={u.error ? "error" : "faint"}>{u.error ?? (u.key ? bytes(u.size) : `${Math.round(u.progress * 100)}%`)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {error && <div className="error">{error}</div>}
        </div>
        <footer>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy || uploading || !projectId || (type === "qa" && !url)}>
            Create task
          </button>
        </footer>
      </div>
    </div>
  );
}

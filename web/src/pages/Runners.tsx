import { api, ago, navigate, useData, type Me, type Runner } from "../lib.ts";

export function RunnersPage({ me }: { me: Me }) {
  const { data: runners, reload } = useData<Runner[]>("/runners", (h) => h.type === "runner");
  const server = location.origin;

  async function revoke(r: Runner) {
    if (!confirm(`Revoke ${r.name}? It is disconnected immediately and has to log in again.`)) return;
    await api(`/runners/${r._id}/revoke`, { method: "POST" });
    await reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{me.role === "admin" ? "Runners" : "My machines"}</h1>
          <div className="sub">Machines that lend a browser to tasks. They connect out to the server; nothing connects in.</div>
        </div>
        <button className="btn" onClick={() => navigate("/device")}>
          Approve a code
        </button>
      </div>

      <div className="grid" style={{ gap: 20 }}>
        <div className="card">
          {runners?.length === 0 ? (
            <div className="empty">No machines yet. Connect one with the steps below.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Machine</th>
                  {me.role === "admin" && <th>Owner</th>}
                  <th>Status</th>
                  <th>Browser</th>
                  <th>Last seen</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(runners ?? []).map((r) => (
                  <tr key={r._id}>
                    <td>
                      <div className="title-cell">{r.name}</div>
                      <div className="faint small">
                        {r.os ?? "unknown os"}
                        {r.version && ` · runner ${r.version}`}
                      </div>
                    </td>
                    {me.role === "admin" && <td className="muted">{r.ownerName}</td>}
                    <td>
                      {r.revokedAt ? (
                        <span className="muted">Revoked</span>
                      ) : (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <span className={`dot ${r.online ? "on" : ""}`} />
                          {r.online ? `Online · ${r.running}/${r.capacity} in use` : "Offline"}
                        </span>
                      )}
                    </td>
                    <td className="muted">{r.browser ?? "-"}</td>
                    <td className="muted">{r.online ? "now" : ago(r.lastSeen)}</td>
                    <td style={{ textAlign: "right" }}>
                      {!r.revokedAt && (
                        <button className="btn sm danger" onClick={() => revoke(r)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card pad">
          <h2>Connect a machine</h2>
          <ol className="muted" style={{ margin: "0 0 14px", paddingLeft: 18, display: "grid", gap: 6 }}>
            <li>Install the runner and sign in. It prints a short code.</li>
            <li>
              Open <b>Approve a code</b> on this page and enter it.
            </li>
            <li>Start the runner. It stays connected and opens a browser for each task.</li>
          </ol>
          <pre className="cmd">{`npm install -g @teaming/runner
teaming-runner login --server ${server} --name my-laptop
teaming-runner start`}</pre>
        </div>
      </div>
    </>
  );
}

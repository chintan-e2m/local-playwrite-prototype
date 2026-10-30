import { useState } from "react";
import { api, navigate } from "../lib.ts";

export function DevicePage() {
  const [code, setCode] = useState(new URLSearchParams(location.search).get("code") ?? "");
  const [found, setFound] = useState<{ name: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function lookup() {
    setError("");
    try {
      setFound(await api<{ name: string }>(`/device/lookup?code=${encodeURIComponent(code)}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function decide(deny: boolean) {
    try {
      await api("/device/approve", { body: { userCode: code, deny } });
      setDone(deny ? "Request denied. The runner was not connected." : `${found?.name} is connected. Start the runner on that machine.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div style={{ maxWidth: 440, margin: "40px auto 0" }}>
      <div className="card pad">
        <h1 style={{ fontSize: 19 }}>Connect a machine</h1>
        {done ? (
          <>
            <p className="sub">{done}</p>
            <button className="btn" onClick={() => navigate("/runners")}>
              Back to my machines
            </button>
          </>
        ) : !found ? (
          <>
            <p className="sub" style={{ marginBottom: 16 }}>
              Enter the code shown by <code>teaming-runner login</code>.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="input mono"
                style={{ letterSpacing: "0.12em", textTransform: "uppercase" }}
                placeholder="XXXX-XXXX"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && lookup()}
                autoFocus
              />
              <button className="btn primary" disabled={code.replace(/[^a-z]/gi, "").length < 8} onClick={lookup}>
                Continue
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="sub" style={{ marginBottom: 16 }}>
              <b style={{ color: "var(--text)" }}>{found.name}</b> wants to connect as one of your machines. It will open browsers for tasks assigned to you.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn primary" onClick={() => decide(false)}>
                Approve
              </button>
              <button className="btn" onClick={() => decide(true)}>
                Deny
              </button>
            </div>
          </>
        )}
        {error && (
          <div className="error" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

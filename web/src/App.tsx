import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, navigate, startLive, stopLive, usePath, type Me } from "./lib.ts";
import { DevicePage } from "./pages/Device.tsx";
import { ProjectsPage } from "./pages/Projects.tsx";
import { RunnersPage } from "./pages/Runners.tsx";
import { TaskPage } from "./pages/Task.tsx";
import { TasksPage } from "./pages/Tasks.tsx";

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const path = usePath();

  useEffect(() => {
    api<Me>("/me").then(setMe, () => setMe(null));
    const out = () => setMe(null);
    window.addEventListener("tl:signed-out", out);
    return () => window.removeEventListener("tl:signed-out", out);
  }, []);
  useEffect(() => {
    if (me) startLive();
    else stopLive();
  }, [me]);

  if (me === undefined) return null;
  if (!me) return <Login onSignedIn={setMe} />;

  let page: ReactNode;
  const task = path.match(/^\/tasks\/([\w-]+)$/);
  if (task) page = <TaskPage id={task[1]} me={me} />;
  else if (path === "/projects") page = <ProjectsPage me={me} />;
  else if (path === "/runners" && me.role !== "client") page = <RunnersPage me={me} />;
  else if (path === "/device" && me.role !== "client") page = <DevicePage />;
  else page = <TasksPage me={me} />;

  const section = path.startsWith("/projects") ? "projects" : path.startsWith("/runners") || path === "/device" ? "runners" : "tasks";
  const link = (to: string, key: string, label: string) => (
    <a
      href={to}
      className={section === key ? "active" : ""}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {label}
    </a>
  );

  return (
    <>
      <div className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          Teaming
        </div>
        <nav className="nav">
          {link("/", "tasks", "Tasks")}
          {link("/projects", "projects", "Projects")}
          {me.role !== "client" && link("/runners", "runners", me.role === "admin" ? "Runners" : "My machines")}
        </nav>
        <div className="spacer" />
        <div className="who">
          <span>
            {me.name} <span className="role">{me.role}</span>
          </span>
          <button
            className="btn ghost sm"
            onClick={async () => {
              await api("/auth/logout", { method: "POST" });
              setMe(null);
              navigate("/");
            }}
          >
            Sign out
          </button>
        </div>
      </div>
      <main>{page}</main>
    </>
  );
}

const DEMO = [
  ["client@teaming.local", "Client"],
  ["dev1@teaming.local", "Developer"],
  ["admin@teaming.local", "Admin"],
];

function Login({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e?: FormEvent, as?: string) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/login", { body: { email: as ?? email, password: as ? "teaming" : password } });
      onSignedIn(await api<Me>("/me"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 22 }}>
          <span className="brand-mark" />
          Teaming
        </div>
        <h1 style={{ fontSize: 19 }}>Sign in</h1>
        <p className="sub" style={{ marginBottom: 20 }}>
          Client tasks, run by your developers.
        </p>
        <div className="grid" style={{ gap: 14 }}>
          <label className="field">
            Email
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </label>
          <label className="field">
            Password
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <div className="error">{error}</div>}
          <button className="btn primary" disabled={busy || !email || !password}>
            Sign in
          </button>
        </div>
        <div className="demo-users">
          <span className="faint small">Demo accounts (password: teaming)</span>
          {DEMO.map(([address, label]) => (
            <button type="button" key={address} onClick={() => submit(undefined, address)} disabled={busy}>
              <span>{label}</span>
              <span>{address}</span>
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}

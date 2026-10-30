# Teaming-lite prototype (iteration 1)

This is a small SaaS where clients create tasks and the server runs them with the **dev-command** plugin. All browser work happens in Chromium on the **assigned developer's machine**:
- the plugin's Playwright MCP calls;
- its Python and Node capture scripts;
- its localhost QA pages.

The server has no browser installed. See `PROTOTYPE.md` for the design.

```
 server-net                                              laptop-net
 ┌──────────────────────────────────────────────┐        ┌──────────────────────────┐
 │ app   UI · API · Runner Hub · task worker     │        │ laptop-1  runner+Chromium│
 │       Claude Code + dev-command (no browser)  │◄─nginx─┤ laptop-2  runner+Chromium│
 │ mongo · s3 (SeaweedFS, R2/S3 stand-in)        │  wss   └──────────────────────────┘
 └──────────────────────────────────────────────┘
```

## Run

**Full step-by-step guide: [`RUN.md`](RUN.md)** (one-time setup, Claude token, checks, troubleshooting).

```bash
cd Local-Playwrite-SaaS
docker compose up -d --build
open http://localhost:8080        # demo accounts below, password "teaming"
```

The secrets in `.env` are generated (see `.env.example`). To enable **Claude agent mode**, set `CLAUDE_CODE_OAUTH_TOKEN=...` (from `claude setup-token`) or `ANTHROPIC_API_KEY=...` in `.env`. Without it, tasks run in **plugin scripts** mode.

| Account | Role | Sees |
|---|---|---|
| `client@teaming.local` | client | creates projects and tasks, sees results |
| `dev1@teaming.local` | developer | assigned tasks, answers questions, owns `laptop-1` |
| `dev2@teaming.local` | developer | owns `laptop-2` |
| `admin@teaming.local` | admin | everything |

## What a task does

**Plugin scripts mode** (QA audit, no Claude tokens). All four steps use the laptop browser.

| Step | What runs on the server | What runs in the laptop browser |
|---|---|---|
| 1 | `resolve_qa_widths.py` (plugin, Python) | reads the page's CSS breakpoints |
| 2 | `capture_rendered_page.js` (plugin, Node) | full-page capture per width |
| 3 | official `@playwright/mcp` | `browser_navigate`, `resize`, `evaluate`, `take_screenshot`, `console_messages` |
| 4 | report served by `python -m http.server` on 127.0.0.1 | opens it through the localhost tunnel and screenshots it |

**Claude agent mode** runs Claude Code (Agent SDK) with the plugin loaded and `playwright` pointing at the laptop browser. When the plugin uses `AskUserQuestion`, the task shows **Needs answer**, and the assigned developer answers on the task page.

## How the browser gets to the server

1. The runner logs in (device flow), gets a 15-minute JWT and opens `wss://nginx/agent/ws`. The connection is outbound only.
2. For each task, the hub sends `browser.open`. The runner starts a fresh Chromium with a CDP port on its own loopback.
3. Server-side Playwright clients connect to `ws://127.0.0.1:9300/cdp/<browser>/<secret>` inside the app container. Each connection becomes a stream. The runner opens its own CDP connection and relays frames as binary WebSocket frames `[stream id][bytes]`.
4. Plugin scripts don't know any of this. `app/shims/pw-remote.cjs` (Node preload) and `app/shims/python/sitecustomize.py` turn `chromium.launch()` into `connectOverCDP(TEAMING_CDP_ENDPOINT)`.
5. The laptop Chromium uses the runner's local proxy (`--proxy-server` plus `--proxy-bypass-list=<-loopback>`). Requests for `localhost` and `127.0.0.1` go back through the tunnel (`proxy.request`), so the plugin's local QA servers on the server load in the laptop browser. All other traffic leaves directly from the laptop, with HTTPS going through `CONNECT`. (A `data:` PAC file was tried first, but Chromium ignores it.)
6. Scripts that call `browser.close()` close only their own connection. The runner answers `Browser.close` itself, so the shared task browser keeps running.

## Storage

- **Client uploads:** a pre-signed PUT straight to storage. The server only signs the URL.
- **Results:** uploaded by the server, then viewed through short-lived pre-signed GETs.
- **Locally:** storage is served on the same origin through nginx (`/teaming/…`), so no CORS is needed. With R2/S3, the URLs point at the bucket.

## Device login (real machines)

```bash
npx tsx runner/src/cli.ts login --server https://<server> --name my-laptop   # prints a code
# approve it in the UI: My machines -> Approve a code
npx tsx runner/src/cli.ts start
```

The containers skip this step. Their runner tokens come from `.env` through `SEED_RUNNERS`.

## Known gaps (iteration 1)

- **A runner drop fails the task.** The plan is to pause and wait for the runner to reconnect.
- **`file://` pages** used by a few plugin scripts can't load in a remote browser yet.
- **Claude agent mode** is wired but not yet exercised end to end.
- **Runner credentials** are stored in a 0600 file, not the OS keychain.

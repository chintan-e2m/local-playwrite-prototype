# Prototype plan: Teaming-lite + server-side Claude + laptop browsers

## Goal
Reproduce the production scenario locally in Docker:
- A **hosted server** runs the SaaS, Claude Code (Enterprise account) and the `dev-command` plugin.
- **Developer machines** run only Chromium, connected outbound through the runner.

Server RAM must contain **no browsers**, and dev-command runs **unchanged**.

## Decisions (agreed)
| Topic | Decision |
|---|---|
| Where Claude runs | Server: one Claude Code session per task (Agent SDK), Teaming Enterprise credentials. Developers never log in to Claude. |
| Where the browser runs | Developer machine, via the runner (outbound WSS only) |
| Task types (prototype) | **QA / visual audit** of a URL; **Figma → HTML** (static, no WordPress) |
| WordPress / dev-connect-wp | **Dropped for the prototype.** WordPress edits and builds (which go through the dev-connect-wp bridge) come later. |
| Plugin questions / approvals | Assigned developer answers in the SaaS UI |
| Architecture style | Monolith first (one Node/TS app + React UI), with modules split along future service lines |
| Plugin source | `aiopslabs/ai-agents`, branch `dev-command` |

## Why "only the 8 relay tools" is not enough (plugin analysis)
dev-command touches a browser in three ways:
1. **Official `@playwright/mcp`:** about 18 tools, including `browser_evaluate` (37 agents), `resize`, `console_messages` and `take_screenshot` with `filename`. Screenshot files are read later by `visual_compare.py`.
2. **About 14 scripts call `chromium.launch()` directly:** Node (`capture_rendered_page.js`, `measure.js`, `shot.js`) and Python (`capture_design_source.py`, `render_check.py`, `motion_check.py`, …). Agents also write ad-hoc Playwright scripts.
3. **Local QA servers:** `python3 -m http.server` on `127.0.0.1:*`, plus a few `file://` pages. The Figma → HTML flow uses these heavily.

## Design: a remote browser over the runner tunnel
```
 SERVER (docker: server-net)                                   LAPTOP (docker: laptop-net, outbound only)
 ┌──────────────────────────────────────────────────────┐      ┌─────────────────────────────────┐
 │ Teaming-lite app: React UI · API · tasks             │      │ runner                          │
 │  Runner Hub (WSS) ─ browser tunnel endpoint ◄────────┼══════┼─ outbound WSS (JWT)             │
 │   ws://hub/browser/<task>  ⇄  multiplexed stream     │      │   ⇄ Chromium (CDP)              │
 │ Task worker: Claude Agent SDK + dev-command plugin   │      │   proxy: 127.0.0.1:* ─► tunnel  │
 │   @playwright/mcp --cdp-endpoint <tunnel>            │      └─────────────────────────────────┘
 │   scripts: launch() shim → connect(<tunnel>)         │                    │
 │   QA http.server on 127.0.0.1 ◄── reverse tunnel ────┼────────────────────┘
 │ MongoDB · MinIO (S3)                                 │
 └──────────────────────────────────────────────────────┘
 Target sites (public internet) ◄── laptop browser
```
- **Browser tunnel.** The runner starts Chromium and carries its CDP stream over the existing authenticated WSS, multiplexed per task. The hub exposes it to the task worker as a local endpoint.
- **Full MCP parity.** The official `@playwright/mcp` runs inside the task worker with `--cdp-endpoint` pointing at the tunnel. All tools work, and `filename` screenshots land on the **server** disk, where the plugin's scripts expect them.
- **Direct scripts.** A shim redirects `chromium.launch()` to the remote browser without editing the plugin:
  - Node: a `NODE_OPTIONS=--require` preload.
  - Python: `sitecustomize.py`.
- **Localhost QA pages.** The runner's Chromium proxies `127.0.0.1:*` / `localhost:*` back through the tunnel to the task worker. `file://` pages are served over HTTP instead; this is a known gap to verify.
- **Isolation.** A fresh browser context per task, with a clean profile, closed at the end. The server only reaches the laptop through the tunnel the laptop opened.
- **Claude and questions.** One Agent SDK session per task in `/work/<task>`. `AskUserQuestion` and plan gates are forwarded to the task page, and the developer's answer is returned to the session.
- **Results.** Reports and screenshots go to MinIO/S3, and the UI streams progress (`checkpoint.md`, `section-qa-state.json`, hook events).

## Docker scenario
| Container | Network | Role |
|---|---|---|
| `app` | server-net | SaaS (UI + API + hub + task worker with Claude Code, plugin, Node/Python deps, **no Chromium**) |
| `mongo`, `minio` | server-net | metadata, files |
| `laptop-1`, `laptop-2` | laptop-net | runner + Chromium. They can reach `app` and the internet; `app` cannot reach them. |

`docker stats` on `app` vs `laptop-*` gives the RAM evidence.

## Steps
| # | Step | Done when |
|---|---|---|
| 0 | **Spike:** laptop container shares Chromium through the tunnel; server's `@playwright/mcp` + one plugin script drive it | Screenshot and `evaluate` work through the tunnel |
| 1 | **Docker skeleton:** app, MongoDB, MinIO, laptop-1/2, networks | `docker compose up` starts everything |
| 2 | **SaaS core:** login and roles (client, developer, admin), projects, tasks with uploads (URL / Figma file), task board | Client creates a task; developer sees it |
| 3 | **Runner connection:** device login, runner token, JWT, WSS, heartbeat (PoC reuse) | Laptop shows **online** |
| 4 | **Browser tunnel:** multiplexed CDP per task, clean context per task | Server-side Playwright controls the laptop browser |
| 5 | **Script shim + localhost reverse proxy** | Plugin scripts and local QA pages work on the laptop browser |
| 6 | **Task worker:** Agent SDK + dev-command per task on the server | A **QA / visual audit** task completes |
| 7 | **Questions + live progress** in the UI | Developer answers a plugin question from the browser |
| 8 | **Results:** reports and screenshots to S3, shown on the task page | Client sees the report and screenshots |
| 9 | **Figma → HTML flow:** Figma file upload, long task, recovery | Static HTML package produced and QA'd on the laptop browser |
| 10 | **Hardening + tests + demo:** runner drop mid-task, revocation, two developers, server vs laptop RAM, latency; FINAL.md | Demo with numbers |

## Later (after the prototype)
- WordPress edits and builds through dev-connect-wp (staging sites, encrypted credential vault).
- Splitting the monolith into services.

## Risks to verify early
- **CDP over the tunnel.** Large screenshots and evaluate payloads need latency and bandwidth checks; binary frames are already proven.
- **Python `connect_over_cdp`.** Gaps vs `launch()`, e.g. CDP sessions in the fingerprint scripts.
- **`file://` pages** in `render_check.py` / `section-qa-loop` against a remote browser.
- **Agent SDK `AskUserQuestion` handling** across long gaps while the developer is away.
- **RAM per server-side Claude Code session.**

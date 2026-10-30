# How to run the prototype

Everything runs from **one file, `docker-compose.yml`**: the server (app + Claude Code, no browser), MongoDB, S3-compatible storage, nginx, and two simulated developer laptops that run the browsers. You do three things once, then `docker compose up`.

```
 server-net                                         laptop-net
 setup (one-time) · app · mongo · s3 · nginx ◄──wss── laptop-1, laptop-2 (runner + Chromium)
```

## 1. What you need

| Need | Why |
|---|---|
| Docker Desktop with Compose v2 (`docker compose version`) | Runs every service |
| ~6 GB free disk | Images: app (Node + Python Playwright client) and runners (Playwright + Chromium) |
| Access to `aiopslabs/ai-agents` on GitHub | The `dev-command` plugin the server runs is copied from there |
| A Claude OAuth token or API key (optional) | Only for **Claude agent mode**; without it tasks run in plugin scripts mode |
| Ports 8080 and 8443 free | The UI and API (`http://localhost:8080`, `https://localhost:8443`) |

## 2. One-time setup

### 2a. Copy the dev-command plugin into `vendor/`

The plugin isn't committed (`vendor/` is git-ignored). The current copy is from branch `dev-command`, commit `87fc975` (see `vendor/dev-command.REV`).

```bash
git clone -b dev-command git@github.com:aiopslabs/ai-agents.git /tmp/ai-agents
git -C /tmp/ai-agents checkout 87fc975
mkdir -p vendor/dev-command/plugins
cp /tmp/ai-agents/README.md vendor/dev-command/
cp -R /tmp/ai-agents/plugins/dev-command vendor/dev-command/plugins/
echo 87fc975 > vendor/dev-command.REV
```

The server image expects the plugin at `vendor/dev-command/plugins/dev-command`.

### 2b. Create `.env`

```bash
cp .env.example .env
```

The `change-me` values work for a local test. To use random secrets instead (do this **before the first start**, because the storage config is built from the S3 keys):

```bash
sed -i '' \
  -e "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" \
  -e "s/^S3_ACCESS_KEY=.*/S3_ACCESS_KEY=teaming$(openssl rand -hex 4)/" \
  -e "s/^S3_SECRET_KEY=.*/S3_SECRET_KEY=$(openssl rand -hex 24)/" \
  -e "s/^LAPTOP1_TOKEN=.*/LAPTOP1_TOKEN=rt_$(openssl rand -hex 24)/" \
  -e "s/^LAPTOP2_TOKEN=.*/LAPTOP2_TOKEN=rt_$(openssl rand -hex 24)/" .env
```

(On Linux, use `sed -i` without the `''`.)

### 2c. Add the Claude token (for agent mode)

1. In a normal terminal, run `claude setup-token`. Log in with the Claude account that should pay for the usage and approve. If someone else owns the account, send them the link it prints, and paste the code they send back into the prompt.
2. Copy the token it prints (starts with `sk-ant-oat01-`) into `.env`, with no quotes or spaces:
   ```
   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
   ```

Usage counts against that Claude subscription's limits. For anything beyond testing, use a company Console API key instead: `ANTHROPIC_API_KEY=sk-ant-api03-...`.

You don't need to create the TLS certificate or the storage config. The `setup` service in the compose file creates `nginx/certs/server.{crt,key}` and `s3/s3.json` on the first start.

## 3. Start

```bash
docker compose up -d --build
```

The first build takes several minutes; later starts take seconds. Startup order:
1. `setup` creates any missing certificate or storage config, then exits.
2. `mongo`, `s3` and `app` start.
3. `nginx` starts.
4. The two laptops connect out to nginx.

## 4. Check it's working

```bash
docker compose ps -a          # setup: Exited (0); everything else: Up
docker compose logs app --tail 5
```

The app log should show:

```
[app] listening on :8080 · tunnel 127.0.0.1:9300 · Claude agent mode on
[hub] runner laptop-1 online (capacity 2, chromium …)
[hub] runner laptop-2 online (capacity 2, chromium …)
```

`agent mode off` means no Claude token was found (see Troubleshooting).

Then open **http://localhost:8080**. Every account uses the password `teaming`:

| Account | Role |
|---|---|
| `client@teaming.local` | Creates projects and tasks, sees results |
| `dev1@teaming.local` | Developer, owns `laptop-1`, answers Claude's questions |
| `dev2@teaming.local` | Developer, owns `laptop-2` |
| `admin@teaming.local` | Sees everything |

## 5. Run a test task

**In the UI:**
1. Log in as `client@teaming.local`.
2. Open the project **Acme marketing site** and create a task: type **QA**, mode **Agent**, URL `https://example.com`.
3. Watch the steps live on the task page. When it finishes, the screenshots and `qa-report.html` appear under results.

**Or with the API:**

```bash
B=http://localhost:8080/api; J=$(mktemp)
curl -s -c $J -H 'content-type: application/json' -d '{"email":"client@teaming.local","password":"teaming"}' $B/auth/login
PRJ=$(curl -s -b $J $B/projects | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["_id"])')
curl -s -b $J -H 'content-type: application/json' $B/tasks \
  -d "{\"projectId\":\"$PRJ\",\"title\":\"Smoke test\",\"type\":\"qa\",\"mode\":\"agent\",\"url\":\"https://example.com\"}"
```

Use `"mode":"scripted"` to run the plugin scripts without Claude (no tokens used).

The first agent-mode run on `example.com` took 88 s, 19 Claude turns, and an estimated $0.44 of usage. It found 0 issues at 375, 480 and 1440 px.

## 6. Manual test plan

Use two browser windows, one normal and one private, so you can be signed in as the **client** and a **developer** at the same time. The password for every account is `teaming`. Work through the tests in order: each one starts from where the previous one ended. Tick a test when what you see matches **Expect**.

Who is who: `client@teaming.local` = **Acme Corp**. `dev1@teaming.local` = **Priya Shah**, who owns `laptop-1`. `dev2@teaming.local` = **Marco Rossi**, who owns `laptop-2`. The seeded project **Acme marketing site** is assigned to Priya.

### A. Sign-in and roles

| # | Steps | Expect |
|---|---|---|
| A1 | Open http://localhost:8080 and sign in with a wrong password | An error; you stay on the sign-in page |
| A2 | Sign in as `client@teaming.local` | Top bar shows **Tasks** and **Projects** only (no machines page), and "Acme Corp client" |
| A3 | Sign in as `dev1@teaming.local` (other window) | Top bar shows **Tasks**, **Projects** and **My machines** |
| A4 | Sign in as `admin@teaming.local`, then **Sign out** | Admin sees **Runners** (every machine with its owner); sign out returns to the sign-in page |

### B. Machines

| # | Steps | Expect |
|---|---|---|
| B1 | As Priya, open **My machines** | `laptop-1`: **Online · 0/2 in use**, with a Chromium version. Marco's laptop is not listed |
| B2 | As admin, open **Runners** | Both `laptop-1` (Priya) and `laptop-2` (Marco) are online |

### C. Projects

| # | Steps | Expect |
|---|---|---|
| C1 | As the client: **Projects → New project**, name "Test site", developer **Marco Rossi**, site `https://example.com` | The project appears in the list with Client = Acme Corp and Developer = Marco Rossi |
| C2 | As Priya, open **Projects** | "Test site" is **not** listed (it belongs to Marco), and Priya has no New project button |

### D. QA task, plugin scripts mode (no Claude usage)

| # | Steps | Expect |
|---|---|---|
| D1 | As the client: **Tasks → New task**, project **Acme marketing site**, type **QA audit**, run with **Plugin scripts**, URL `https://example.com`, **Create task** | Opens the task page. Status goes queued → running → completed without refreshing the page |
| D2 | Watch **Activity** while it runs | Steps appear live: assigned to `laptop-1`, browser ready on `laptop-1`, then width discovery, capture, MCP checks and report |
| D3 | When it completes, check **Results** and **Measurements** | Screenshots per width plus a QA report that open in the browser. Measurements show browser start time, tunnel bytes and total time |
| D4 | As Priya, open **Tasks** | The same task is listed, with the client's name and live status |

### E. QA task, Claude agent mode

| # | Steps | Expect |
|---|---|---|
| E1 | Same as D1, but run with **Claude agent** | The task completes. Activity shows Claude's messages and its `browser:` tool calls |
| E2 | Check **Summary**, **Results** and **Measurements** | A written summary, screenshots and `qa-report.html`. Measurements include Claude cost, turns and time (reference: about 90 s, 19 turns, ~$0.44 for example.com) |
| E3 | Sign out, remove `CLAUDE_CODE_OAUTH_TOKEN` from `.env`, run `docker compose up -d`, open **New task** | **Claude agent** is disabled with "Claude agent mode is not configured on this server". Put the token back and run `docker compose up -d` again |

### F. Claude asks the developer a question

| # | Steps | Expect |
|---|---|---|
| F1 | As the client: **New task**, type **Figma to HTML** (agent mode only), **Add files** with a design PNG or Figma export ZIP, **Create task** | The file upload shows progress, then its size. The task runs |
| F2 | If the plugin needs a decision, open the task as Priya | Status **waiting_answer**. Priya sees "Claude needs a decision" with options and a **Send answer** button |
| F3 | Open the same task as the client | "Waiting for Priya Shah to answer"; the client can't answer |
| F4 | As Priya, pick an option and **Send answer** | The task continues running; Activity shows the question and Claude carrying on |

Claude only asks when the plugin needs a decision, so F2–F4 may not appear on every run.

### G. Developer machine offline

| # | Steps | Expect |
|---|---|---|
| G1 | Run `docker compose stop laptop-1` | Within a few seconds, **My machines** (Priya) shows `laptop-1` **Offline** |
| G2 | As the client, create a plugin scripts QA task on **Acme marketing site** | Status stays **queued** with "Waiting for Priya Shah's machine to come online…" |
| G3 | Run `docker compose start laptop-1` | The runner comes back online and the queued task starts on its own and completes |

### H. Capacity, cancel and retry

| # | Steps | Expect |
|---|---|---|
| H1 | Create **three** plugin scripts QA tasks on **Acme marketing site** quickly | Two run at once (capacity 2). The third shows "Waiting for a free slot on the developer's machine" and starts when one finishes |
| H2 | Open a queued or running task and press **Cancel** | Status **cancelled**; a running browser on the laptop is closed |
| H3 | On the cancelled task, press **Run again** | Back to queued, then runs and completes |
| H4 | Start an agent mode task, then run `docker compose stop laptop-1` while it runs | The task **fails** with a runner error (known gap: it doesn't wait for a reconnect yet). `docker compose start laptop-1`, then **Run again** completes it |

### I. Access control (security)

| # | Steps | Expect |
|---|---|---|
| I1 | Sign in as `dev2@teaming.local` (Marco), open **Tasks** | None of Priya's tasks are listed |
| I2 | As Marco, paste the URL of one of Priya's tasks (`/tasks/tsk_…`) | The task isn't shown (not found) |
| I3 | As the client, go to http://localhost:8080/runners | The Tasks page is shown instead; clients never see machines |
| I4 | As admin, **Runners → Revoke** on `laptop-2` | `laptop-2` shows Revoked and goes offline, and it stays offline after `docker compose restart laptop-2` |
| I5 | Restore it: set a new `LAPTOP2_TOKEN` in `.env`, then `docker compose up -d` | `laptop-2` connects again with the new token |

### J. Architecture checks (terminal)

| # | Command | Expect |
|---|---|---|
| J1 | `docker compose exec app sh -c 'find / \( -name chrome -o -name headless_shell -o -name chrome-headless-shell \) -type f 2>/dev/null \| wc -l'` | `0`: no browser on the server |
| J2 | `docker compose exec app getent hosts laptop-1` | No output: the server can't reach a laptop directly |
| J3 | `docker compose exec laptop-1 getent hosts app` | No output: laptops can't reach the app either, only nginx |
| J4 | `docker stats --no-stream` while a task runs | Chromium memory is on `laptop-*`; the `app` container stays small |
| J5 | `docker compose restart app` while a task is running | After restart, that task is marked failed (not stuck in running) and new tasks run normally |

### Record the results

For each run, note the date, the commit, `pass` or `fail` per test, and for failures the task id (from the URL) plus `docker compose logs app --since 10m`. Task pages keep the full activity log, so the task id is usually enough to investigate.

## 7. Everyday commands

| Task | Command |
|---|---|
| Stop everything (keeps data) | `docker compose stop` |
| Start again | `docker compose up -d` |
| Follow the logs | `docker compose logs -f app laptop-1` |
| After changing `.env` | `docker compose up -d` (recreates the containers that use it; `restart` does **not** reload `.env`) |
| After changing code in `app/`, `runner/`, `shared/` or `web/` | `docker compose up -d --build` |
| Remove containers, keep data | `docker compose down` |
| Wipe all data (database + stored files) | `docker compose down -v` |
| New certificate or storage keys | Delete `nginx/certs/server.*` or `s3/s3.json`, then `docker compose up -d --force-recreate` |

## 8. Connect a real laptop (optional)

The two `laptop-*` containers simulate developer machines. To use a real one, the server must be reachable from that laptop. Then run this on the laptop:

```bash
npm install
npx tsx runner/src/cli.ts login --server https://<server> --name my-laptop   # prints a code
# In the UI, as the developer: My machines → Approve a code
npx tsx runner/src/cli.ts start
```

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Claude agent mode off` in the app log | No token in the container. Check `CLAUDE_CODE_OAUTH_TOKEN=` in `.env` (no spaces or quotes), then run `docker compose up -d`. |
| `401 Invalid bearer token` | The value isn't a valid token. It must start with `sk-ant-oat01-`; the code from the login page is not the token. Run `claude setup-token` again. |
| "agent mode is not configured on this server" when creating a task | Same as the first row. |
| A laptop shows `offline` | Check it with `docker compose logs laptop-1`. If you changed `LAPTOP1_TOKEN`/`LAPTOP2_TOKEN`, run `docker compose up -d` so the app and the laptops all pick up the new value; the app registers the new token when it starts. |
| Uploads or results fail with access denied | The S3 keys in `.env` changed after `s3/s3.json` was created. Delete `s3/s3.json` and run `docker compose up -d --force-recreate s3 setup`. |
| `port is already allocated` | Something else uses port 8080 or 8443. Stop it, or change `ports:` under `nginx` in `docker-compose.yml`. |
| The app image fails at `plugin_deps.cjs` | `vendor/dev-command` is missing or incomplete. Repeat step 2a. |

## More

- `README.md`: how the remote browser, tunnel and storage work.
- `PROTOTYPE.md`: the design decisions.
- Known gaps: a runner disconnect fails the task, `file://` pages don't work yet, and runner credentials are stored in a file rather than the OS keychain.

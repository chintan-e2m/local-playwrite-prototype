# Teaming-lite server: web app + API + Runner Hub + task worker (Claude Code, dev-command plugin).
# Deliberately has NO browser: every Chromium the plugin asks for runs on a developer machine.
# Build from the repo root: docker build -f app/Dockerfile .

FROM node:24-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY app/package.json app/
COPY runner/package.json runner/
COPY web/package.json web/
RUN npm ci --include=dev -w web
COPY tsconfig.base.json ./
COPY web web
RUN npm run build -w web

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Python Playwright (client library only, no browsers) for the plugin's Python scripts.
RUN python3 -m venv /opt/py && /opt/py/bin/pip install --no-cache-dir playwright pillow
ENV PATH=/opt/py/bin:$PATH \
    PYTHON=/opt/py/bin/python \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DEV_COMMAND_DEPS_DIR=/opt/devcmd-deps \
    PLUGIN_DIR=/opt/dev-command/plugins/dev-command \
    NODE_ENV=production

WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY app/package.json app/
COPY runner/package.json runner/
COPY web/package.json web/
RUN npm ci --omit=dev -w app -w shared && npm cache clean --force

# The dev-command plugin, unmodified, plus its Node dependencies (playwright without Chromium).
COPY vendor/dev-command /opt/dev-command
# The plugin's postinstall runs `playwright install chromium` explicitly, which ignores
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD; delete what it downloads so the server holds no browser.
RUN node /opt/dev-command/plugins/dev-command/scripts/plugin_deps.cjs ensure \
  && rm -rf /root/.cache/ms-playwright \
  && node /opt/dev-command/plugins/dev-command/scripts/plugin_deps.cjs doctor

COPY tsconfig.base.json ./
COPY shared shared
COPY app app
COPY --from=web /src/web/dist web/dist
ENV WEB_DIST=/app/web/dist WORK_DIR=/work SHIM_DIR=/app/app/shims
RUN useradd -m -u 10001 teaming && mkdir -p /work && chown teaming /work
USER teaming
CMD ["node", "--import", "tsx", "app/src/index.ts"]

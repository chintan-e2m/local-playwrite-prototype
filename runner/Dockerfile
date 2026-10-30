# Simulated developer machine: the runner plus Playwright's Chromium.
# The image tag must match the exact `playwright` version in runner/package.json.
# Build from the repo root: docker build -f runner/Dockerfile .
FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY app/package.json app/
COPY runner/package.json runner/
COPY web/package.json web/
RUN npm ci --omit=dev -w runner -w shared && npm cache clean --force
COPY tsconfig.base.json ./
COPY shared shared
COPY runner runner
USER pwuser
CMD ["node", "--import", "tsx", "runner/src/cli.ts", "start"]

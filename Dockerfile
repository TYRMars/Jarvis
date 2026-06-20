# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# Jarvis — multi-stage Docker build (Node runtime; the Rust runtime was
# decommissioned in P8.2).
#
#   stage 1 (web)     — build the React+Vite SPA into apps/jarvis-web/dist/.
#                       Served at / by the Node server via JARVIS_WEB_DIST.
#   stage 2 (deps)    — install the pnpm workspace (packages/*).
#   stage 3 (runtime) — slim Node image; runs the @jarvis/jarvis-app composition
#                       root directly via `node --experimental-strip-types`
#                       (no transpile step), as a non-root user.
#
# NOTE: verify with a real `docker build` before shipping — the container build
# is not exercised by the Node unit-test gate.
#
# Build:  docker build -t jarvis:dev .
# Run:    docker run --rm -p 7001:7001 -e OPENAI_API_KEY=sk-... jarvis:dev
# ---------------------------------------------------------------------------

# ---------- stage 1: web bundle ---------------------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY apps/jarvis-web/package.json apps/jarvis-web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY apps/jarvis-web/ ./
RUN npm run build


# ---------- stage 2: pnpm workspace deps ------------------------------------
FROM node:22-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
# Native modules (better-sqlite3 / node-pty) need a toolchain to build.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json eslint.config.js ./
COPY scripts ./scripts
COPY packages ./packages
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile


# ---------- stage 3: runtime ------------------------------------------------
FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates tini curl \
    && rm -rf /var/lib/apt/lists/*

ARG UID=10001
ARG GID=10001
RUN groupadd --system --gid ${GID} jarvis \
    && useradd --system --uid ${UID} --gid ${GID} --home-dir /data --shell /usr/sbin/nologin jarvis \
    && mkdir -p /data /workspace /app \
    && chown -R jarvis:jarvis /data /workspace /app

WORKDIR /app
COPY --from=deps --chown=jarvis:jarvis /app /app
COPY --from=web --chown=jarvis:jarvis /web/dist /app/apps/jarvis-web/dist

USER jarvis
ENV HOME=/data \
    JARVIS_ADDR=0.0.0.0:7001 \
    JARVIS_FS_ROOT=/workspace \
    JARVIS_WEB_DIST=/app/apps/jarvis-web/dist \
    NODE_ENV=production
EXPOSE 7001
VOLUME ["/data", "/workspace"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:7001/health || exit 1

# `--experimental-strip-types` runs the TS composition root with no build step
# (Node >= 22.6). The bin entry is packages/jarvis-app/src/main.ts.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "--experimental-strip-types", "packages/jarvis-app/src/main.ts"]
CMD ["serve"]

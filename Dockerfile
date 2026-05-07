# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# Jarvis — multi-stage Docker build.
#
#   stage 1 (web)     — build the React+Vite SPA into apps/jarvis-web/dist/.
#                       The Rust crate `harness-server` ingests this directory
#                       at compile time via `include_dir!`, so the bundle MUST
#                       exist before stage 2 runs `cargo build`.
#   stage 2 (rust)    — compile the `jarvis` server binary in release mode.
#                       Uses BuildKit cache mounts to avoid recompiling deps
#                       on every iteration.
#   stage 3 (runtime) — minimal Debian image with git + CA certs, runs the
#                       binary as a non-root user.
#
# Build:
#   docker build -t jarvis:dev .
# Run (smoke test):
#   docker run --rm -p 7001:7001 -e OPENAI_API_KEY=sk-... jarvis:dev
# ---------------------------------------------------------------------------

# ---------- stage 1: web bundle ---------------------------------------------
FROM node:20-alpine AS web

WORKDIR /web
# Copy lockfile + manifest first so `npm ci` is cached across iterations
# that only change source files.
COPY apps/jarvis-web/package.json apps/jarvis-web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY apps/jarvis-web/ ./
RUN npm run build
# Output lives at /web/dist; stage 2 copies it back into the workspace tree
# so `include_dir!("$CARGO_MANIFEST_DIR/../../apps/jarvis-web/dist")` resolves.


# ---------- stage 2: rust binary --------------------------------------------
FROM rust:1.83-slim-bookworm AS rust

# Native deps required by some workspace crates (sqlx-mysql, openssl-sys, etc.).
# `pkg-config` + `libssl-dev` cover the openssl-sys path; rustls features
# don't need them but the workspace doesn't pin a single TLS backend.
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config \
        libssl-dev \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
# Drop the prebuilt web bundle into the location `include_dir!` expects.
COPY --from=web /web/dist apps/jarvis-web/dist

# BuildKit cache mounts: registry index + git deps + the workspace target dir.
# `--locked` enforces Cargo.lock so reproducible builds don't drift.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target,sharing=locked \
    cargo build --release --locked -p jarvis \
    && cp target/release/jarvis /tmp/jarvis


# ---------- stage 3: runtime ------------------------------------------------
FROM debian:bookworm-slim AS runtime

# Runtime deps:
#   git           — git.*  tools, worktree subsystem
#   ca-certificates — HTTPS to LLM providers
#   libssl3       — for binaries linked against system openssl
#   tini          — PID 1, reaps zombies; agent loop spawns shells via
#                   `shell.exec` and we don't want orphaned descendants
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        libssl3 \
        tini \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Non-root user. Conversations / projects default to
# `$XDG_DATA_HOME or $HOME/.local/share/jarvis/conversations`, so a
# stable HOME makes the volume mount predictable.
ARG UID=10001
ARG GID=10001
RUN groupadd --system --gid ${GID} jarvis \
    && useradd --system --uid ${UID} --gid ${GID} --home-dir /data --shell /usr/sbin/nologin jarvis \
    && mkdir -p /data /workspace \
    && chown -R jarvis:jarvis /data /workspace

COPY --from=rust /tmp/jarvis /usr/local/bin/jarvis

USER jarvis
WORKDIR /workspace
ENV HOME=/data \
    JARVIS_ADDR=0.0.0.0:7001 \
    JARVIS_FS_ROOT=/workspace \
    RUST_LOG=jarvis=info,harness_server=info
EXPOSE 7001
VOLUME ["/data", "/workspace"]

# `/health` is always-on, doesn't require any provider env to be set.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:7001/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/jarvis"]
CMD ["serve"]

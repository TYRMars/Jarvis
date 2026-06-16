// Static-asset routes for the bundled web UI. Ported from
// crates/harness-server/src/ui.rs (`router` + `spa_fallback`).
//
// The Rust server folds `apps/jarvis-web/dist/` into the binary at compile
// time (`include_dir!`) and serves it from memory. Node has no such trick, so
// we serve from a real directory on disk (`distDir`) via @fastify/static — the
// composition root (apps/jarvis) points it at the built SPA. The server itself
// reads no env / config; the caller supplies the path.
//
// Routes mounted by `registerUiRoutes`:
//
//   - GET /            → index.html
//   - GET /assets/*    (and any other existing file) → looked up against
//                        `distDir`, served with @fastify/static's mime types.
//
// The interesting part is the SPA fallback, which mirrors `ui.rs::spa_fallback`
// exactly. @fastify/static is registered with `wildcard: false` so it only
// registers routes for files that actually exist under `distDir` at startup —
// every other path falls through to Fastify's not-found handler. We install
// that handler here as the catch-all (the analogue of axum's `.fallback`):
//
//   1. Looks like an API surface (`/v1/...`, `/health`) → 404. The real routes
//      are registered earlier and match first; this branch is defence-in-depth
//      so a typo never serves HTML. CRITICAL: SDK clients must get a clean 404,
//      not `<!doctype html>` they'd try to parse as JSON.
//   2. Has a file extension on its last segment (`.js`, `.css`, …) → a missing
//      asset; 404 loudly. Silently serving index.html for a missing JS file
//      would mask deploy mistakes.
//   3. Anything else (extension-less) → serve index.html so React Router owns
//      `/settings`, `/conversations/:id`, … client-side.
//
// `registerUiRoutes` must be called LAST in buildServer — after every /v1 +
// /health + WS route — because `setNotFoundHandler` is a process-wide catch-all
// on the instance. Registering it before other routes would still match (the
// handler only fires on unmatched paths), but keeping it last documents intent
// and matches the Rust ordering.
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface RegisterUiOptions {
  /** Absolute path to the built SPA directory (must contain `index.html`). */
  distDir: string;
}

/**
 * Serve the built SPA from `opts.distDir` at `/`, with a React-Router-aware
 * SPA fallback. Mirrors `harness-server::ui::router` + `spa_fallback`.
 */
export function registerUiRoutes(app: FastifyInstance, opts: RegisterUiOptions): void {
  // `wildcard: false` makes the plugin enumerate real files and register a
  // route per file (index.html included, served at `/`). Anything not on disk
  // falls through to the not-found handler below — no plugin-owned `/*` route
  // to fight with our SPA fallback logic.
  void app.register(fastifyStatic, {
    root: opts.distDir,
    wildcard: false,
    // index.html at the directory root → GET /. (Default, but explicit.)
    index: ["index.html"],
  });

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split("?", 1)[0]!.replace(/^\/+/, "");

    // (1) Defence in depth: API surfaces never serve HTML. The exact routes
    // are registered earlier and win; this only fires when one is unmatched.
    if (path === "health" || path === "v1" || path.startsWith("v1/")) {
      return reply.code(404).send({ error: "not found" });
    }

    // (2) Asset-like (has an extension on the last segment) → 404 loudly.
    if (pathLooksLikeAsset(path)) {
      return reply.code(404).send({ error: "not found" });
    }

    // (3) Extension-less SPA route → index.html (React Router renders it).
    return reply.sendFile("index.html");
  });
}

/**
 * "Asset-like" = the last path segment contains a dot. React Router paths
 * (`/settings`, `/conversations/abc-123`) are extension-less, so this cleanly
 * partitions the namespace. Mirrors `ui.rs::path_looks_like_asset`.
 */
export function pathLooksLikeAsset(path: string): boolean {
  const slash = path.lastIndexOf("/");
  const last = slash === -1 ? path : path.slice(slash + 1);
  return last.includes(".");
}

// Bearer-token auth gate for remote (non-loopback) callers.
//
// Off by default: when `state.accessToken` is unset the hook is never
// registered, so the loopback web SPA + desktop window keep working with no
// token — today's behaviour. When a token IS configured (required before
// exposing the server externally via DDNS), every `/v1` request — including the
// `/v1/chat/ws` upgrade — must come from loopback OR present a matching
// `Authorization: Bearer <token>` (the WS may instead pass `?token=`, since
// some clients can't set headers on the upgrade). Everything else (the SPA
// static assets, `/health`) stays open so the login page can load.
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppState } from "./state.ts";

/** Loopback remote address (IPv4/IPv6, incl. IPv4-mapped IPv6). */
export function isLoopback(addr: string | undefined): boolean {
  if (addr === undefined) return false;
  const a = addr.toLowerCase();
  return (
    a === "127.0.0.1" ||
    a === "::1" ||
    a === "::ffff:127.0.0.1" ||
    a.startsWith("127.") ||
    a.startsWith("::ffff:127.")
  );
}

/** Constant-time string compare that never short-circuits on length. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still run a compare against `b` to avoid leaking length via timing.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Extract a bearer token from the Authorization header or `?token=` query. */
function presentedToken(req: FastifyRequest): string | undefined {
  const header = req.headers["authorization"];
  if (typeof header === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m && m[1]) return m[1].trim();
  }
  const q = (req.query as { token?: unknown } | undefined)?.token;
  if (typeof q === "string" && q !== "") return q;
  return undefined;
}

/** Only `/v1` API + WS paths are gated; SPA static + `/health` stay open. */
function isProtectedPath(url: string): boolean {
  const path = url.split("?", 1)[0] ?? url;
  return path === "/v1" || path.startsWith("/v1/");
}

/**
 * Register the bearer-auth `onRequest` hook. No-op when no token is configured.
 * Call BEFORE the route registrations in `buildServer`.
 */
export function registerAuthHook(app: FastifyInstance, state: AppState): void {
  const token = state.accessToken;
  if (token === undefined || token === "") return;

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isProtectedPath(req.url)) return;
    // Trust the socket address, not a forwarded header (no proxy in front).
    if (isLoopback(req.ip) || isLoopback(req.socket.remoteAddress ?? undefined)) return;
    const provided = presentedToken(req);
    if (provided !== undefined && tokensMatch(provided, token)) return;
    return reply.code(401).send({ error: "unauthorized — missing or invalid access token" });
  });
}

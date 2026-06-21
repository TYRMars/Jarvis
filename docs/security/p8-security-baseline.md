# P8.6 — Security baseline review

> Status: **complete** (2026-06-21). Method: a 6-dimension adversarially-verified
> audit of the Node/TS runtime (desktop shell, fs/shell sandbox, OAuth/token
> handling, channel-callback signatures, git-as-transport, HTTP egress/secrets).
> 54 candidate findings → 27 confirmed real, 27 dismissed as false-positive /
> already-mitigated. This doc records what was **fixed**, what is **accepted as
> designed**, and what is **deferred** with rationale.

## Threat model

Jarvis is a **local-first, single-operator** agent runtime. The `/v1` HTTP
surface is **intentionally unauthenticated** and meant to bind to loopback
(`JARVIS_ADDR=127.0.0.1:7001`) or sit behind an authenticating reverse proxy.
The most relevant adversary is therefore **the model itself** — a prompt-injected
or misbehaving LLM driving the tool surface — followed by a co-resident local
process. Findings are triaged against that model: "an authenticated network
attacker" is out of scope because there is no auth layer to defeat (by design).

## Fixed in this pass

| # | Sev | Area | Fix |
|---|-----|------|-----|
| 1 | critical | OAuth | `auth.json` is now written `0o600` (owner-only) — it holds OAuth access/refresh tokens. `packages/llm/src/codex-auth.ts` `writeBack`. |
| 2 | high | OAuth | Token-refresh errors no longer interpolate the response body (which can echo tokens) — only the HTTP status is surfaced. `codex-auth.ts`. |
| 3 | critical | HTTP egress | `http.fetch` SSRF guard: scheme allowlist (`http`/`https` only) + block of loopback / private (`10/8`,`172.16/12`,`192.168/16`,`100.64/10`) / link-local (`169.254/16`, incl. cloud-metadata `169.254.169.254`) / IPv6 ULA+loopback / `localhost` / `metadata.google.internal`. **Default-on**; opt out with `JARVIS_HTTP_ALLOW_PRIVATE=1` for local dev servers. `packages/tools/src/http.ts`. |
| 4 | high | HTTP egress | `http.fetch` strips auth/session response headers (`set-cookie`, `www-authenticate`, `proxy-authenticate`, …) before echoing them to the model. |
| 5 | high | Tools (DoS) | `code.grep` caps the user/model-supplied regex at 1000 chars — JS regex has no match timeout, so an adversarial pattern over many files could wedge the event loop. `packages/tools/src/grep.ts`. |
| 6 | medium | Sandbox (DoS) | `resolveUnder` caps path-component depth at 256 — `canonicalizeExistingPrefix` issues one `realpath` syscall per component. `packages/tools/src/sandbox.ts`. |
| 7 | high | Channels | WeCom inbound gains **opt-in** timestamp-replay validation (`replay_window_secs` on the instance) — the signature already prevents forgery; this bounds replay of a captured valid callback. Default off to avoid clock-skew breakage; recommended for internet-exposed receivers. `packages/server/src/channels-inbound-routes.ts`. |

## Accepted as designed (documented, not fixed)

- **Unauthenticated `/v1` routes** (`GET /v1/server/info`, `POST /v1/providers/:name/probe`,
  `PATCH /v1/tools/:name`, and the rest of the surface). The entire API is
  unauthenticated by design. `GET /v1/server/info` carries **no secrets** (the
  `ServerInfo` type is explicitly secret-free — model/provider names + booleans
  only). Mitigation: keep the server loopback-bound, or front it with an
  authenticating proxy when exposed. Adding an auth layer is a deliberate future
  architecture decision, not a P8 fix.
- **No HTTP rate limiting.** A deployment-layer concern (reverse proxy / gateway).
  The `providers/:name/probe` outbound call is operator-driven config testing and
  not an abuse vector while the server is loopback-bound.

## Deferred hardening (tracked follow-ups)

- **`fs.*` TOCTOU symlink races** (`fs.write`/`fs.edit`/`fs.read`). `resolveUnder`
  is correct *at check time* (it canonicalizes the longest existing prefix and
  verifies containment), but a symlink planted in the race window between check
  and the filesystem op could be followed. Exploiting it requires either a
  **concurrent co-resident attacker** or **`shell.exec`** — which already grants
  arbitrary host writes, making the `fs.*` sandbox moot in that configuration.
  A race-free fix (`O_NOFOLLOW` on the final open + post-open re-validation)
  needs careful per-operation rework for low marginal benefit in the single-user
  model; deferred.
- **Strict async mutex around token refresh** (`codex-auth.ts` / `responses.ts`).
  Concurrent 401s already coalesce via token-snapshot comparison (a redundant
  refresh is skipped), and `auth.json` is written atomically (tmp + rename). A
  hard mutex is a robustness improvement, not a correctness fix.
- **Distributed nonce-dedup cache** for inbound callbacks (true once-only
  delivery across multiple server instances) — needs shared state (e.g. Redis).
  The single-instance timestamp window (fix #7) bounds the replay surface.
- **`http.fetch` DNS-rebinding / redirect-to-internal.** The `FetchImpl` seam
  hides post-redirect URLs and the guard does no DNS resolution, so a hostname
  that *resolves* to a private IP, or a redirect to one, is a residual. The
  literal-IP + scheme blocking covers the direct SSRF vector (incl. the classic
  metadata-endpoint attack).

## Dismissed (false-positive / already mitigated)

The adversarial verifier rejected 27 candidates. Notable ones, with why:

- **`shell.exec` command injection** — uses `spawn` with an argv array (no shell
  interpretation of the model's args); the `sh -c` form only wraps the single
  operator-gated command string.
- **git `ext::`/`fd::` transport execution** — already blocked: every `git`
  invocation prepends a `protocol.allow=never` + per-scheme allowlist guard, and
  `validateGitUrl` rejects transport-helper URLs + leading `-` + control chars.
- **Channel signature non-constant-time compare** — already uses a
  constant-time comparison.
- **`fs.patch` atomic-write TOCTOU** — writes are atomic (tmp + rename).
- **401→refresh→retry "only once"** — that is the intended contract, not a bug.

## How to re-run

The audit is a workflow over the 6 dimensions above (find → adversarially
verify). Re-run by auditing each dimension's source files and confirming each
finding's exploit path by reading the code before acting on it.

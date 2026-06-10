#!/usr/bin/env bash
# Shared helpers for the jarvis-control plugin.
#
# All operations talk to a running Jarvis server over its REST API. The
# scripts in this plugin source this file and then call `jarvis_get` /
# `jarvis_post` / `jarvis_delete`.
#
# Env vars:
#   JARVIS_BASE_URL   default http://localhost:7001
#   JARVIS_TOKEN      optional bearer token (sent as `Authorization: Bearer ...`)
#
# Output convention: all helpers print the raw response body to stdout.
# Errors go to stderr; non-2xx responses return exit code 1.
#
# Dependencies: curl, jq.

set -euo pipefail

: "${JARVIS_BASE_URL:=http://localhost:7001}"

_jarvis_require_tools() {
  for tool in curl jq; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      printf 'jarvis-control: missing required tool: %s\n' "$tool" >&2
      return 127
    fi
  done
}

_jarvis_auth_args() {
  if [[ -n "${JARVIS_TOKEN:-}" ]]; then
    printf -- '-H\nAuthorization: Bearer %s\n' "$JARVIS_TOKEN"
  fi
}

# jarvis_request METHOD PATH [BODY_JSON]
# Internal: emit raw response body, return 1 on non-2xx.
jarvis_request() {
  _jarvis_require_tools
  local method="$1" path="$2" body="${3:-}"
  local url="${JARVIS_BASE_URL%/}${path}"
  local tmp_status tmp_body
  tmp_status="$(mktemp)"
  tmp_body="$(mktemp)"
  # shellcheck disable=SC2046
  local args=(-sS -X "$method" -o "$tmp_body" -w '%{http_code}'
              -H 'Accept: application/json'
              $(_jarvis_auth_args))
  if [[ -n "$body" ]]; then
    args+=(-H 'Content-Type: application/json' --data "$body")
  fi
  if ! curl "${args[@]}" "$url" >"$tmp_status" 2>/dev/null; then
    printf 'jarvis-control: curl failed for %s %s\n' "$method" "$url" >&2
    rm -f "$tmp_status" "$tmp_body"
    return 1
  fi
  local code
  code="$(cat "$tmp_status")"
  cat "$tmp_body"
  rm -f "$tmp_status" "$tmp_body"
  if [[ "$code" -lt 200 || "$code" -ge 300 ]]; then
    printf '\njarvis-control: %s %s -> HTTP %s\n' "$method" "$path" "$code" >&2
    return 1
  fi
}

jarvis_get()    { jarvis_request GET    "$1"; }
jarvis_post()   { jarvis_request POST   "$1" "${2:-}"; }
jarvis_patch()  { jarvis_request PATCH  "$1" "${2:-}"; }
jarvis_put()    { jarvis_request PUT    "$1" "${2:-}"; }
jarvis_delete() { jarvis_request DELETE "$1"; }

# jarvis_health
# Probes /health; prints "ok" + workspace summary or fails.
jarvis_health() {
  jarvis_get /health >/dev/null
  jarvis_get /v1/workspace
}

# jarvis_resolve_project SLUG_OR_ID
# Echoes the project's UUID. Accepts either a slug or an id; the
# Jarvis routes accept both, but a few endpoints (notably /requirements)
# only work with the UUID, so we resolve once and cache.
jarvis_resolve_project() {
  local ref="$1"
  if [[ "$ref" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    printf '%s\n' "$ref"
    return 0
  fi
  jarvis_get "/v1/projects/${ref}" | jq -r '.id'
}

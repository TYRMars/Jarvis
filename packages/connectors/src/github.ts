// GitHub Issues connector — the first shipped {@link ProjectConnector}.
// Ported from crates/harness-connectors/src/github.rs.
//
// Mapping: a *remote project* is a repository (`owner/repo`); a *remote task*
// is an issue (number as a string). Pull requests are excluded from pulls
// (GitHub's issues API returns them interleaved). The REST base URL is
// injectable so tests (and GHES deployments) can point it at a stub server,
// and the `fetch` implementation is injectable so tests stay network-free.
import {
  ConnectorError,
  type ConnectorAuth,
  type ProjectBinding,
  type ProjectConnector,
  type PullResult,
  type PushResult,
  type RemoteIssue,
  type RemoteIssueState,
  type RemoteProject,
  type RequirementPush,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://api.github.com";
/** Issues per page (GitHub max). */
const PER_PAGE = 100;
/**
 * Hard cap on pages per pull — 1 000 issues. Beyond that a cursor-based
 * incremental pull (Phase 5) is the right tool, not a bigger loop.
 */
const MAX_PAGES = 10;

/** Minimal `fetch` surface this connector relies on. Matches global `fetch`. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export interface GitHubConnectorOptions {
  /** Inject a `fetch` impl (tests / non-global runtimes). Defaults to global `fetch`. */
  fetch?: FetchLike;
  /** Point the connector at a different API root (tests / GHES). */
  baseUrl?: string;
}

/** A JSON value with no fixed shape, read defensively below. */
type Json = unknown;

function asObject(v: Json): Record<string, Json> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, Json>)
    : undefined;
}

function asArray(v: Json): Json[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

function asString(v: Json): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: Json): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function githubMessage(body: Json, status: number): string {
  const obj = asObject(body);
  const m = obj ? asString(obj["message"]) : undefined;
  return m !== undefined ? `github ${status}: ${m}` : `github ${status}`;
}

/**
 * `owner/repo` -> validated path segments. Rejects anything that could change
 * the request path shape (empty parts, extra slashes, unsafe chars).
 */
export function splitRepo(remoteProjectId: string): [string, string] {
  const parts = remoteProjectId.split("/");
  if (
    parts.length === 2 &&
    parts[0]!.length > 0 &&
    parts[1]!.length > 0 &&
    [...parts[0]!].every(validRepoChar) &&
    [...parts[1]!].every(validRepoChar)
  ) {
    return [parts[0]!, parts[1]!];
  }
  throw ConnectorError.other(
    `invalid github remote_project_id (want owner/repo): ${JSON.stringify(remoteProjectId)}`,
  );
}

function validRepoChar(c: string): boolean {
  return /^[A-Za-z0-9._-]$/.test(c);
}

/**
 * Issue numbers are numeric; reject anything else before it reaches a request
 * path.
 */
export function validateIssueNumber(remoteTaskId: string): string {
  if (remoteTaskId.length > 0 && /^[0-9]+$/.test(remoteTaskId)) {
    return remoteTaskId;
  }
  throw ConnectorError.other(`invalid github issue number: ${JSON.stringify(remoteTaskId)}`);
}

/**
 * One GitHub REST issue object -> normalized {@link RemoteIssue}. Returns
 * `undefined` for pull requests (which the issues API interleaves).
 */
export function parseIssue(v: Json): RemoteIssue | undefined {
  const obj = asObject(v);
  if (!obj) return undefined;
  if (obj["pull_request"] !== undefined) return undefined;
  // Mirror Rust's `as_u64()`: require a non-negative integer issue number.
  const number = asNumber(obj["number"]);
  if (number === undefined || !Number.isInteger(number) || number < 0) return undefined;

  const state: RemoteIssueState = asString(obj["state"]) === "closed" ? "closed" : "open";

  const issue: RemoteIssue = {
    id: String(number),
    title: asString(obj["title"]) ?? "",
    state,
    labels: (asArray(obj["labels"]) ?? [])
      .map((l) => {
        const lo = asObject(l);
        return lo ? asString(lo["name"]) : undefined;
      })
      .filter((name): name is string => name !== undefined),
  };

  const body = asString(obj["body"]);
  if (body !== undefined && body.trim().length > 0) issue.body = body;

  const url = asString(obj["html_url"]);
  if (url !== undefined) issue.url = url;

  const updatedAt = asString(obj["updated_at"]);
  if (updatedAt !== undefined) issue.updated_at = updatedAt;

  return issue;
}

export class GitHubConnector implements ProjectConnector {
  readonly id = "github";
  readonly displayName = "GitHub Issues";

  readonly #fetch: FetchLike;
  readonly #baseUrl: string;

  constructor(options: GitHubConnectorOptions = {}) {
    const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (fetchImpl === undefined) {
      throw ConnectorError.other("no fetch implementation available (inject one)");
    }
    this.#fetch = fetchImpl;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  #headers(auth: ConnectorAuth): Record<string, string> {
    return {
      authorization: `Bearer ${auth.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "jarvis-connector",
    };
  }

  async #send(
    method: string,
    path: string,
    auth: ConnectorAuth,
    jsonBody?: unknown,
  ): Promise<Json> {
    const headers = this.#headers(auth);
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers,
    };
    if (jsonBody !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(jsonBody);
    }

    let resp: { status: number; json(): Promise<unknown> };
    try {
      resp = await this.#fetch(`${this.#baseUrl}${path}`, init);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw ConnectorError.other(`github request failed: ${msg}`);
    }

    const status = resp.status;
    let body: Json = null;
    try {
      body = await resp.json();
    } catch {
      body = null; // mirror Rust's `unwrap_or(Value::Null)`
    }

    if (status >= 200 && status <= 299) return body;
    if (status === 401 || status === 403) throw ConnectorError.auth(githubMessage(body, status));
    if (status === 404) throw ConnectorError.notFound(githubMessage(body, status));
    throw ConnectorError.other(githubMessage(body, status));
  }

  async listRemoteProjects(auth: ConnectorAuth): Promise<RemoteProject[]> {
    const body = await this.#send("GET", "/user/repos?per_page=100&sort=updated", auth);
    const repos = asArray(body);
    if (!repos) throw ConnectorError.other("github: expected repo array");
    const out: RemoteProject[] = [];
    for (const r of repos) {
      const obj = asObject(r);
      if (!obj) continue;
      const id = asString(obj["full_name"]);
      if (id === undefined) continue;
      const project: RemoteProject = {
        id,
        name: asString(obj["name"]) ?? "",
      };
      const url = asString(obj["html_url"]);
      if (url !== undefined) project.url = url;
      const description = asString(obj["description"]);
      if (description !== undefined) project.description = description;
      out.push(project);
    }
    return out;
  }

  async pullRequirements(auth: ConnectorAuth, binding: ProjectBinding): Promise<PullResult> {
    const [owner, repo] = splitRepo(binding.remote_project_id);
    const issues: RemoteIssue[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const path = `/repos/${owner}/${repo}/issues?state=all&per_page=${PER_PAGE}&page=${page}`;
      const body = await this.#send("GET", path, auth);
      const rows = asArray(body);
      if (!rows) throw ConnectorError.other("github: expected issue array");
      const n = rows.length;
      for (const row of rows) {
        const parsed = parseIssue(row);
        if (parsed !== undefined) issues.push(parsed);
      }
      if (n < PER_PAGE) break;
    }
    return { issues, cursor: null };
  }

  async fetchIssue(
    auth: ConnectorAuth,
    binding: ProjectBinding,
    remoteTaskId: string,
  ): Promise<RemoteIssue> {
    const [owner, repo] = splitRepo(binding.remote_project_id);
    const number = validateIssueNumber(remoteTaskId);
    const body = await this.#send("GET", `/repos/${owner}/${repo}/issues/${number}`, auth);
    const parsed = parseIssue(body);
    if (parsed === undefined) {
      throw ConnectorError.other(
        `github issue ${number} is a pull request or has an unexpected shape`,
      );
    }
    return parsed;
  }

  async pushRequirement(
    auth: ConnectorAuth,
    binding: ProjectBinding,
    remoteTaskId: string,
    change: RequirementPush,
  ): Promise<PushResult> {
    const [owner, repo] = splitRepo(binding.remote_project_id);
    const number = validateIssueNumber(remoteTaskId);
    const result: PushResult = { remoteUpdatedAt: null };

    const comment = change.comment;
    let commented = false;
    if (comment !== undefined && comment.trim().length > 0) {
      await this.#send("POST", `/repos/${owner}/${repo}/issues/${number}/comments`, auth, {
        body: comment,
      });
      commented = true;
    }

    if (change.action !== undefined) {
      const state = change.action === "close" ? "closed" : "open";
      const body = await this.#send("PATCH", `/repos/${owner}/${repo}/issues/${number}`, auth, {
        state,
      });
      const obj = asObject(body);
      const updatedAt = obj ? asString(obj["updated_at"]) : undefined;
      result.remoteUpdatedAt = updatedAt ?? null;
    } else if (commented) {
      // A comment bumps the issue's `updated_at`, but the comment POST response
      // doesn't carry the issue's new timestamp. Without a PATCH to report it,
      // re-fetch the issue so the caller can advance the conflict baseline —
      // otherwise the next unforced push sees `remoteNow > baseline` and 409s
      // spuriously, wedging the binding permanently.
      const body = await this.#send("GET", `/repos/${owner}/${repo}/issues/${number}`, auth);
      const obj = asObject(body);
      const updatedAt = obj ? asString(obj["updated_at"]) : undefined;
      result.remoteUpdatedAt = updatedAt ?? null;
    }

    return result;
  }
}

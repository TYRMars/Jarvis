// GitHubConnector + parsing tests. Network-free: a scripted `fetch` records
// requests and serves canned responses. Mirrors the Rust unit tests in
// github.rs (split_repo / validate_issue_number / parse_issue) plus end-to-end
// coverage of list / pull / fetch / push over the injected fetch.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorError,
  GitHubConnector,
  type FetchLike,
  type ProjectBinding,
  parseIssue,
  splitRepo,
  validateIssueNumber,
} from "./index.ts";

const AUTH = { token: "ghp_supersecret" };

function binding(remoteProjectId: string): ProjectBinding {
  return {
    id: "pb-1",
    connector: "github",
    account_id: "acc-1",
    project_id: "proj-1",
    remote_project_id: remoteProjectId,
    field_mapping: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Scripted fetch: serves `responses` in order; records every call. */
function stubFetch(
  responses: { status: number; json: unknown }[],
): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let i = 0;
  const fetch: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      ...(init?.body !== undefined ? { body: init.body } : {}),
    });
    const r = responses[i++] ?? { status: 200, json: [] };
    return Promise.resolve({ status: r.status, json: () => Promise.resolve(r.json) });
  };
  return { fetch, calls };
}

// ---------- pure helpers ----------

test("splitRepo accepts owner/repo and rejects garbage", () => {
  assert.deepEqual(splitRepo("tyrmars/jarvis"), ["tyrmars", "jarvis"]);
  assert.throws(() => splitRepo("jarvis"), ConnectorError);
  assert.throws(() => splitRepo("a/b/c"), ConnectorError);
  assert.throws(() => splitRepo("/jarvis"), ConnectorError);
  assert.throws(() => splitRepo("owner/re po"), ConnectorError);
  assert.throws(() => splitRepo("owner/../repo"), ConnectorError);
});

test("validateIssueNumber rejects path tricks", () => {
  assert.equal(validateIssueNumber("42"), "42");
  assert.throws(() => validateIssueNumber(""), ConnectorError);
  assert.throws(() => validateIssueNumber("42/comments"), ConnectorError);
  assert.throws(() => validateIssueNumber("../1"), ConnectorError);
});

test("parseIssue normalizes and skips pull requests", () => {
  const r = parseIssue({
    number: 97,
    title: "auto_mode: depends_on cycle",
    body: "## Summary\n…",
    state: "open",
    html_url: "https://github.com/TYRMars/Jarvis/issues/97",
    labels: [{ name: "bug" }, { name: "P1" }],
    updated_at: "2026-06-08T01:18:36Z",
  });
  assert.ok(r);
  assert.equal(r.id, "97");
  assert.equal(r.state, "open");
  assert.deepEqual(r.labels, ["bug", "P1"]);
  assert.equal(r.url, "https://github.com/TYRMars/Jarvis/issues/97");

  const pr = parseIssue({
    number: 98,
    title: "a pull request",
    state: "open",
    pull_request: { url: "…" },
  });
  assert.equal(pr, undefined, "PRs must be excluded from pulls");
});

test("parseIssue maps closed state and blank body to undefined", () => {
  const r = parseIssue({ number: 5, title: "done thing", body: "   ", state: "closed" });
  assert.ok(r);
  assert.equal(r.state, "closed");
  assert.equal(r.body, undefined, "blank bodies normalize away");
});

test("parseIssue rejects rows without a valid non-negative integer number", () => {
  // Mirrors Rust's `as_u64()`: missing / non-numeric / float / negative drop the row.
  assert.equal(parseIssue({ title: "no number", state: "open" }), undefined);
  assert.equal(parseIssue({ number: "12", title: "string number", state: "open" }), undefined);
  assert.equal(parseIssue({ number: 12.5, title: "float", state: "open" }), undefined);
  assert.equal(parseIssue({ number: -3, title: "negative", state: "open" }), undefined);
  assert.equal(parseIssue("not an object"), undefined);
});

// ---------- connector identity ----------

test("connector id and display name", () => {
  const gh = new GitHubConnector({ fetch: stubFetch([]).fetch });
  assert.equal(gh.id, "github");
  assert.equal(gh.displayName, "GitHub Issues");
});

// ---------- list / pull / fetch / push over injected fetch ----------

test("listRemoteProjects maps repos and sets auth + version headers", async () => {
  const { fetch, calls } = stubFetch([
    {
      status: 200,
      json: [
        {
          full_name: "tyrmars/jarvis",
          name: "jarvis",
          html_url: "https://github.com/tyrmars/jarvis",
          description: "agent runtime",
        },
        { name: "no-full-name" }, // dropped (no full_name)
      ],
    },
  ]);
  const gh = new GitHubConnector({ fetch, baseUrl: "https://api.example.test/" });
  const projects = await gh.listRemoteProjects(AUTH);

  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0], {
    id: "tyrmars/jarvis",
    name: "jarvis",
    url: "https://github.com/tyrmars/jarvis",
    description: "agent runtime",
  });

  // base URL trailing slash trimmed; path appended.
  assert.equal(calls[0]!.url, "https://api.example.test/user/repos?per_page=100&sort=updated");
  assert.equal(calls[0]!.headers["authorization"], "Bearer ghp_supersecret");
  assert.equal(calls[0]!.headers["x-github-api-version"], "2022-11-28");
});

test("pullRequirements paginates, filters PRs, stops on a short page", async () => {
  // page 1: 100 rows (one is a PR) → continue; page 2: 1 row → stop.
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    number: i + 1,
    title: `issue ${i + 1}`,
    state: "open",
  }));
  page1[50] = { number: 999, title: "pr", state: "open", pull_request: { url: "x" } } as never;
  const page2 = [{ number: 200, title: "last", state: "closed" }];

  const { fetch, calls } = stubFetch([
    { status: 200, json: page1 },
    { status: 200, json: page2 },
  ]);
  const gh = new GitHubConnector({ fetch });
  const result = await gh.pullRequirements(AUTH, binding("tyrmars/jarvis"));

  assert.equal(result.cursor, null);
  assert.equal(result.issues.length, 100, "99 issues from page 1 (PR dropped) + 1 from page 2");
  assert.equal(result.issues.at(-1)!.state, "closed");
  assert.equal(calls.length, 2, "second page short-circuits the loop");
  assert.match(calls[0]!.url, /\/repos\/tyrmars\/jarvis\/issues\?state=all&per_page=100&page=1$/);
});

test("fetchIssue returns the normalized issue", async () => {
  const { fetch, calls } = stubFetch([
    { status: 200, json: { number: 7, title: "probe", state: "open" } },
  ]);
  const gh = new GitHubConnector({ fetch });
  const issue = await gh.fetchIssue(AUTH, binding("tyrmars/jarvis"), "7");
  assert.equal(issue.id, "7");
  assert.match(calls[0]!.url, /\/repos\/tyrmars\/jarvis\/issues\/7$/);
});

test("pushRequirement posts a comment then patches state, returning the new baseline", async () => {
  const { fetch, calls } = stubFetch([
    { status: 201, json: {} }, // comment
    { status: 200, json: { updated_at: "2026-06-10T12:00:00Z" } }, // state patch
  ]);
  const gh = new GitHubConnector({ fetch });
  const result = await gh.pushRequirement(AUTH, binding("tyrmars/jarvis"), "7", {
    action: "close",
    comment: "done via Jarvis",
  });

  assert.equal(result.remoteUpdatedAt, "2026-06-10T12:00:00Z");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.method, "POST");
  assert.match(calls[0]!.url, /\/issues\/7\/comments$/);
  assert.equal(JSON.parse(calls[0]!.body!).body, "done via Jarvis");
  assert.equal(calls[1]!.method, "PATCH");
  assert.equal(JSON.parse(calls[1]!.body!).state, "closed");
});

test("pushRequirement: reopen maps to state=open; blank comment is skipped", async () => {
  const { fetch, calls } = stubFetch([{ status: 200, json: {} }]);
  const gh = new GitHubConnector({ fetch });
  const result = await gh.pushRequirement(AUTH, binding("tyrmars/jarvis"), "7", {
    action: "reopen",
    comment: "   ",
  });
  assert.equal(result.remoteUpdatedAt, null, "no updated_at in the response → null baseline");
  assert.equal(calls.length, 1, "blank comment posts nothing; only the PATCH fires");
  assert.equal(calls[0]!.method, "PATCH");
  assert.equal(JSON.parse(calls[0]!.body!).state, "open");
});

test("pushRequirement: comment-only push re-fetches the issue to advance the baseline", async () => {
  const { fetch, calls } = stubFetch([
    { status: 201, json: {} }, // comment POST (no issue updated_at)
    { status: 200, json: { number: 7, state: "open", updated_at: "2026-06-11T09:00:00Z" } }, // re-fetch
  ]);
  const gh = new GitHubConnector({ fetch });
  const result = await gh.pushRequirement(AUTH, binding("tyrmars/jarvis"), "7", {
    comment: "note",
  });

  assert.equal(
    result.remoteUpdatedAt,
    "2026-06-11T09:00:00Z",
    "comment-only push must report the bumped updated_at so the baseline advances",
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.method, "POST");
  assert.match(calls[0]!.url, /\/issues\/7\/comments$/);
  assert.equal(calls[1]!.method, "GET");
  assert.match(calls[1]!.url, /\/repos\/tyrmars\/jarvis\/issues\/7$/);
});

test("pushRequirement with no action and no comment makes zero requests", async () => {
  const { fetch, calls } = stubFetch([]);
  const gh = new GitHubConnector({ fetch });
  const result = await gh.pushRequirement(AUTH, binding("tyrmars/jarvis"), "7", {});
  assert.equal(result.remoteUpdatedAt, null);
  assert.equal(calls.length, 0);
});

// ---------- error mapping ----------

test("HTTP status maps to ConnectorError kinds", async () => {
  for (const [status, kind] of [
    [401, "auth"],
    [403, "auth"],
    [404, "not_found"],
    [500, "other"],
  ] as const) {
    const { fetch } = stubFetch([{ status, json: { message: "boom" } }]);
    const gh = new GitHubConnector({ fetch });
    await assert.rejects(
      () => gh.listRemoteProjects(AUTH),
      (e: unknown) => {
        assert.ok(e instanceof ConnectorError);
        assert.equal(e.kind, kind);
        assert.match(e.message, /boom/);
        return true;
      },
    );
  }
});

test("transport failure surfaces as ConnectorError.other", async () => {
  const fetch: FetchLike = () => Promise.reject(new Error("ECONNREFUSED"));
  const gh = new GitHubConnector({ fetch });
  await assert.rejects(
    () => gh.listRemoteProjects(AUTH),
    (e: unknown) => {
      assert.ok(e instanceof ConnectorError);
      assert.equal(e.kind, "other");
      assert.match(e.message, /github request failed: ECONNREFUSED/);
      return true;
    },
  );
});

test("invalid remote_project_id rejects before any request", async () => {
  const { fetch, calls } = stubFetch([]);
  const gh = new GitHubConnector({ fetch });
  await assert.rejects(() => gh.pullRequirements(AUTH, binding("not-a-repo")), ConnectorError);
  assert.equal(calls.length, 0);
});

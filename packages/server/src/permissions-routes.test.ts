import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type {
  ApprovalDecision,
  ApprovalRequest,
  Approver,
  JsonValue,
} from "@jarvis/core";
import type { AppState } from "./state.ts";
import {
  MemoryPermissionStore,
  RuleApprover,
  emptyTable,
  evaluateTable,
  globMatch,
  modeDefault,
  parsePermissionMode,
  registerPermissionsRoutes,
  ruleMatches,
  withMatcher,
  wholeToolRule,
  type ModeHandle,
  type PermissionMode,
  type PermissionStore,
  type PermissionTable,
} from "./permissions-routes.ts";

// ---------- test scaffolding ------------------------------------------------

function agentUnused(): never {
  throw new Error("agent not used in this route test");
}

function makeState(store?: PermissionStore): AppState {
  return { createAgent: agentUnused, permissionStore: store } as AppState & {
    permissionStore?: PermissionStore;
  };
}

async function buildApp(store?: PermissionStore) {
  const app = Fastify();
  registerPermissionsRoutes(app, makeState(store));
  await app.ready();
  return app;
}

// ===========================================================================
// Engine: mode parsing
// ===========================================================================

test("mode round-trips through strings + aliases", () => {
  const modes: PermissionMode[] = ["ask", "accept-edits", "plan", "auto", "bypass"];
  for (const m of modes) assert.equal(parsePermissionMode(m), m);
  assert.equal(parsePermissionMode("acceptEdits"), "accept-edits");
  assert.equal(parsePermissionMode("accept_edits"), "accept-edits");
  assert.equal(parsePermissionMode("bypassPermissions"), "bypass");
  assert.equal(parsePermissionMode("bypass-permissions"), "bypass");
  assert.equal(parsePermissionMode("nonsense"), undefined);
});

// ===========================================================================
// Engine: rule matching
// ===========================================================================

test("whole-tool rule matches any args", () => {
  const r = wholeToolRule("fs.edit");
  assert.ok(ruleMatches(r, "fs.edit", { path: "anything" }));
  assert.ok(ruleMatches(r, "fs.edit", {}));
  assert.ok(!ruleMatches(r, "fs.write", {}));
});

test("`*` tool matches any name", () => {
  const r = wholeToolRule("*");
  assert.ok(ruleMatches(r, "fs.edit", {}));
  assert.ok(ruleMatches(r, "anything.at.all", {}));
});

test("matcher pointer resolves into args", () => {
  const r = withMatcher(wholeToolRule("shell.exec"), "/command", "npm test");
  assert.ok(ruleMatches(r, "shell.exec", { command: "npm test" }));
  assert.ok(!ruleMatches(r, "shell.exec", { command: "rm -rf /" }));
  assert.ok(!ruleMatches(r, "shell.exec", { cmd: "npm test" })); // wrong key
});

test("nested + escaped JSON pointer", () => {
  const r = withMatcher(wholeToolRule("x"), "/a/b", "v*");
  assert.ok(ruleMatches(r, "x", { a: { b: "value" } }));
  assert.ok(!ruleMatches(r, "x", { a: { b: 5 } })); // non-string → no match
  const esc = withMatcher(wholeToolRule("x"), "/a~1b", "ok");
  assert.ok(ruleMatches(esc, "x", { "a/b": "ok" }));
});

// ===========================================================================
// Engine: glob matching
// ===========================================================================

test("token-aware glob doesn't eat chained commands", () => {
  assert.ok(globMatch("npm test", "npm test"));
  assert.ok(!globMatch("npm test", "npm test; rm -rf ~"));
  assert.ok(globMatch("npm test *", "npm test src/"));
  assert.ok(globMatch("npm test *", "npm test"));
});

test("token-internal star matches within a token", () => {
  assert.ok(globMatch("v*", "v1.2.3"));
  assert.ok(globMatch("git-*", "git-status"));
  assert.ok(!globMatch("git-*", "git status")); // token boundary
});

// ===========================================================================
// Engine: evaluate order + mode default
// ===========================================================================

test("evaluate orders deny > ask > allow", () => {
  const table: PermissionTable = {
    default_mode: "ask",
    deny: [{ scope: "user", tool: "shell.exec", matchers: { "/command": "rm *" } }],
    ask: [],
    allow: [{ scope: "user", tool: "shell.exec" }],
  };
  const denied = evaluateTable(table, "shell.exec", { command: "rm -rf foo" }, "allow", "auto");
  assert.equal(denied.decision, "deny");
  assert.equal(denied.source.kind, "rule");
  if (denied.source.kind === "rule") assert.equal(denied.source.bucket, "deny");

  const allowed = evaluateTable(table, "shell.exec", { command: "ls" }, "ask", "ask");
  assert.equal(allowed.decision, "allow");
});

test("evaluate falls through to mode default", () => {
  const hit = evaluateTable(emptyTable(), "fs.edit", {}, "ask", "ask");
  assert.equal(hit.decision, "ask");
  assert.equal(hit.source.kind, "mode_default");
  if (hit.source.kind === "mode_default") assert.equal(hit.source.mode, "ask");
});

test("modeDefault maps modes to decisions", () => {
  assert.equal(modeDefault("ask", "write"), "ask");
  assert.equal(modeDefault("accept-edits", "write"), "allow");
  assert.equal(modeDefault("accept-edits", "exec"), "ask");
  assert.equal(modeDefault("plan", "write"), "ask");
  assert.equal(modeDefault("auto", "exec"), "allow");
  assert.equal(modeDefault("bypass", "network"), "allow");
});

// ===========================================================================
// Engine: RuleApprover
// ===========================================================================

class RecordingApprover implements Approver {
  calls = 0;
  #decision: ApprovalDecision;
  constructor(decision: ApprovalDecision) {
    this.#decision = decision;
  }
  approve(_req: ApprovalRequest): Promise<ApprovalDecision> {
    this.calls += 1;
    return Promise.resolve(this.#decision);
  }
}

function fixedMode(mode: PermissionMode): ModeHandle {
  return { get: () => mode };
}

function req(tool: string, args: JsonValue): ApprovalRequest {
  return { tool_call_id: "c1", tool_name: tool, arguments: args, category: "write" };
}

test("RuleApprover: allow rule short-circuits without prompting", async () => {
  const store = new MemoryPermissionStore();
  await store.appendRule("user", "allow", wholeToolRule("fs.edit"));
  const fallback = new RecordingApprover({ decision: "approve" });
  const approver = new RuleApprover(store, fallback, fixedMode("ask"));
  const [decision, source] = await approver.approveWithSource(req("fs.edit", {}));
  assert.equal(decision.decision, "approve");
  assert.equal(source.kind, "rule");
  assert.equal(fallback.calls, 0);
});

test("RuleApprover: deny rule yields a deny with a reason, no prompt", async () => {
  const store = new MemoryPermissionStore();
  await store.appendRule("project", "deny", wholeToolRule("shell.exec"));
  const fallback = new RecordingApprover({ decision: "approve" });
  const approver = new RuleApprover(store, fallback, fixedMode("auto"));
  const decision = await approver.approve(req("shell.exec", {}));
  assert.equal(decision.decision, "deny");
  if (decision.decision === "deny") assert.match(decision.reason ?? "", /denied by project/);
  assert.equal(fallback.calls, 0);
});

test("RuleApprover: ask falls through to the fallback approver", async () => {
  const store = new MemoryPermissionStore(); // empty → mode-default
  const fallback = new RecordingApprover({ decision: "deny", reason: "user said no" });
  const approver = new RuleApprover(store, fallback, fixedMode("ask"));
  const [decision, source] = await approver.approveWithSource(req("fs.write", {}));
  assert.equal(decision.decision, "deny");
  assert.equal(source.kind, "user_prompt");
  assert.equal(fallback.calls, 1);
});

test("RuleApprover: auto mode auto-allows with no rules", async () => {
  const store = new MemoryPermissionStore();
  const fallback = new RecordingApprover({ decision: "deny" });
  const approver = new RuleApprover(store, fallback, fixedMode("auto"));
  const decision = await approver.approve(req("shell.exec", {}));
  assert.equal(decision.decision, "approve");
  assert.equal(fallback.calls, 0);
});

// ===========================================================================
// Routes: 503 when store absent
// ===========================================================================

test("permission routes 503 when no store is configured", async () => {
  const app = await buildApp(undefined);
  assert.equal((await app.inject({ method: "GET", url: "/v1/permissions" })).statusCode, 503);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/permissions/rules",
        payload: { scope: "user", bucket: "allow", rule: { tool: "fs.edit" } },
      })
    ).statusCode,
    503,
  );
  assert.equal(
    (await app.inject({ method: "DELETE", url: "/v1/permissions/rules?scope=user&bucket=allow&index=0" }))
      .statusCode,
    503,
  );
  assert.equal(
    (await app.inject({ method: "PUT", url: "/v1/permissions/mode", payload: { scope: "user", mode: "auto" } }))
      .statusCode,
    503,
  );
  await app.close();
});

// ===========================================================================
// Routes: GET snapshot
// ===========================================================================

test("GET returns the table snapshot", async () => {
  const store = new MemoryPermissionStore();
  await store.appendRule("project", "allow", wholeToolRule("git.diff"));
  const app = await buildApp(store);
  const res = await app.inject({ method: "GET", url: "/v1/permissions" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as PermissionTable;
  assert.equal(body.default_mode, "ask");
  assert.equal(body.allow.length, 1);
  assert.equal(body.allow[0]!.scope, "project");
  assert.equal(body.allow[0]!.tool, "git.diff");
  assert.deepEqual(body.deny, []);
  await app.close();
});

// ===========================================================================
// Routes: POST rule
// ===========================================================================

test("POST appends a rule → 201, visible in snapshot", async () => {
  const store = new MemoryPermissionStore();
  const app = await buildApp(store);
  const res = await app.inject({
    method: "POST",
    url: "/v1/permissions/rules",
    payload: { scope: "user", bucket: "deny", rule: { tool: "shell.exec", matchers: { "/command": "rm *" } } },
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json(), { ok: true });
  const table = await store.snapshot();
  assert.equal(table.deny.length, 1);
  assert.equal(table.deny[0]!.tool, "shell.exec");
  assert.deepEqual(table.deny[0]!.matchers, { "/command": "rm *" });
  await app.close();
});

test("POST rejects bad scope / bucket / empty tool → 400", async () => {
  const app = await buildApp(new MemoryPermissionStore());
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/permissions/rules",
        payload: { scope: "nope", bucket: "allow", rule: { tool: "x" } },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/permissions/rules",
        payload: { scope: "user", bucket: "nope", rule: { tool: "x" } },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/permissions/rules",
        payload: { scope: "user", bucket: "allow", rule: { tool: "" } },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/permissions/rules",
        payload: { scope: "user", bucket: "allow" }, // missing rule
      })
    ).statusCode,
    400,
  );
  await app.close();
});

// ===========================================================================
// Routes: DELETE rule
// ===========================================================================

test("DELETE removes a rule by index → 200", async () => {
  const store = new MemoryPermissionStore();
  await store.appendRule("user", "allow", wholeToolRule("a"));
  await store.appendRule("user", "allow", wholeToolRule("b"));
  const app = await buildApp(store);
  const res = await app.inject({
    method: "DELETE",
    url: "/v1/permissions/rules?scope=user&bucket=allow&index=0",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  const table = await store.snapshot();
  assert.equal(table.allow.length, 1);
  assert.equal(table.allow[0]!.tool, "b"); // index 0 ("a") removed
  await app.close();
});

test("DELETE out-of-bounds index → 404", async () => {
  const store = new MemoryPermissionStore();
  await store.appendRule("user", "allow", wholeToolRule("a"));
  const app = await buildApp(store);
  const res = await app.inject({
    method: "DELETE",
    url: "/v1/permissions/rules?scope=user&bucket=allow&index=5",
  });
  assert.equal(res.statusCode, 404);
  assert.match(res.json().error, /out of bounds/);
  await app.close();
});

test("DELETE rejects bad scope/bucket/index → 400", async () => {
  const app = await buildApp(new MemoryPermissionStore());
  assert.equal(
    (await app.inject({ method: "DELETE", url: "/v1/permissions/rules?scope=x&bucket=allow&index=0" })).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "DELETE", url: "/v1/permissions/rules?scope=user&bucket=x&index=0" })).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "DELETE", url: "/v1/permissions/rules?scope=user&bucket=allow&index=-1" }))
      .statusCode,
    400,
  );
  await app.close();
});

// ===========================================================================
// Routes: PUT mode
// ===========================================================================

test("PUT sets the default mode of a scope → 200", async () => {
  const store = new MemoryPermissionStore();
  const app = await buildApp(store);
  const res = await app.inject({
    method: "PUT",
    url: "/v1/permissions/mode",
    payload: { scope: "user", mode: "accept-edits" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, mode: "accept-edits" });
  assert.equal((await store.snapshot()).default_mode, "accept-edits");
  await app.close();
});

test("PUT accepts a mode alias", async () => {
  const store = new MemoryPermissionStore();
  const app = await buildApp(store);
  const res = await app.inject({
    method: "PUT",
    url: "/v1/permissions/mode",
    payload: { scope: "session", mode: "acceptEdits" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().mode, "accept-edits");
  await app.close();
});

test("PUT refuses bypass on the project scope → 400", async () => {
  const store = new MemoryPermissionStore();
  const app = await buildApp(store);
  const res = await app.inject({
    method: "PUT",
    url: "/v1/permissions/mode",
    payload: { scope: "project", mode: "bypass" },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /bypass mode cannot be written to project scope/);
  // ...but bypass on user / session scope is allowed.
  const ok = await app.inject({
    method: "PUT",
    url: "/v1/permissions/mode",
    payload: { scope: "user", mode: "bypass" },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal((await store.snapshot()).default_mode, "bypass");
  await app.close();
});

test("PUT rejects bad scope / unknown mode → 400", async () => {
  const app = await buildApp(new MemoryPermissionStore());
  assert.equal(
    (await app.inject({ method: "PUT", url: "/v1/permissions/mode", payload: { scope: "x", mode: "auto" } }))
      .statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "PUT", url: "/v1/permissions/mode", payload: { scope: "user", mode: "nope" } }))
      .statusCode,
    400,
  );
  await app.close();
});

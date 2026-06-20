import { test } from "node:test";
import assert from "node:assert/strict";

import {
  derivePack,
  deriveRisk,
  toolMetadataFromTool,
  toolMetadataToWire,
} from "./tool-metadata.ts";
import type { Tool } from "./tool.ts";

test("derivePack: fs.read/list/search are file-read, other fs is file-write", () => {
  assert.equal(derivePack("fs.read"), "file-read");
  assert.equal(derivePack("fs.list"), "file-read");
  assert.equal(derivePack("fs.search"), "file-read");
  assert.equal(derivePack("fs.write"), "file-write");
  assert.equal(derivePack("fs.edit"), "file-write");
  assert.equal(derivePack("fs.patch"), "file-write");
});

test("derivePack: prefix groups + unprefixed fall to other", () => {
  assert.equal(derivePack("code.grep"), "code-search");
  assert.equal(derivePack("git.status"), "git");
  assert.equal(derivePack("http.fetch"), "web");
  assert.equal(derivePack("subagent.review"), "sub-agent");
  assert.equal(derivePack("echo"), "other");
  assert.equal(derivePack("github.create_pr"), "other");
});

test("deriveRisk: specific name overrides win", () => {
  assert.equal(deriveRisk("shell.exec", "exec", true), "shell");
  assert.equal(deriveRisk("fs.write", "write", true), "workspace-write");
  assert.equal(deriveRisk("http.fetch", "network", false), "network");
});

test("deriveRisk: read-only git stays read-only, write git is workspace-write", () => {
  assert.equal(deriveRisk("git.status", "read", false), "read-only");
  assert.equal(deriveRisk("git.commit", "write", true), "workspace-write");
});

test("deriveRisk: subagent is external-side-effect; metadata namespaces gate on approval", () => {
  assert.equal(deriveRisk("subagent.review", "write", true), "external-side-effect");
  assert.equal(deriveRisk("todo.add", "write", false), "read-only");
  assert.equal(deriveRisk("requirement.create", "write", true), "metadata-write");
});

test("deriveRisk: falls back to trait category", () => {
  assert.equal(deriveRisk("echo", "read", false), "read-only");
  assert.equal(deriveRisk("mystery.do", "write", false), "metadata-write");
  assert.equal(deriveRisk("mystery.do", "write", true), "workspace-write");
});

const fakeTool = (over: Partial<Tool> & { name: string }): Tool => ({
  description: "d",
  parameters: { type: "object" },
  invoke: async () => "",
  ...over,
});

test("toolMetadataFromTool maps trait fields + classification", () => {
  const m = toolMetadataFromTool(
    fakeTool({ name: "fs.read", category: "read", description: "Read a file" }),
  );
  assert.equal(m.name, "fs.read");
  assert.equal(m.traitCategory, "read");
  assert.equal(m.pack, "file-read");
  assert.equal(m.risk, "read-only");
  assert.equal(m.source.kind, "builtin");
  assert.equal(m.enabled, true);
  assert.equal(m.cacheable, false);
});

test("toolMetadataToWire omits defaults (pack=other, source=builtin, isTerminal=false, no displayName)", () => {
  const wire = toolMetadataToWire(toolMetadataFromTool(fakeTool({ name: "echo", category: "read" })));
  assert.equal("pack" in wire, false); // echo → other
  assert.equal("source" in wire, false); // builtin
  assert.equal("isTerminal" in wire, false); // false
  assert.equal("displayName" in wire, false);
  assert.equal(wire.enabled, true); // always present
  assert.equal(wire.traitCategory, "read");
  assert.equal(wire.risk, "read-only");
});

test("toolMetadataToWire keeps non-default pack/source/isTerminal", () => {
  const m = toolMetadataFromTool(fakeTool({ name: "fs.write", category: "write", requiresApproval: true }));
  m.source = { kind: "subagent", subagent: "review" };
  m.isTerminal = true;
  const wire = toolMetadataToWire(m);
  assert.equal(wire.pack, "file-write");
  assert.deepEqual(wire.source, { kind: "subagent", subagent: "review" });
  assert.equal(wire.isTerminal, true);
});

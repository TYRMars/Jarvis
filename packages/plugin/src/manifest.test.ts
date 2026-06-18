// Tests for plugin.json manifest parsing. Ported from the `#[cfg(test)]`
// module in crates/harness-plugin/src/manifest.rs.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import {
  PluginManifestError,
  parsePluginManifest,
  pluginManifestToJson,
  validatePluginName,
} from "./manifest.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// packages/plugin/src → repo root is four levels up.
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

test("parses minimal manifest", () => {
  const raw = `{ "name": "demo", "version": "0.1.0", "description": "A demo plugin." }`;
  const m = parsePluginManifest(raw);
  assert.equal(m.name, "demo");
  assert.equal(m.version, "0.1.0");
  assert.equal(m.skills.length, 0);
  assert.equal(Object.keys(m.mcp_servers).length, 0);
  assert.equal(Object.keys(m.channel_adapters).length, 0);
});

test("parses full manifest (prefix omitted, supplied by map key)", () => {
  const raw = `{
    "name": "github-tools",
    "version": "0.2.0",
    "description": "Skills + MCP for GitHub workflows.",
    "author": "Jarvis Project",
    "license": "MIT",
    "homepage": "https://example.com",
    "skills": ["skills/triage", "skills/release"],
    "mcp_servers": {
      "github": {
        "transport": { "type": "stdio", "command": "uvx", "args": ["mcp-server-github"] }
      }
    }
  }`;
  const m = parsePluginManifest(raw);
  assert.equal(m.skills.length, 2);
  assert.equal(m.author, "Jarvis Project");
  const entry = m.mcp_servers["github"];
  assert.ok(entry);
  assert.equal(entry.prefix, "github", "prefix should match map key");
  assert.equal(entry.transport.type, "stdio");
  assert.deepEqual(
    entry.transport.type === "stdio" ? entry.transport.args : undefined,
    ["mcp-server-github"],
  );
});

test("explicit prefix in manifest is overridden by map key", () => {
  const raw = `{
    "name": "github-tools",
    "version": "0.2.0",
    "description": "x",
    "mcp_servers": {
      "github": {
        "prefix": "ignored-overridden",
        "transport": { "type": "stdio", "command": "uvx", "args": ["mcp-server-github"] }
      }
    }
  }`;
  const m = parsePluginManifest(raw);
  assert.equal(m.mcp_servers["github"]?.prefix, "github");
});

test("rejects invalid name", () => {
  const raw = `{ "name": "Bad_Name", "version": "0", "description": "x" }`;
  assert.throws(
    () => parsePluginManifest(raw),
    (e: unknown) => e instanceof PluginManifestError && e.kind === "invalid_name",
  );
});

test("rejects missing description", () => {
  const raw = `{ "name": "x", "version": "0.1.0", "description": "" }`;
  assert.throws(
    () => parsePluginManifest(raw),
    (e: unknown) => e instanceof PluginManifestError && e.kind === "missing_field",
  );
});

test("rejects malformed JSON", () => {
  assert.throws(
    () => parsePluginManifest("{ not json"),
    (e: unknown) => e instanceof PluginManifestError && e.kind === "invalid_json",
  );
});

test("allows unknown fields for forward-compat", () => {
  const raw = `{
    "name": "x",
    "version": "0.1.0",
    "description": "z",
    "future_thing": { "a": 1 }
  }`;
  // Should NOT throw — unknown top-level fields are ignored.
  assert.doesNotThrow(() => parsePluginManifest(raw));
});

test("parses channel_adapters block with default auto_restart", () => {
  const raw = `{
    "name": "wecom-bot",
    "version": "0.1.0",
    "description": "WeCom AI Bot channel adapter",
    "channel_adapters": {
      "wecom": {
        "transport": { "type": "stdio", "command": "jarvis-channel-wecom", "args": [] },
        "env": {
          "WECOM_BOT_ID": "\${env:WECOM_BOT_ID}",
          "WECOM_SECRET": "\${env:WECOM_SECRET}"
        }
      }
    }
  }`;
  const m = parsePluginManifest(raw);
  const entry = m.channel_adapters["wecom"];
  assert.ok(entry);
  assert.equal(entry.transport.type, "stdio");
  assert.equal(entry.transport.command, "jarvis-channel-wecom");
  assert.deepEqual(entry.transport.args, []);
  assert.equal(entry.env["WECOM_BOT_ID"], "${env:WECOM_BOT_ID}");
  // Default auto_restart kicks in when omitted.
  assert.equal(entry.auto_restart, true);
});

test("channel_adapter auto_restart can be overridden", () => {
  const raw = `{
    "name": "x",
    "version": "0.1.0",
    "description": "y",
    "channel_adapters": {
      "feishu": {
        "transport": { "type": "stdio", "command": "jarvis-channel-feishu" },
        "auto_restart": false
      }
    }
  }`;
  const m = parsePluginManifest(raw);
  assert.equal(m.channel_adapters["feishu"]?.auto_restart, false);
});

test("channel_adapter unknown transport type fails", () => {
  const raw = `{
    "name": "x",
    "version": "0.1.0",
    "description": "y",
    "channel_adapters": {
      "telegram": {
        "transport": { "type": "tcp", "host": "localhost", "port": 9000 }
      }
    }
  }`;
  assert.throws(() => parsePluginManifest(raw));
});

test("parses in-tree gitnexus example plugin", async () => {
  const raw = await readFile(
    path.join(REPO_ROOT, "examples", "plugins", "gitnexus", "plugin.json"),
    "utf8",
  );
  const m = parsePluginManifest(raw);
  assert.equal(m.name, "gitnexus");
  assert.deepEqual(m.skills, ["skills/gitnexus-workflow"]);
  const entry = m.mcp_servers["gitnexus"];
  assert.ok(entry);
  assert.equal(entry.prefix, "gitnexus");
  assert.equal(entry.transport.type, "stdio");
  if (entry.transport.type === "stdio") {
    assert.equal(entry.transport.command, "npx");
    assert.deepEqual(entry.transport.args, ["-y", "gitnexus", "mcp"]);
  }
});

test("validatePluginName accepts kebab and rejects bad shapes", () => {
  assert.equal(validatePluginName("github-tools"), true);
  assert.equal(validatePluginName("a"), true);
  assert.equal(validatePluginName("Bad_Name"), false);
  assert.equal(validatePluginName("-leading"), false);
  assert.equal(validatePluginName("trailing-"), false);
  assert.equal(validatePluginName(""), false);
  assert.equal(validatePluginName("x".repeat(65)), false);
  assert.equal(validatePluginName("x".repeat(64)), true);
});

test("pluginManifestToJson omits absent scalars and empty collections", () => {
  const m = parsePluginManifest(
    `{ "name": "demo", "version": "0.1.0", "description": "d" }`,
  );
  const json = pluginManifestToJson(m);
  assert.deepEqual(json, { name: "demo", version: "0.1.0", description: "d" });
  assert.equal("author" in json, false);
  assert.equal("skills" in json, false);
  assert.equal("mcp_servers" in json, false);
});

test("pluginManifestToJson round-trips a full manifest", () => {
  const raw = `{
    "name": "gh",
    "version": "1.0.0",
    "description": "d",
    "author": "me",
    "skills": ["skills/a"],
    "mcp_servers": {
      "gh": { "transport": { "type": "stdio", "command": "uvx", "args": [] } }
    }
  }`;
  const m = parsePluginManifest(raw);
  const reparsed = parsePluginManifest(JSON.stringify(pluginManifestToJson(m)));
  assert.deepEqual(reparsed, m);
});

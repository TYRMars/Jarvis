// Node sidecar for `subagent.claude_code`. Drives Anthropic's
// official `@anthropic-ai/claude-agent-sdk` and translates its
// streaming messages into a small JSON Lines protocol that the Rust
// side parses 1:1 into `SubAgentEvent` frames.
//
// Wire protocol (each line of stdout is one JSON object):
//
//   { "kind": "started",    "task": "..." }
//   { "kind": "delta",      "text": "..." }
//   { "kind": "tool_start", "name": "fs.read", "arguments": {...} }
//   { "kind": "tool_end",   "name": "fs.read", "output": "..." }
//   { "kind": "status",     "message": "init" }
//   { "kind": "done",       "final_message": "..." }
//   { "kind": "error",      "message": "..." }
//
// Input (single JSON object on stdin, then EOF):
//
//   { "task": "...", "workspace_root": "/abs/path", "model"?: "..." }
//
// Failure modes:
//
//   - SDK not installed → "Cannot find package" error → sidecar
//     prints `{kind: "error"}` then exits non-zero. The Rust side's
//     probe is supposed to catch this before we ever spawn for real
//     work, but the runtime path stays defensive.
//   - SDK throws mid-run → caught by the try/catch around the
//     for-await loop; reported as a single `error` frame.
//   - Auth missing (`ANTHROPIC_API_KEY` unset) → SDK throws on first
//     `query()` call; same path as above.

import { stdin, stdout, stderr, exit } from "node:process";

// Read stdin to EOF.
const input = await new Promise((resolve, reject) => {
  let buf = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (c) => (buf += c));
  stdin.on("end", () => resolve(buf));
  stdin.on("error", reject);
});

let parsed;
try {
  parsed = JSON.parse(input);
} catch (e) {
  emit("error", { message: `bad input json: ${e.message}` });
  exit(2);
}

const { task, workspace_root, model } = parsed;
if (!task || !workspace_root) {
  emit("error", { message: "missing required fields: task / workspace_root" });
  exit(2);
}

// Try to load the SDK. Resolve at runtime so the probe can fail
// cleanly without holding a hard `import`.
let query;
try {
  ({ query } = await import("@anthropic-ai/claude-agent-sdk"));
} catch (e) {
  emit("error", {
    message: `@anthropic-ai/claude-agent-sdk not installed: ${e.message}`,
  });
  exit(3);
}

emit("started", { task, model });

// Map tool_use ids → tool names so we can label tool_result frames
// with the right name. The SDK emits tool_use and tool_result in
// separate messages; this lookup glues them together.
const toolNames = new Map();

let finalMessage = "";

try {
  for await (const m of query({
    prompt: task,
    options: {
      cwd: workspace_root,
      // permissionMode mirrors the harness's `accept-edits` —
      // ClaudeCode runs read tools without prompting, edits stop
      // for confirmation. The outer agent's approver still gates
      // the entire `subagent.claude_code` invocation, so the user
      // already opted in once; we don't want a per-tool prompt
      // bursting in mid-run.
      permissionMode: "acceptEdits",
      model,
    },
  })) {
    if (!m || typeof m !== "object") continue;
    if (m.type === "system") {
      // System events: init, error notifications, etc. Surface as
      // status lines so the UI can show "[init]" / etc.
      const tag = m.subtype || "system";
      emit("status", { message: String(tag) });
      continue;
    }
    if (m.type === "assistant") {
      const content = m.message && m.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") {
            emit("delta", { text: block.text });
          } else if (block.type === "tool_use") {
            if (block.id) toolNames.set(block.id, block.name);
            emit("tool_start", {
              name: String(block.name),
              arguments: block.input ?? {},
            });
          }
        }
      }
      continue;
    }
    if (m.type === "user") {
      const content = m.message && m.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "tool_result") {
            const name = block.tool_use_id
              ? toolNames.get(block.tool_use_id) || "(unknown)"
              : "(unknown)";
            const out =
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content);
            emit("tool_end", { name, output: out });
          }
        }
      }
      continue;
    }
    if (m.type === "result") {
      // SDK terminal frame. Capture the final assistant text for
      // the `done` event we'll emit after the loop exits.
      if (typeof m.result === "string") finalMessage = m.result;
      continue;
    }
  }
} catch (e) {
  emit("error", { message: e?.stack || e?.message || String(e) });
  exit(1);
}

emit("done", { final_message: finalMessage });
exit(0);

function emit(kind, payload) {
  try {
    stdout.write(JSON.stringify({ kind, ...payload }) + "\n");
  } catch (e) {
    // Last-ditch — if stdout is broken there's nothing we can do.
    try {
      stderr.write(`emit failed: ${e.message}\n`);
    } catch {
      /* swallow */
    }
  }
}

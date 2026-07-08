// `ask.text` — text-based human-in-the-loop request tool.
// Ported from harness-tools/src/ask.rs.
//
// `ask.text` is the single text transport entry point: it can render as
// confirmation, free-form input, or a short choice list through its `kind`
// argument. Future modalities can live beside it as `ask.voice`, `ask.video`,
// etc. while reusing the same native HITL request/response protocol.
//
// DEFERRAL: the Rust version calls `harness_core::request_human(req)` which
// publishes a PendingHitl over a task-local mpsc channel installed by the
// agent loop / transport, then awaits the human's HitlResponse. @jarvis/core
// does not yet expose a HITL channel (no `request_human` / `with_hitl`), so
// this port is best-effort: it does the full arg validation and builds the
// HitlRequest, but — having no transport to await — returns the request as
// JSON tagged `"deferred": "no HITL channel"` so the agent loop has a textual
// result and the clarification text is surfaced. Swap the body of #dispatch
// for a real `requestHuman(req)` await once core lands the channel.
import { randomUUID } from "node:crypto";
import type { JsonValue } from "@jarvis/core";
import type { Tool, ToolCategory } from "@jarvis/core";

export type HitlKind = "confirm" | "input" | "choice" | "review";

export interface HitlOption {
  value: string;
  label: string;
}

export interface HitlRequest {
  id: string;
  transport: "text" | "voice" | "video";
  kind: HitlKind;
  title: string;
  body?: string;
  options?: HitlOption[];
  default_value?: JsonValue;
  metadata?: JsonValue;
}

// Ids must be collision-proof across process restarts: the web store dedups
// incoming HITL cards on `request.id` and retains cancelled cards, so a
// process-global counter that resets to 1 on restart could re-mint an id that
// collides with a stale cancelled card, silently dropping the new card and
// hanging the turn on `human.request()`. A random UUID never collides.
function mintId(): string {
  return `hitl_${randomUUID()}`;
}

function asObject(args: JsonValue): { [k: string]: JsonValue } {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }
  return args;
}

function parseKind(raw: string | undefined): HitlKind {
  switch (raw ?? "input") {
    case "input":
      return "input";
    case "confirm":
      return "confirm";
    case "choice":
      return "choice";
    case "review":
      return "review";
    default:
      throw new Error(`unsupported ask.text kind \`${raw}\``);
  }
}

function parseOptions(obj: { [k: string]: JsonValue }): HitlOption[] {
  const raw = obj["options"];
  if (!Array.isArray(raw)) {
    throw new Error("`options` must be an array for kind=choice");
  }
  const options: HitlOption[] = raw.map((v) => {
    if (typeof v !== "string") {
      throw new Error("every option must be a string");
    }
    return { value: v, label: v };
  });
  if (options.length === 0) {
    throw new Error("`options` must not be empty for kind=choice");
  }
  return options;
}

// `title` (and other required strings): present, a string, and non-empty after
// trimming.
function requiredString(obj: { [k: string]: JsonValue }, key: string): string {
  const v = obj[key];
  if (typeof v === "string" && v.trim().length > 0) {
    return v;
  }
  throw new Error(`\`${key}\` must be a non-empty string`);
}

// Optional string: trimmed; empty / missing / non-string → undefined.
function optionalString(obj: { [k: string]: JsonValue }, key: string): string | undefined {
  const v = obj[key];
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class AskTextTool implements Tool {
  readonly name = "ask.text";
  readonly category: ToolCategory = "read";
  readonly description =
    "Ask the human operator a text-based question. Use when you need missing " +
    "information, a confirmation, or a choice instead of guessing.";

  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["input", "confirm", "choice", "review"],
        description: "How the text prompt should be rendered. Defaults to input.",
      },
      title: {
        type: "string",
        description: "Short prompt title.",
      },
      body: {
        type: "string",
        description: "Optional context, proposed action, or question details.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description:
          "Required for kind=choice. Each string is used as both label and value.",
      },
      default_value: {
        type: "string",
        description: "Optional prefilled text or default choice value.",
      },
      multiline: {
        type: "boolean",
        description:
          "For kind=input, whether a multiline editor is preferred. Defaults to true.",
      },
    },
    required: ["title"],
    additionalProperties: false,
  };

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const title = requiredString(obj, "title");
    const kind = parseKind(optionalString(obj, "kind"));

    const multiline =
      typeof obj["multiline"] === "boolean" ? (obj["multiline"] as boolean) : true;

    const req: HitlRequest = {
      id: mintId(),
      transport: "text",
      kind,
      title,
      metadata: { tool: "ask.text", multiline },
    };

    const body = optionalString(obj, "body");
    if (body !== undefined) req.body = body;

    const defaultValue = optionalString(obj, "default_value");
    if (defaultValue !== undefined) req.default_value = defaultValue;

    if (kind === "choice") {
      req.options = parseOptions(obj);
    }

    return this.#dispatch(req);
  }

  // DEFERRED dispatch: no HITL transport in @jarvis/core yet. Return the built
  // request as JSON so the clarification text reaches the model. Replace with
  // `JSON.stringify(await requestHuman(req))` once core exposes the channel.
  #dispatch(req: HitlRequest): Promise<string> {
    return Promise.resolve(JSON.stringify({ deferred: "no HITL channel", request: req }));
  }
}

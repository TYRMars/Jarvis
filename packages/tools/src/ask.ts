// `ask.text` — text-based human-in-the-loop request tool.
// Ported from harness-tools/src/ask.rs.
//
// `ask.text` is the single text transport entry point: it can render as
// confirmation, free-form input, or a short choice list through its `kind`
// argument. Future modalities can live beside it as `ask.voice`, `ask.video`,
// etc. while reusing the same native HITL request/response protocol.
//
// It builds a HitlRequest and hands it to `@jarvis/core`'s `requestHuman`,
// which the streaming agent loop bridges to the transport's HumanLayer (the
// WS `ChannelHuman`): the operator's card answer flows back as a HitlResponse.
// The invoke returns `{request, response}` as JSON so the model sees both the
// question it asked and the answer. Outside a HITL scope (blocking run / no
// transport) `requestHuman` resolves an `expired` response, so it never hangs.
import type { JsonValue } from "@jarvis/core";
import type { Tool, ToolCategory } from "@jarvis/core";
import { requestHuman } from "@jarvis/core";
import type { HitlKind, HitlOption, HitlRequest } from "@jarvis/core";

// Re-export the wire types so `@jarvis/tools` consumers keep importing them
// from here even though they now live in `@jarvis/core`.
export type { HitlKind, HitlOption, HitlRequest } from "@jarvis/core";

let nextId = 1;
function mintId(): string {
  return `hitl_${nextId++}`;
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

  // Surface the request to the operator via core's HITL channel and await the
  // answer. The loop emits the `hitl_request` card and resolves this once the
  // operator responds (or immediately with `expired` when no transport is
  // installed). Return both sides as JSON so the model has the full exchange.
  async #dispatch(req: HitlRequest): Promise<string> {
    const response = await requestHuman(req);
    return JSON.stringify({ request: req, response });
  }
}

// `echo` — trivial always-on tool. Ported from harness-tools/src/echo.rs.
//
// Returns its `text` argument back verbatim. Useful for smoke-testing the
// tool loop end to end.
import type { JsonValue } from "@jarvis/core";
import type { Tool, ToolCategory } from "@jarvis/core";

export class EchoTool implements Tool {
  readonly name = "echo";
  readonly description = "Echo the `text` argument back verbatim. Useful for testing the tool loop.";
  readonly cacheable = true;
  readonly category: ToolCategory = "read";

  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to echo." },
    },
    required: ["text"],
  };

  async invoke(args: JsonValue): Promise<string> {
    const text =
      args !== null && typeof args === "object" && !Array.isArray(args)
        ? args["text"]
        : undefined;
    if (typeof text !== "string") {
      throw new Error("missing `text` argument");
    }
    return text;
  }
}

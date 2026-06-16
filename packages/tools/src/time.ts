// `time.now` — always-on read-only clock. Ported from harness-tools/src/time.rs.
//
// Returns the current UTC time as both a Unix timestamp (seconds) and an
// RFC3339 string: {unix: <seconds>, iso: <RFC3339>}.
import type { JsonValue } from "@jarvis/core";
import type { Tool, ToolCategory } from "@jarvis/core";

export class TimeNowTool implements Tool {
  readonly name = "time.now";
  readonly description = "Returns the current UTC time as {unix: <seconds>, iso: <RFC3339>}.";
  readonly cacheable = true;
  readonly category: ToolCategory = "read";

  readonly parameters: JsonValue = {
    type: "object",
    properties: {},
  };

  async invoke(_args: JsonValue): Promise<string> {
    const now = new Date();
    const body = {
      unix: Math.floor(now.getTime() / 1000),
      iso: now.toISOString(),
    };
    return JSON.stringify(body);
  }
}

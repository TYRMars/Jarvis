// Wire shape of subagent frames as they arrive over the WS / SSE
// channel. Mirrors `harness_core::SubAgentFrame` exactly so renderers
// can serde the JSON 1:1 without an extra adapter layer.
//
// Keep aligned with `crates/harness-core/src/subagent.rs`.

export type SubAgentEvent =
  | { kind: "started"; task: string; model?: string }
  | { kind: "delta"; text: string }
  | { kind: "tool_start"; name: string; arguments: unknown }
  | { kind: "tool_end"; name: string; output: string }
  | { kind: "status"; message: string }
  | { kind: "done"; final_message: string }
  | { kind: "error"; message: string };

export interface SubAgentFrame {
  subagent_id: string;
  subagent_name: string;
  event: SubAgentEvent;
}

/// Aggregated view of one subagent run, built by reducing a stream
/// of [`SubAgentFrame`]s. The card and rail render off this shape so
/// late subscribers / page reloads see the same picture as someone
/// who watched the run live.
export interface SubAgentRun {
  id: string;
  name: string;
  task: string;
  model?: string;
  startedAt: number; // ms epoch
  endedAt?: number;
  status: "running" | "done" | "error";
  finalMessage?: string;
  errorMessage?: string;
  /// Ordered timeline of events relevant for display: tool calls,
  /// status updates, and accumulated text deltas. `Done` / `Error`
  /// don't appear here — they're surfaced via `status` / `endedAt` /
  /// `finalMessage`.
  timeline: TimelineEntry[];
}

export type TimelineEntry =
  | { kind: "tool"; name: string; args: unknown; output?: string; tStart: number; tEnd?: number }
  | { kind: "status"; message: string; t: number }
  | { kind: "delta"; text: string; t: number };

/// Reducer step: apply one frame to a run, mutating in place. Used
/// by both the inline card and the side-panel store. Pulling this
/// out into a single function keeps the two consumers aligned.
export function applyFrame(run: SubAgentRun, frame: SubAgentFrame, now: number): SubAgentRun {
  const next: SubAgentRun = { ...run, timeline: run.timeline.slice() };
  switch (frame.event.kind) {
    case "started":
      next.task = frame.event.task;
      next.model = frame.event.model;
      next.startedAt = now;
      next.status = "running";
      break;
    case "delta": {
      const last = next.timeline[next.timeline.length - 1];
      if (last && last.kind === "delta") {
        // Concat consecutive deltas so the UI doesn't re-render N
        // times for what's logically one streaming text block.
        next.timeline[next.timeline.length - 1] = {
          kind: "delta",
          text: last.text + frame.event.text,
          t: last.t,
        };
      } else {
        next.timeline.push({ kind: "delta", text: frame.event.text, t: now });
      }
      break;
    }
    case "tool_start":
      next.timeline.push({
        kind: "tool",
        name: frame.event.name,
        args: frame.event.arguments,
        tStart: now,
      });
      break;
    case "tool_end": {
      // Find the most recent un-ended tool call with the same name.
      for (let i = next.timeline.length - 1; i >= 0; i--) {
        const entry = next.timeline[i];
        if (entry.kind === "tool" && entry.name === frame.event.name && entry.tEnd === undefined) {
          next.timeline[i] = { ...entry, output: frame.event.output, tEnd: now };
          break;
        }
      }
      break;
    }
    case "status":
      next.timeline.push({ kind: "status", message: frame.event.message, t: now });
      break;
    case "done":
      next.status = "done";
      next.endedAt = now;
      next.finalMessage = frame.event.final_message;
      break;
    case "error":
      next.status = "error";
      next.endedAt = now;
      next.errorMessage = frame.event.message;
      break;
  }
  return next;
}

/// Initial empty run shell used before any `started` frame arrives.
export function emptyRun(id: string, name: string): SubAgentRun {
  return {
    id,
    name,
    task: "",
    startedAt: Date.now(),
    status: "running",
    timeline: [],
  };
}

/// Format a ms duration into a compact human string ("12s" / "1.4m").
export function fmtElapsed(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  return `${(s / 60).toFixed(1)}m`;
}

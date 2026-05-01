// Tool-call lifecycle frames. `tool_start` opens a block + a rail
// task, `tool_progress` appends streamed stdout/stderr, `tool_end`
// closes the block and reclassifies the task by inspecting the
// content prefix (denied / error / ok).
//
// `ask.*` tools are filtered at `tool_start` — the native ask flow
// renders its own card via `hitl_request` and would otherwise show
// up twice.

import { appStore } from "../../store/appStore";

export const toolFrameHandlers: Record<string, (ev: any) => void> = {
  tool_start: (ev) => {
    if (typeof ev.name === "string" && ev.name.startsWith("ask.")) return;
    const store = appStore.getState();
    store.upsertTask({ id: ev.id, name: ev.name, args: ev.arguments, status: "running" });
    store.pushToolStart(ev.id, ev.name, ev.arguments);
  },
  tool_progress: (ev) => {
    appStore.getState().appendToolProgress(ev.id, ev.stream, ev.chunk);
  },
  tool_end: onToolEnd,
};

function onToolEnd(ev: any): void {
  const store = appStore.getState();
  const block = store.toolBlocks[ev.id];
  store.setToolEnd(ev.id, ev.content);
  if (!block) return;
  const denied = ev.content.startsWith("tool denied:");
  const failed = ev.content.startsWith("tool error:");
  const status = denied ? "denied" : failed ? "error" : "ok";
  store.upsertTask({ id: ev.id, name: block.name, args: block.args, status });
}

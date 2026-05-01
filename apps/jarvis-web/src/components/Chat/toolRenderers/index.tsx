// Tool args / output section dispatchers. ToolBlock decides
// "show args" / "show output" + handles the four-tier defaultOpen
// logic; this module owns the per-tool rendering picks so the
// shell stays a thin layout concern.
//
// Add a new specialised renderer here, not in ToolBlock.

import type { ReactNode } from "react";
import { FsEditDiff } from "../FsEditDiff";
import { FsWriteCard } from "../FsWriteCard";
import { ProjectChecksCard } from "../ProjectChecksCard";
import { UnifiedDiffViewer } from "../UnifiedDiffViewer";
import { WorkspaceContextCard } from "../WorkspaceContextCard";
import { t } from "../../../utils/i18n";
import { ToolOutput } from "./ToolOutput";
import { safeStringify } from "./util";

/// Render the "args" section of a tool block. Returns the full
/// section contents (label included where the renderer wants one).
export function renderArgsSection(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any,
): ReactNode {
  if (name === "fs.edit") {
    return (
      <>
        <div className="tool-label">{t("editing")}</div>
        <FsEditDiff args={args || {}} />
      </>
    );
  }
  if (name === "fs.write") {
    return <FsWriteCard args={args || {}} />;
  }
  if (name === "fs.patch" && typeof args?.diff === "string") {
    return (
      <>
        <div className="tool-label">{t("toolArguments")}</div>
        <UnifiedDiffViewer content={args.diff} />
      </>
    );
  }
  return (
    <>
      <div className="tool-label">{t("toolArguments")}</div>
      <pre className="tool-pre">{safeStringify(args)}</pre>
    </>
  );
}

/// Render the "output" section body — i.e. the part *after* the
/// `<div class="tool-label">{output}</div>` row. ToolBlock writes
/// the label; this returns the body so each renderer can swap
/// the actual presentation (diff viewer, structured card, plain
/// truncated text).
export function renderOutputBody(name: string, output: string): ReactNode {
  if (name === "git.diff" && output.trim() && output !== "(no changes)") {
    return <UnifiedDiffViewer content={output} />;
  }
  if (name === "workspace.context") {
    return <WorkspaceContextCard content={output} />;
  }
  if (name === "project.checks") {
    return <ProjectChecksCard content={output} />;
  }
  return <ToolOutput content={output} />;
}

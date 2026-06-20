// Verification-plan executor. Ported from harness-server/src/verification.rs.
// Runs each command via `sh -c <cmd>` (or `cmd /C` on Windows) inside the run's
// workspace, captures exit code + truncated stdout/stderr, and aggregates a
// VerificationResult: Failed if ANY command exits non-zero or times out, else
// NeedsReview when `require_human_review`, else Passed (an empty plan passes).
import { execFile } from "node:child_process";
import type { CommandResult, VerificationPlan, VerificationResult, VerificationStatus } from "@jarvis/project";

export const DEFAULT_TIMEOUT_MS = 30_000;
const OUTPUT_CAP_BYTES = 16 * 1024;

function truncate(buf: Buffer): string {
  const s = buf.toString("utf8");
  return s.length <= OUTPUT_CAP_BYTES ? s : `${s.slice(0, OUTPUT_CAP_BYTES)}\n…[truncated]`;
}

/** Run one command (`sh -c` / `cmd /C`) in `workspace`. Never rejects. */
function runOne(workspace: string, command: string, timeoutMs: number): Promise<CommandResult> {
  const started = Date.now();
  const isWin = process.platform === "win32";
  const file = isWin ? "cmd" : "sh";
  const args = isWin ? ["/C", command] : ["-c", command];
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: workspace, timeout: timeoutMs, encoding: "buffer", maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const duration_ms = Date.now() - started;
        const out = stdout as unknown as Buffer;
        const errBuf = stderr as unknown as Buffer;
        const result: CommandResult = { command, duration_ms };
        const setOutput = () => {
          const so = truncate(out);
          if (so !== "") result.stdout = so;
          const se = truncate(errBuf);
          if (se !== "") result.stderr = se;
        };
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          if (e.killed || e.signal === "SIGTERM") {
            // exit_code stays undefined → counted as a failure.
            result.stderr = `verification: timed out after ${timeoutMs}ms`;
          } else if (typeof e.code === "string") {
            result.stderr = `verification: spawn failed: ${e.message}`;
          } else {
            result.exit_code = typeof e.code === "number" ? e.code : 1;
            setOutput();
          }
        } else {
          result.exit_code = 0;
          setOutput();
        }
        resolve(result);
      },
    );
  });
}

/** Execute every command in `plan` against `workspace`. Mirrors `execute_plan`. */
export async function executePlan(
  workspace: string,
  plan: VerificationPlan,
  timeoutMs: number,
): Promise<VerificationResult> {
  const budget = timeoutMs === 0 ? DEFAULT_TIMEOUT_MS : timeoutMs;
  const commandResults: CommandResult[] = [];
  let bad = false;
  for (const cmd of plan.commands) {
    const r = await runOne(workspace, cmd, budget);
    if (r.exit_code === undefined || r.exit_code !== 0) bad = true;
    commandResults.push(r);
  }
  let status: VerificationStatus;
  if (plan.commands.length === 0) status = "passed";
  else if (bad) status = "failed";
  else if (plan.require_human_review) status = "needs_review";
  else status = "passed";
  return { status, command_results: commandResults };
}

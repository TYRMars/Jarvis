// Specialised body for `shell.exec` approval cards.
//
// The default ApprovalCard dumps the JSON args verbatim — fine for
// fs.edit / fs.patch where the args are small and obvious, but for
// shell.exec the *command* is the only thing the user actually
// needs to read, and burying it inside `{ "command": "..." }` syntax
// makes the approval slower than it should be.
//
// We render:
//   • the command, big and monospaced
//   • cwd (if present, relative to workspace root) and timeout
//   • a "danger" chip when the command matches a known-risky
//     pattern (rm -rf, curl | sh, > /dev/, etc.) — we still let the
//     user approve, but we want them to pause first.

interface Props {
  args: any;
}

/// Patterns that should make the user think twice before approving.
/// Deliberately conservative — false positives are annoying but a
/// missed `rm -rf /` is much worse. Each pattern targets the canonical
/// dangerous shape, not every variant; we trust the user to read the
/// command itself when the chip flags one.
const DANGER_PATTERNS: Array<{ re: RegExp; key: string }> = [
  { re: /\brm\s+(-[rRf]+\s+)*\/(\s|$)/, key: "rm-root" },
  { re: /\brm\s+-[rRf]+\s+~/, key: "rm-home" },
  { re: /\brm\s+(-[rRf]+\s+)*\*\s*$/, key: "rm-glob" },
  { re: /\bcurl\b[^|]*\|\s*(sh|bash|zsh|python)/, key: "curl-pipe-sh" },
  { re: /\bwget\b[^|]*\|\s*(sh|bash|zsh|python)/, key: "wget-pipe-sh" },
  { re: />\s*\/dev\/(sd|nvme|disk)/, key: "write-block-device" },
  { re: /\bdd\s+.*\bof=\/dev\//, key: "dd-device" },
  { re: /\bgit\s+push\s+(-[fF]\b|--force)/, key: "git-force-push" },
  { re: /\bsudo\s+(rm|chmod|chown|dd)\b/, key: "sudo-destructive" },
];

function detectDanger(command: string): string | null {
  for (const p of DANGER_PATTERNS) {
    if (p.re.test(command)) return p.key;
  }
  return null;
}

export function ShellExecDetail({ args }: Props) {
  const command = typeof args?.command === "string" ? args.command : "";
  const cwd = typeof args?.cwd === "string" ? args.cwd : null;
  const timeoutMs =
    typeof args?.timeout_ms === "number" ? args.timeout_ms : null;
  const danger = command ? detectDanger(command) : null;

  return (
    <div className="shell-exec-detail">
      {danger ? (
        <div className="shell-exec-danger" role="alert" data-danger={danger}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <circle cx="12" cy="17" r="0.5" fill="currentColor" />
          </svg>
          <span>danger pattern: {danger}</span>
        </div>
      ) : null}

      <div className="shell-exec-cmd">
        <span className="shell-exec-prompt" aria-hidden="true">$</span>
        <code>{command || "(empty command)"}</code>
      </div>

      {(cwd || timeoutMs != null) ? (
        <div className="shell-exec-meta">
          {cwd ? (
            <span className="shell-exec-meta-item">
              <span className="shell-exec-meta-label">cwd</span>
              <code>{cwd}</code>
            </span>
          ) : null}
          {timeoutMs != null ? (
            <span className="shell-exec-meta-item">
              <span className="shell-exec-meta-label">timeout</span>
              <code>{Math.round(timeoutMs / 100) / 10}s</code>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

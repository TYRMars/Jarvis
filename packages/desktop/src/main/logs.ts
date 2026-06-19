// In-memory ring buffer for desktop + server lifecycle breadcrumbs.
//
// Port of apps/jarvis-desktop/src/logs.rs (`LogBuffer`). Bounded to MAX_LINES so
// a long-running session can't grow it without limit; `tail(n)` returns the most
// recent `n` lines for the status payload / the `desktop_logs` IPC call.
//
// Electron-free on purpose so it can be unit-tested under plain `node --test`.

const MAX_LINES = 400;

export class LogBuffer {
  private readonly lines: string[] = [];
  private readonly max: number;

  constructor(max: number = MAX_LINES) {
    this.max = max > 0 ? max : MAX_LINES;
  }

  /** Append a line (multi-line input is split; blank lines dropped). */
  push(line: string): void {
    for (const raw of line.split(/\r?\n/)) {
      const trimmed = raw.replace(/\s+$/, "");
      if (trimmed.length === 0) continue;
      this.lines.push(trimmed);
    }
    const overflow = this.lines.length - this.max;
    if (overflow > 0) this.lines.splice(0, overflow);
  }

  /** The most recent `limit` lines (oldest-first). */
  tail(limit: number): string[] {
    if (limit <= 0) return [];
    const start = Math.max(0, this.lines.length - limit);
    return this.lines.slice(start);
  }

  /** Total buffered line count (after de-duplication of blanks). */
  get size(): number {
    return this.lines.length;
  }
}

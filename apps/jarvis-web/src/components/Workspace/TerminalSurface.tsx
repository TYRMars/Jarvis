// Right-rail Terminal panel — a real interactive shell powered by
// xterm.js on the wire and a `portable-pty` backed WebSocket on the
// server (`crates/harness-server/src/workspace_terminal.rs`).
//
// Wire protocol (small):
//   client → server (text):   {"t":"input","data":"…"}      stdin
//                             {"t":"resize","cols":N,"rows":M}
//   server → client (binary): raw PTY bytes (ANSI escape sequences,
//                             UTF-8, control chars all preserved)
//
// xterm.js is loaded eagerly here — it's only mounted when the
// Terminal panel is actually visible (the rail filters
// `openPanels` before render), so the cost only hits users who
// open the panel. CSS for the canvas comes from the package's
// own stylesheet, imported here.
//
// Multi-folder workspaces: the active workspace path (`socketWorkspace`
// → `draftWorkspacePath`) is forwarded as `?root=<abs>` so the shell
// `cwd` matches the folder the user is currently focused on. Switching
// workspaces tears down + reopens the WS to start a fresh shell in
// the new folder.

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "../../store/appStore";
import { apiUrl } from "../../services/api";
import { t } from "../../utils/i18n";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

interface CapabilityProbe {
  available: boolean;
  shell?: string;
  reason?: string;
}

function buildWsUrl(root: string | null, cols: number, rows: number): string {
  // Resolve the same way the api helper does, but produce a ws:// URL.
  const usesExternal =
    location.protocol === "file:" ||
    ["4173", "5173"].includes(location.port);
  let base: URL;
  if (usesExternal) {
    const saved = localStorage.getItem("jarvis.apiOrigin") || "http://127.0.0.1:7001";
    base = new URL(saved);
  } else {
    base = new URL(location.href);
  }
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/v1/workspace/terminal/ws";
  base.search = "";
  const params = new URLSearchParams();
  if (root) params.set("root", root);
  params.set("cols", String(cols));
  params.set("rows", String(rows));
  base.search = `?${params.toString()}`;
  base.hash = "";
  return base.toString();
}

export function TerminalSurface() {
  const draftWorkspacePath = useAppStore((s) => s.draftWorkspacePath);
  const socketWorkspace = useAppStore((s) => s.socketWorkspace);
  const root = socketWorkspace ?? draftWorkspacePath ?? null;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "probing" }
    | { kind: "unavailable"; reason: string }
    | { kind: "connecting" }
    | { kind: "open" }
    | { kind: "closed"; reason: string }
  >({ kind: "idle" });

  // Capability probe on mount — if the server has no workspace
  // root, render a clean unavailable state instead of a failing WS.
  // 404 here is a strong signal the binary predates this UI build:
  // surface a rebuild hint so the user doesn't think the panel is
  // broken in some opaque way.
  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "probing" });
    void fetch(apiUrl("/v1/workspace/terminal"))
      .then(async (r) => {
        if (r.status === 404) {
          throw new Error(
            tx(
              "terminalNeedsServerRebuild",
              "Server has no /v1/workspace/terminal route — rebuild and restart `jarvis serve`.",
            ),
          );
        }
        if (!r.ok) throw new Error(`probe ${r.status}`);
        return (await r.json()) as CapabilityProbe;
      })
      .then((data) => {
        if (cancelled) return;
        if (!data.available) {
          setStatus({
            kind: "unavailable",
            reason:
              data.reason ?? tx("terminalUnavailable", "Terminal unavailable on this server."),
          });
        } else {
          setStatus({ kind: "idle" });
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setStatus({ kind: "unavailable", reason: String(e?.message ?? e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Mount xterm + open WS whenever we transition out of unavailable
  // and the workspace root changes.
  useEffect(() => {
    if (status.kind === "unavailable" || status.kind === "probing") return;
    const host = containerRef.current;
    if (!host) return;

    const term = new XTerminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      theme: {
        background: "#0c0d10",
        foreground: "#e6e8eb",
        cursor: "#9aa0a6",
        selectionBackground: "rgba(120, 140, 200, 0.35)",
      },
      allowProposedApi: true,
      convertEol: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      // Container may not have layout yet; the resize observer fires below.
    }
    termRef.current = term;
    fitRef.current = fit;

    setStatus({ kind: "connecting" });
    const ws = new WebSocket(buildWsUrl(root, term.cols, term.rows));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus({ kind: "open" });
      ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const decoder = new TextDecoder("utf-8", { fatal: false });
        term.write(decoder.decode(new Uint8Array(ev.data)));
      } else if (typeof ev.data === "string") {
        term.write(ev.data);
      }
    };
    ws.onerror = () => {
      // Detail comes via onclose; just note the failure on screen so
      // the user isn't staring at a frozen prompt.
      term.writeln("\r\n[\x1b[31mwebsocket error\x1b[0m]\r\n");
    };
    ws.onclose = (ev) => {
      setStatus({ kind: "closed", reason: ev.reason || "disconnected" });
      term.writeln(
        `\r\n[\x1b[33msession closed${ev.reason ? `: ${ev.reason}` : ""}\x1b[0m]\r\n`,
      );
    };

    const dataDisposable = term.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ t: "input", data }));
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ t: "resize", cols, rows }));
    });

    // Keep xterm sized to the panel as the user opens/closes other
    // rail cards (which changes our height).
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // Container not laid out yet.
      }
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
    // We intentionally re-init on root change so the new shell starts
    // in the freshly-pinned workspace folder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, status.kind === "unavailable" || status.kind === "probing"]);

  if (status.kind === "unavailable") {
    return (
      <div className="rail-coming-soon" aria-live="polite">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m8 9 3 3-3 3" />
          <path d="M13 15h4" />
        </svg>
        <strong>{tx("terminalUnavailableTitle", "Terminal unavailable")}</strong>
        <span>{status.reason}</span>
      </div>
    );
  }

  return (
    <div className="terminal-surface">
      <div
        ref={containerRef}
        className="terminal-xterm-host"
        role="application"
        aria-label={tx("panelTerminal", "Terminal")}
      />
      {status.kind === "connecting" || status.kind === "probing" ? (
        <div className="terminal-status terminal-status-info">
          {tx("terminalConnecting", "Connecting…")}
        </div>
      ) : status.kind === "closed" ? (
        <div className="terminal-status terminal-status-warn">
          {tx("terminalClosed", "Session closed")} · {status.reason}
        </div>
      ) : null}
    </div>
  );
}

// Networking helpers for the embedded-server lifecycle.
//
// `pickPort` mirrors sidecar.rs::pick_port (bind :0, read the assigned port).
// `probeHealth` mirrors sidecar.rs::health_ok — a short-timeout GET /health used
// to decide whether an external `jarvis serve` is already running before we
// start our own embedded instance.
//
// Electron-free so it can be unit-tested under plain `node --test`.
import net from "node:net";

/** Bind an ephemeral port on `host` and return it (the listener is closed). */
export function pickPort(host = "127.0.0.1"): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else if (port > 0) resolve(port);
        else reject(new Error("could not determine an ephemeral port"));
      });
    });
  });
}

/** True when `e` is a Node listen EADDRINUSE error (port already bound). */
export function isAddrInUse(e: unknown): boolean {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  if (code === "EADDRINUSE") return true;
  return e instanceof Error && e.message.includes("EADDRINUSE");
}

/**
 * Bind via `bind(port)`, retrying on a freshly-picked ephemeral port when the
 * chosen port was claimed between selection and bind (`EADDRINUSE`).
 *
 * `pickPort` binds `:0`, reads the assigned port, then *closes* the listener and
 * returns the now-free port — so across the (slow) work between picking and
 * binding, the port is unowned and can be taken by any other local listener.
 * Without a retry a lost race leaves the server permanently stopped with no
 * recovery. This closes that TOCTOU window (issue #318).
 *
 * Only `EADDRINUSE` is retried; any other bind error (and the final attempt)
 * rejects so real failures still surface. Returns the live handle and the port
 * actually bound. `pick`/`maxAttempts` are injectable for tests.
 */
export async function bindWithRetry<T>(
  firstPort: number,
  bind: (port: number) => Promise<T>,
  opts: {
    host?: string;
    maxAttempts?: number;
    pick?: (host: string) => Promise<number>;
    onRetry?: (takenPort: number, nextPort: number, attempt: number) => void;
  } = {},
): Promise<{ handle: T; port: number }> {
  const host = opts.host ?? "127.0.0.1";
  const maxAttempts = opts.maxAttempts ?? 5;
  const pick = opts.pick ?? pickPort;
  let port = firstPort;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const handle = await bind(port);
      return { handle, port };
    } catch (e) {
      if (!isAddrInUse(e) || attempt === maxAttempts) throw e;
      const next = await pick(host);
      opts.onRetry?.(port, next, attempt);
      port = next;
    }
  }
  // Unreachable: the loop returns on success or throws on the final attempt.
  throw new Error("bindWithRetry: exhausted attempts");
}

/**
 * GET `<origin>/health` with a hard timeout. Returns true only on a 2xx — used
 * to detect an already-running Jarvis server we can reuse instead of starting a
 * second one. Never throws (a refused connection / timeout is just `false`).
 */
export async function probeHealth(origin: string, timeoutMs = 400): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${origin.replace(/\/$/, "")}/health`;
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

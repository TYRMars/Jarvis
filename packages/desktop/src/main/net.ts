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
export function pickPort(host = "127.0.0.1", preferred?: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const tryBind = (candidate: number, fallback: boolean): void => {
      const srv = net.createServer();
      srv.unref();
      srv.once("error", (err) => {
        // A busy/blocked preferred port falls back to an ephemeral one — the
        // caller reads the actual port from the resolved value either way.
        if (fallback) tryBind(0, false);
        else reject(err);
      });
      srv.listen(candidate, host, () => {
        const addr = srv.address();
        const port = addr !== null && typeof addr === "object" ? addr.port : 0;
        srv.close((err) => {
          if (err) reject(err);
          else if (port > 0) resolve(port);
          else reject(new Error("could not determine an ephemeral port"));
        });
      });
    };
    if (preferred !== undefined && preferred > 0) tryBind(preferred, true);
    else tryBind(0, false);
  });
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

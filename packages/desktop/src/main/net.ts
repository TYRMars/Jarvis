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

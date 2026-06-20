import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import pkg from "./package.json" with { type: "json" };

// Backend origin the SPA talks to. Defaults to the loopback :7001 both the
// Rust `harness-server` and the Node `@jarvis/jarvis-app serve` listen on.
// Override with `VITE_BACKEND_URL=http://127.0.0.1:7002` to point the dev
// proxy + the dev/file-origin fallback at a different backend (e.g. run the
// Node server on a second port and flip the SPA to it during the migration).
// Production builds are served same-origin by whichever backend bundles
// `dist/`, so this only affects `vite dev` and non-same-origin previews.
const BACKEND_URL = process.env.VITE_BACKEND_URL || "http://127.0.0.1:7001";

export default defineConfig({
  // Mounted at the server root since the UI moved off `/ui/`. Leave
  // `base` at the default "/" so vite emits absolute asset paths
  // (`/assets/foo.js`) that work both behind the bundled
  // `harness-server` binary and from `vite preview` directly.
  // Desktop/Tauri builds load through the app asset protocol instead
  // of a normal HTTP origin, so use relative asset URLs there.
  //
  // Tailwind v4 ships its own Vite plugin; no `tailwind.config.js` /
  // PostCSS / `content` glob needed — utilities are JIT-scanned from
  // `src/**` automatically. The legacy `styles.css` continues to work
  // alongside Tailwind utilities (we layer Tailwind under the existing
  // base layer via `@import "tailwindcss"` at the top of styles.css).
  base: process.env.JARVIS_DESKTOP_BUILD ? "./" : "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Mirror the tsconfig `paths` entry so any non-type import would also
      // resolve. The @jarvis/shared-types imports are type-only (erased by
      // esbuild), so this is belt-and-suspenders for the standalone build.
      "@jarvis/shared-types": fileURLToPath(
        new URL("../../packages/shared-types/src/index.ts", import.meta.url),
      ),
    },
  },
  define: {
    // Surfaced in the Settings → About section so users can confirm
    // which build is running. `JSON.stringify` because vite's
    // `define` does naive substitution — bare `pkg.version` would
    // produce `0.1.0` as JS code, not a string literal.
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Build-time backend origin, read by services/api.ts for the
    // dev/file-origin fallback. Same naive-substitution caveat as above.
    __BACKEND_URL__: JSON.stringify(BACKEND_URL),
  },
  optimizeDeps: {
    include: ["lottie-web", "lottie-web/build/player/lottie_svg"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: false,
    // Dev-time proxy so cross-origin fetches from `http://localhost:5173`
    // don't hit CORS against the bundled `harness-server` on :7001.
    // Production builds are served same-origin from the Rust binary
    // (via `include_dir!`), so this only kicks in during `vite dev`.
    proxy: {
      "/v1": { target: BACKEND_URL, changeOrigin: true, ws: true },
      "/health": { target: BACKEND_URL, changeOrigin: true },
    },
  },
});

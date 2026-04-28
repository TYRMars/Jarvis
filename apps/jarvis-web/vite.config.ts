import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  // Mounted at the server root since the UI moved off `/ui/`. Leave
  // `base` at the default "/" so vite emits absolute asset paths
  // (`/assets/foo.js`) that work both behind the bundled
  // `harness-server` binary and from `vite preview` directly.
  plugins: [react()],
  define: {
    // Surfaced in the Settings → About section so users can confirm
    // which build is running. `JSON.stringify` because vite's
    // `define` does naive substitution — bare `pkg.version` would
    // produce `0.1.0` as JS code, not a string literal.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});

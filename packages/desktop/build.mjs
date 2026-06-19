// Bundle the Electron main + preload with esbuild.
//
// The @jarvis/* packages ship as TypeScript source (`exports: ./src/index.ts`,
// run via `node --experimental-strip-types` everywhere else). Electron's main
// process can't strip types across the whole dependency graph, so we bundle them
// into self-contained CJS here. Native addons stay EXTERNAL — they're resolved
// from node_modules at runtime and rebuilt against Electron's ABI by
// electron-builder (npmRebuild) / `electron-rebuild` in dev.
//
// CJS output is deliberate: nothing in the server graph uses top-level await
// (verified), and CJS sidesteps ESM-loader quirks with Fastify's dynamic plugin
// loading and with sandboxed preload scripts.
import { build } from "esbuild";
import { rmSync } from "node:fs";

// Native / optional-native modules that must NOT be bundled.
const external = [
  "electron",
  "better-sqlite3",
  "node-pty",
  "bufferutil",
  "utf-8-validate",
  "fsevents",
];

rmSync("out", { recursive: true, force: true });

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
  external,
  // @jarvis/jarvis-app's barrel re-exports `main.ts`, whose module-scope bin
  // guard (`if (import.meta.url === \`file://${process.argv[1]}\`)`) drags an
  // `import.meta` reference into the bundle. In CJS that evaluates to undefined,
  // so the guard is false and `main()` correctly never auto-runs on import —
  // exactly what we want when embedding. Silence the (benign) warning.
  logOverride: { "empty-import-meta": "silent" },
};

await build({
  ...common,
  entryPoints: ["src/main/index.ts"],
  outfile: "out/main/index.cjs",
});

await build({
  ...common,
  entryPoints: ["src/preload/index.ts"],
  outfile: "out/preload/index.cjs",
});

console.log("desktop bundle: out/main/index.cjs + out/preload/index.cjs");

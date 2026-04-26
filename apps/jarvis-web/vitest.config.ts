/// <reference types="vitest" />
// Vitest config — separate from `vite.config.ts` so the test runner
// doesn't carry the production `base: "/ui/"` and `outDir` settings
// (Vitest uses jsdom and never builds; those would just be noise).
//
// `setupFiles` extends `expect` with `@testing-library/jest-dom`'s
// matchers (`toBeInTheDocument()` etc.) and clears the Zustand store
// between tests so suites can't leak state into each other.

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});

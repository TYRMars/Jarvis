// Lean ESLint config — TypeScript + react-hooks. We don't run the
// full strict TypeScript ruleset because tsc -b already catches the
// type-level problems; ESLint is here for the things tsc can't see:
//
//   - `react-hooks/rules-of-hooks` — conditional hook calls
//   - `react-hooks/exhaustive-deps` — missing useEffect deps
//   - `@typescript-eslint/no-floating-promises` — fire-and-forget
//     async calls that swallow rejections
//   - `@typescript-eslint/no-unused-vars` (relaxed) — drop the
//     dead `import` lines we sometimes leave behind during refactors
//
// Type-aware rules need the project flag, so we set `parserOptions
// .project` to the same tsconfig the build uses.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "vite.config.ts", "vitest.config.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Use a dedicated `tsconfig.eslint.json` that includes test
        // files (the production `tsconfig.json` excludes them so
        // `tsc -b` stays scoped to shipping code). Without this
        // ESLint can't type-check the test files at all.
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-floating-promises": "error",
      // Allow `_unused` prefix for intentionally-unused params
      // (handler signatures, destructured discards).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The codebase carries a few `: any`s on protocol frames /
      // markdown renderer outputs that are genuinely untyped at the
      // edges. Warn instead of error so they surface but don't
      // block CI.
      "@typescript-eslint/no-explicit-any": "warn",
      // We use `await import(...)` for one dynamic-import case in
      // tests — keep this off rather than fight the rule.
      "@typescript-eslint/no-misused-promises": "warn",
      // Several markdown / WS frames go through `JSON.parse(...)`
      // and live as `any` until the next layer. Don't fight them.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    // Test files: relax `no-floating-promises` so `vi.fn()` chains
    // and `waitFor` don't trigger; relax unused-vars on
    // `_count`-style discards we already opt-in to.
    files: ["src/**/*.test.{ts,tsx}", "src/test/**/*"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);

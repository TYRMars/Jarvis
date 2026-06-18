// Flat ESLint config for the Node/TS rewrite workspace.
//
// The load-bearing rule here mirrors the Rust workspace's "library crates
// must never read std::env" discipline: library packages under packages/**
// must not read process.env — configuration is injected from the
// apps/jarvis composition root. See docs/proposals/nodejs-rewrite.zh-CN.md.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // The Node/TS rewrite lives under packages/** (and apps/** once ported).
    // Everything else in this repo is the Rust workspace, build output, or
    // legacy tooling — keep it out of the linter entirely.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "target/**",
      "crates/**",
      "apps/**",
      "clients/**",
      "examples/**",
      "scripts/**",
      "infra/**",
      "output/**",
      ".jarvis/**",
      ".claude/**",
      ".gitnexus/**",
      ".playwright-cli/**",
      ".playwright-mcp/**",
    ],
  },
  {
    files: ["packages/**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Library packages must not read process.env — wire config through the composition root.",
        },
      ],
    },
  },
  {
    // The composition roots are the SOLE place allowed to read process.env —
    // they parse env into config and inject it into the library packages
    // (mirrors the Rust rule that only apps/jarvis reads std::env).
    files: ["packages/jarvis-app/**/*.ts", "packages/jarvis-cli/**/*.ts"],
    rules: { "no-restricted-properties": "off" },
  },
);

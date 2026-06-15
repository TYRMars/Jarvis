// Flat ESLint config for the Node/TS rewrite workspace.
//
// The load-bearing rule here mirrors the Rust workspace's "library crates
// must never read std::env" discipline: library packages under packages/**
// must not read process.env — configuration is injected from the
// apps/jarvis composition root. See docs/proposals/nodejs-rewrite.zh-CN.md.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
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
            "Library packages must not read process.env — wire config through the apps/jarvis composition root.",
        },
      ],
    },
  },
);

# Rust → TypeScript type codegen — RETIRED

> **This convention has been retired.** The Rust `ts-rs` codegen that used to
> emit `apps/jarvis-web/src/types/generated/` was removed as a step toward
> decommissioning the Rust server. This file is kept as a tombstone so the old
> references resolve and nobody re-introduces the pattern.

## What changed

Wire-shape types crossing the SPA boundary are no longer generated from Rust.
The **single source of truth is the Node package
[`@jarvis/shared-types`](../../packages/shared-types/src/index.ts)** — a pure
type-only leaf (no runtime, no dependencies, a single file with no relative
imports so both the `NodeNext` and `Bundler` resolvers can consume it).

- The Node domain packages (`@jarvis/channel`, `@jarvis/workflow`) re-export the
  types from `@jarvis/shared-types` and keep their runtime constructors /
  validators.
- The standalone web SPA (`apps/jarvis-web`, still outside the pnpm workspace
  during the strangler migration) consumes it through a `tsconfig` `paths`
  alias + a matching `vite` `resolve.alias` pointing at the package source.
- The Rust structs in `harness-channel` / `harness-project` / `harness-workflow`
  no longer derive `ts_rs::TS`; they only need to serialise to the same JSON
  shape. Keep that shape in sync with `@jarvis/shared-types` **by hand** when you
  touch a wire type on either side.

## Migrating a wire type now

1. Edit the type in `packages/shared-types/src/index.ts`.
2. If the Node domain package exposed a runtime helper around it, update that in
   `@jarvis/channel` / `@jarvis/workflow`.
3. Mirror the change in the corresponding Rust struct's `serde` shape (until the
   Rust server is fully decommissioned).
4. `pnpm -r typecheck` + the web `npm run build` cover the TS side; `make lint`
   covers Rust.

## Scope today

`@jarvis/shared-types` currently hosts the types the SPA actually imports across
the boundary (channel + workflow). The web's other domain types are still
hand-written in `apps/jarvis-web/src/types/frames.ts`; consolidating those into
`@jarvis/shared-types` is a follow-up on the Rust-decommission path.

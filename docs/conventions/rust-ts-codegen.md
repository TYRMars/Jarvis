# Rust → TypeScript type codegen

Wire-shape types crossing the Rust ↔ TypeScript boundary are
**generated** from the Rust definitions using
[`ts-rs`](https://github.com/Aleph-Alpha/ts-rs). The frontend
imports the generated types from
`apps/jarvis-web/src/types/generated/`; hand-maintained equivalents
are a drift hazard — the codegen is the source of truth.

This file documents:
- The conventions for annotating a Rust type
- How to regenerate after a change
- How the generated files are committed + reviewed

## When to annotate

Annotate a type when **all three** apply:

1. The type appears on a JSON wire crossing into the SPA (REST
   reply / WS frame payload / `localStorage` shape).
2. The frontend ever names a TypeScript equivalent — `as ChannelInstance`,
   `interface RequirementSummary { … }`, etc.
3. The Rust definition is in `harness-channel`, `harness-project`,
   `harness-observability`, or another crate that already has
   `ts-rs` as a workspace dep. (`harness-core` deliberately stays
   out — wire-shape types should live in their domain crate, not
   the agent-loop trunk.)

If only (1) is true but the frontend never names the shape (e.g.
`fetch(...).then(r => r.json()).then((data: any) => data.foo)`),
skip it. Code paths that hand-extract fields don't benefit from a
generated type.

## Annotation pattern

```rust
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/jarvis-web/src/types/generated/")]
pub struct Project {
    pub id: String,
    pub slug: String,
    /// `None` when archived; `Some(Workspace { … })` otherwise.
    pub workspace: Option<ProjectWorkspace>,
}
```

Notes on each line:

- `#[derive(TS)]` — the codegen derive macro. Goes alongside `serde`.
  Pulls the derive from the workspace `ts-rs = "10"` dep added to
  the owning crate's `Cargo.toml`.
- `#[serde(rename_all = "snake_case")]` (or `kebab-case` etc.) — the
  derive **inspects** serde renames and emits the matching wire
  form on the TS side. Keep these in sync; mismatched casing is the
  most common bug.
- `#[ts(export, export_to = "…/types/generated/")]` — tells the
  derive to write a `<TypeName>.ts` to the given path during
  `cargo test`. The path is **relative to the source file the
  derive is on**, not the workspace root. From a
  `crates/harness-channel/src/instance.rs`, three `..` lands at
  the repo root → `apps/jarvis-web/src/types/generated/`.

### Common field-level overrides

`serde_json::Value` becomes `any` by default, which is rarely what
the frontend wants. Pick the narrowest TS type that covers the
runtime shape:

```rust
#[ts(type = "Record<string, unknown>")]
pub config: serde_json::Value,

#[ts(type = "string[]")]
pub tags: serde_json::Value,
```

Optional Rust types map to `T | null` by default. If the frontend
expects an undefined-style optional (the field can be omitted
entirely), add `#[ts(optional)]`:

```rust
#[serde(skip_serializing_if = "Option::is_none")]
#[ts(optional)]
pub note: Option<String>,
```

## Regenerating

The codegen runs as an embedded `#[test]` injected by the derive
macro. Every `cargo test` of an annotated crate writes the
corresponding `.ts` files.

```bash
# Whole workspace (covers everything):
cargo test --workspace --lib

# Just the channel-domain types:
cargo test -p harness-channel

# Just the project-domain types:
cargo test -p harness-project
```

`make ts-codegen` (in the root `Makefile`) is the canonical one-shot
target — wraps the above with no test output noise.

## Committing the generated files

The `apps/jarvis-web/src/types/generated/` directory **is** in git.
Reasoning:

- CI doesn't have a Rust toolchain on the SPA-only build step. If
  the frontend imports from `types/generated/`, those files must
  exist on disk at build time. Generating during the SPA build
  would tie Vite to `cargo`, which complicates Tauri / Docker
  setups.
- Drift is much easier to see in code review when the diff shows
  the regenerated TS alongside the Rust change. A PR that touches
  `Project` in Rust without a matching `Project.ts` diff is the
  signal "you forgot to regenerate."

Workflow: change a `#[derive(TS)]` type → run `cargo test -p
<owning-crate>` → `git add apps/jarvis-web/src/types/generated/` →
commit both in the same PR.

## Consuming from the frontend

Re-export from the matching `services/*.ts` file so the rest of the
SPA doesn't have to know which type is generated vs hand-written:

```typescript
// services/channels.ts
import type { ChannelInstance as GeneratedChannelInstance } from "../types/generated/ChannelInstance";
import type { ChannelInstanceStatus } from "../types/generated/ChannelInstanceStatus";

// Re-export under the conventional name so existing imports stay
// stable. `ChannelStatus` is a legacy alias for the same enum.
export type ChannelStatus = ChannelInstanceStatus;
export type ChannelInstance = GeneratedChannelInstance;
```

Components import from the service layer (`import { ChannelInstance }
from "@/services/channels"`), not from `types/generated/` directly.
That insulation lets us swap a generated type for a richer
hand-extended one if the SPA needs a field the Rust shape doesn't
carry.

## Anti-patterns

- **Don't edit a file under `types/generated/`.** It'll be
  overwritten on the next `cargo test`. If the type needs a hand-
  written field, extend it in the service layer (intersection or
  spread).
- **Don't annotate types in `harness-core`.** That crate is the
  agent-loop trunk; wire-shape types belong in their domain crate
  (channel / project / observability). If a wire-shape type is
  in `harness-core` today, that's a smell — extract it first.
- **Don't omit `serde(rename_all = …)`.** Without it, an enum like
  `RequirementStatus::InProgress` round-trips through JSON as
  `"InProgress"` but ts-rs emits `"in_progress"`. The runtime
  shape and the TS type disagree, and the SPA's narrow checks
  silently fail.
- **Don't annotate types with `Vec<Box<dyn Trait>>` fields.**
  ts-rs can't reflect on trait objects. Either pull out the
  concrete enum / struct, or skip codegen and write the TS by
  hand for that single type.

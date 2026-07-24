// @jarvis/shared-types — wire-shape types crossing the SPA boundary.
//
// The single source of truth that replaces the Rust `ts_rs` codegen (formerly
// emitted into apps/jarvis-web/src/types/generated/). A pure type-only leaf:
// zero runtime, zero dependencies, and — deliberately — a SINGLE file with no
// relative imports. That keeps it consumable by both resolvers in play: the
// Node packages on `NodeNext` (which require `.ts` import extensions) and the
// standalone web SPA on `Bundler` (which rejects them). The web pulls this in
// via a path alias since it lives outside the pnpm workspace during the
// strangler migration.
//
// The Node domain packages (@jarvis/channel, @jarvis/workflow) re-export these
// types and keep the runtime constructors / validators. Field names,
// snake_case, and optionality are preserved EXACTLY so the JSON wire shape is
// unchanged — Rust `skip_serializing_if` fields are optional (`?`) and simply
// absent when default.
//
// Scope today: the types the SPA actually imports across the boundary
// (channel + workflow). The web's other domain types are still hand-written in
// apps/jarvis-web/src/types/frames.ts; consolidating those here is a follow-up.

// ==========================================================================
// Channel
// ==========================================================================

/**
 * User-driven enabled/disabled/unconfigured state. Distinct from "did the last
 * send succeed". `"unconfigured"` is set by handlers when required fields are
 * missing; it is also the default on a fresh instance. Serialised snake_case.
 */
export type ChannelInstanceStatus = "enabled" | "disabled" | "unconfigured";

/**
 * Wire format of an outbound message body. Adapters that don't support a
 * particular format fall back to `"text"`. Serialised snake_case; default
 * `"text"`.
 */
export type ChannelMessageFormat = "text" | "markdown";

/**
 * One configured channel — e.g. a WeCom group robot, a WeChat MP callback
 * target, a Feishu bot. Instances are user-named (`display_name`) because a
 * deployment may host several of the same `kind`.
 *
 * `config` is an opaque JSON object so each kind owns its own schema without
 * baking variant-specific fields into the shared surface. It may embed
 * `${env:NAME}` template strings — resolved at send-time, never at store-time.
 * (Rust stores `serde_json::Value` but annotates the wire type as
 * `Record<string, unknown>`; we keep that representation so the leaf stays
 * dependency-free.)
 */
export interface ChannelInstance {
  /** Stable UUID. Frontend keys list rows by this. */
  id: string;
  /** Discriminator: `"wecom_webhook"` / `"wechat_mp"` / `"feishu_bot"` / … */
  kind: string;
  /** User-set human-readable name (e.g. "prod-alerts"). */
  display_name: string;
  status: ChannelInstanceStatus;
  /** Kind-specific config payload (an opaque JSON object). */
  config: Record<string, unknown>;
  /** RFC-3339 timestamp set on insert. */
  created_at: string;
  /** RFC-3339 timestamp bumped on every upsert. */
  updated_at: string;
}

// ==========================================================================
// Workflow
// ==========================================================================

/**
 * The executable shape of a {@link WorkflowStep}. In the Rust source this is an
 * externally-tagged enum on `type`, so the wire form is a discriminated union
 * the SPA can switch on: `{"type":"agent",…}` / `{"type":"pipeline",…}` / etc.
 *
 * Recursive: `pipeline` / `phase` / `parallel` nest further steps.
 */
export type WorkflowStepKind =
  | {
      type: "agent";
      /**
       * Step instruction. Supports `{{ prev }}` (previous step output) and
       * `{{ outputs.<key> }}` (any prior step's `output_key`).
       */
      prompt: string;
      /**
       * Optional `subagent.<name>` to delegate to. Absent runs the main
       * agent loop.
       */
      subagent?: string;
      /** Optional per-step model override (else the run's default). */
      model?: string;
      /**
       * Optional name to record this step's output under, so later steps can
       * interpolate `{{ outputs.<key> }}`.
       */
      output_key?: string;
    }
  | {
      type: "pipeline";
      /** Children run in order; each child's output threads forward. */
      steps: WorkflowStep[];
    }
  | {
      type: "phase";
      /** Phase title (progress marker). */
      title: string;
      /** Sequential children. */
      steps: WorkflowStep[];
    }
  | {
      type: "parallel";
      /** Children run in parallel. */
      steps: WorkflowStep[];
      /** Failure handling; defaults to `all_required`. */
      join: JoinPolicy;
    };

/** How a `parallel` group treats child failures. Serialised snake_case. */
export type JoinPolicy = "all_required" | "best_effort";

/**
 * One node in a {@link WorkflowDefinition}. Carries presentation metadata
 * (`id`, `name`) plus the executable {@link WorkflowStepKind}.
 */
export interface WorkflowStep {
  /**
   * Stable id within the definition (UUID v4). Referenced by
   * {@link WorkflowStepResult.step_id}.
   */
  id: string;
  /** Short label for the step. */
  name: string;
  /** What the step actually does. */
  kind: WorkflowStepKind;
}

/**
 * A reusable, multi-step agent recipe.
 *
 * Optional fields use `skip_serializing_if` in Rust, so here they are optional
 * (`?`) and simply absent when default — older rows on disk keep deserialising.
 */
export interface WorkflowDefinition {
  /** Stable identifier (UUID v4 string), server-allocated. */
  id: string;
  /**
   * Optional Project scope. Absent = a global workflow not tied to a single
   * project.
   */
  project_id?: string;
  /** Human label shown in catalogues and pickers. */
  name: string;
  /** Optional longer description of what the recipe does. */
  description?: string;
  /**
   * Ordered top-level steps. Executed in sequence; nested `parallel`
   * introduces concurrency.
   */
  steps: WorkflowStep[];
  /** RFC-3339 / ISO-8601 timestamp of creation. */
  created_at: string;
  /** RFC-3339 timestamp; bumped on every mutation. */
  updated_at: string;
}

/**
 * Lifecycle of a {@link WorkflowRun} (and the terminal state of a
 * {@link WorkflowStepResult}). Serialised snake_case.
 */
export type WorkflowRunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

/**
 * Result of executing one leaf {@link WorkflowStep} within a
 * {@link WorkflowRun}.
 */
export interface WorkflowStepResult {
  /** The {@link WorkflowStep.id} this result corresponds to. */
  step_id: string;
  /** Step label, denormalised so a client can render without the definition. */
  name: string;
  /** Terminal state of the step. */
  status: WorkflowRunStatus;
  /**
   * Conversation that drove the step (for drill-down). Absent for steps that
   * never reached the agent loop.
   */
  conversation_id?: string;
  /**
   * Final assistant text — also the handoff value for `{{ prev }}` /
   * `{{ outputs.<key> }}`.
   */
  output?: string;
  /** Error string if the step failed. */
  error?: string;
}

/**
 * One execution attempt against a {@link WorkflowDefinition}, one
 * {@link WorkflowStepResult} per leaf step executed.
 */
export interface WorkflowRun {
  /** Stable identifier (UUID v4). */
  id: string;
  /** The definition this run executed. */
  workflow_id: string;
  /**
   * Optional Requirement this run was bound to. Absent for ad-hoc runs not
   * tied to a kanban card.
   */
  requirement_id?: string;
  /** Lifecycle state. */
  status: WorkflowRunStatus;
  /** Per-step results in execution order. */
  step_results: WorkflowStepResult[];
  /** Free-form error string when the run failed before / between steps. */
  error?: string;
  /** RFC-3339 timestamp of run creation. */
  started_at: string;
  /** RFC-3339 timestamp of completion. Absent while in flight. */
  finished_at?: string;
}

// ==========================================================================
// Remote access + DDNS
// ==========================================================================
//
// Wire shapes for the native mobile client: connect to the home server over
// LAN / external origin, and configure the machine's dynamic-DNS so it stays
// reachable from outside. Back `/v1/ddns/*` + `/v1/remote/info`. The iOS app's
// Codable models mirror these EXACTLY (snake_case, optionality).

/** Pluggable DDNS backend. */
export type DdnsProviderKind = "cloudflare" | "duckdns" | "dyndns2" | "aliyun" | "dnspod";

/**
 * `PUT /v1/ddns/config` body — the full config INCLUDING secrets. Credentials
 * are flat string keys; the expected keys per provider:
 *  - `cloudflare`: `api_token` (+ optional `zone_id` / `zone`)
 *  - `duckdns`:    `token`
 *  - `dyndns2`:    `username`, `password` (+ optional `server`)
 *  - `aliyun`:     `access_key_id`, `access_key_secret` (+ optional `domain`)
 *  - `dnspod`:     `id`, `token` (+ optional `domain`)
 */
export interface DdnsConfigInput {
  provider: DdnsProviderKind;
  /** Fully-qualified hostname to keep pointed at this machine (e.g. `home.example.com`, `foo.duckdns.org`). */
  hostname: string;
  /** Public service port to advertise / map (the port the server listens on). */
  port: number;
  /** DNS record type. Default `"A"` (IPv4). */
  record_type?: "A" | "AAAA";
  /** Re-check / re-update cadence in seconds. Default 300. */
  interval_seconds?: number;
  /** Attempt UPnP/NAT-PMP automatic port-forwarding. Default false. */
  upnp_enabled?: boolean;
  /** Provider credentials as flat string keys (see interface doc). */
  credentials: Record<string, string>;
}

/** `GET /v1/ddns/config` — SCRUBBED view (never returns secret values). */
export interface DdnsConfigView {
  provider: DdnsProviderKind;
  hostname: string;
  port: number;
  record_type: "A" | "AAAA";
  interval_seconds: number;
  upnp_enabled: boolean;
  /** Which credential keys are set (names only — never values). */
  credential_keys: string[];
}

/** UPnP/NAT port-mapping state. */
export interface DdnsUpnpStatus {
  /** Whether a mapping is currently believed active. */
  mapped: boolean;
  external_port?: number;
  internal_port?: number;
  /** Gateway-reported external IP, if discovered. */
  gateway_external_ip?: string;
  /** Human-readable detail / failure reason (the manual-forward hint on failure). */
  message?: string;
}

/** `GET /v1/ddns/status` — live runtime snapshot. */
export interface DdnsStatus {
  enabled: boolean;
  configured: boolean;
  provider?: DdnsProviderKind;
  hostname?: string;
  /** Last detected public IPv4. */
  public_ip?: string;
  /** RFC-3339 timestamp of the last successful provider update. */
  last_update?: string;
  /** Outcome of the most recent update attempt. */
  last_result?: { ok: boolean; message: string };
  /** UPnP mapping state (absent when upnp disabled). */
  upnp?: DdnsUpnpStatus;
  /** Whether the external origin answered a reachability probe (`null` = unknown / not probed). */
  reachable?: boolean | null;
  /** This machine's LAN IPv4 addresses (for the connect screen). */
  lan_addrs: string[];
}

/** `GET /v1/remote/info` — what the native client shows on connect. */
export interface RemoteInfo {
  device_name: string;
  /** This machine's LAN IPv4 addresses. */
  lan_addrs: string[];
  /** Server listen port. */
  port: number;
  external: {
    hostname?: string;
    public_ip?: string;
    reachable?: boolean | null;
  };
  /** Whether non-loopback callers must present a bearer token. */
  requires_auth: boolean;
  /** Server version string. */
  version?: string;
}

// Settings → Channels page (M1 + M2).
//
// Lists user-configured channel instances (currently WeCom group
// robots; M3 will add WeChat MP, then Feishu / DingTalk). Each row
// has Test / Edit / Pause / Delete actions. "Add channel" opens an
// inline form whose fields are derived from the kind catalogue's
// JSON Schema, so adding a kind on the backend auto-surfaces here
// without a frontend change.
//
// Credential handling: configs may use `${env:NAME}` templates. The
// server resolves them at send time (not at save time) so rotating
// an env var doesn't require a UI roundtrip. The form leaves the
// templates verbatim — no special handling needed.

import { useEffect, useMemo, useState } from "react";
import { Section } from "./Section";
import { t } from "../../../utils/i18n";
import {
  createChannel,
  deleteChannel,
  listChannelKinds,
  listChannels,
  patchChannel,
  testChannel,
  type ChannelInstance,
  type ChannelKind,
  type ChannelStatus,
} from "../../../services/channels";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

interface SectionState {
  loading: boolean;
  error: string | null;
  unconfigured: boolean;
  instances: ChannelInstance[];
  kinds: ChannelKind[];
}

const INITIAL_STATE: SectionState = {
  loading: true,
  error: null,
  unconfigured: false,
  instances: [],
  kinds: [],
};

export function ChannelsSection({ embedded }: { embedded?: boolean } = {}) {
  const [state, setState] = useState<SectionState>(INITIAL_STATE);
  const [adding, setAdding] = useState<{ kind: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [transientMessage, setTransientMessage] = useState<{
    text: string;
    tone: "ok" | "err";
  } | null>(null);

  const refresh = useMemo(
    () => async () => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const [instances, kinds] = await Promise.all([
          listChannels(),
          listChannelKinds(),
        ]);
        if (instances === null || kinds === null) {
          setState({
            loading: false,
            error: null,
            unconfigured: true,
            instances: [],
            kinds: [],
          });
          return;
        }
        setState({
          loading: false,
          error: null,
          unconfigured: false,
          instances,
          kinds,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setState({
          loading: false,
          error: msg,
          unconfigured: false,
          instances: [],
          kinds: [],
        });
      }
    },
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const flash = (text: string, tone: "ok" | "err") => {
    setTransientMessage({ text, tone });
    window.setTimeout(() => setTransientMessage(null), 4000);
  };

  return (
    <Section
      id="channels"
      titleKey="settingsNavChannels"
      titleFallback="Channels"
      descKey="channelsSectionDesc"
      descFallback="Hook Jarvis up to messaging platforms (WeCom, WeChat MP, Feishu, …). Outbound-only kinds (e.g. WeCom group robot) deliver alerts; inbound kinds map external chats to conversations."
      embedded={embedded}
    >
      {state.loading && (
        <p className="settings-section-desc">{tx("channelsLoading", "Loading channels…")}</p>
      )}
      {state.unconfigured && (
        <div className="settings-empty">
          {tx(
            "channelsUnconfigured",
            "Channel store unavailable — set JARVIS_DB_URL or use the default JSON-file persistence.",
          )}
        </div>
      )}
      {state.error && (
        <div className="settings-error">
          {tx("channelsLoadFailed", "Load failed: ")}
          {state.error}
          <button type="button" className="settings-btn" onClick={() => void refresh()}>
            {tx("retry", "Retry")}
          </button>
        </div>
      )}

      {!state.loading && !state.unconfigured && !state.error && (
        <>
          <div className="channels-toolbar">
            <KindPicker
              kinds={state.kinds}
              onPick={(kind) => setAdding({ kind })}
            />
            <button
              type="button"
              className="settings-btn"
              onClick={() => void refresh()}
            >
              {tx("refresh", "Refresh")}
            </button>
          </div>

          {transientMessage && (
            <div className={"channels-flash tone-" + transientMessage.tone}>
              {transientMessage.text}
            </div>
          )}

          {adding && (
            <ChannelForm
              kinds={state.kinds}
              kind={adding.kind}
              onCancel={() => setAdding(null)}
              onSubmit={async (input) => {
                try {
                  await createChannel(input);
                  setAdding(null);
                  flash(tx("channelsCreated", "Channel created."), "ok");
                  void refresh();
                } catch (e: unknown) {
                  const msg = e instanceof Error ? e.message : String(e);
                  flash(msg, "err");
                }
              }}
            />
          )}

          {state.instances.length === 0 && !adding && (
            <p className="settings-section-desc">
              {tx(
                "channelsEmpty",
                "No channels yet. Click 添加渠道 / Add channel to wire up your first WeCom group robot.",
              )}
            </p>
          )}

          <ul className="channels-list">
            {state.instances.map((inst) => (
              <ChannelRow
                key={inst.id}
                inst={inst}
                kindMeta={state.kinds.find((k) => k.kind === inst.kind) ?? null}
                editing={editing === inst.id}
                onStartEdit={() => setEditing(inst.id)}
                onCancelEdit={() => setEditing(null)}
                onPatched={(updated) => {
                  setState((s) => ({
                    ...s,
                    instances: s.instances.map((i) =>
                      i.id === updated.id ? updated : i,
                    ),
                  }));
                  setEditing(null);
                  flash(tx("channelsSaved", "Saved."), "ok");
                }}
                onDeleted={() => {
                  setState((s) => ({
                    ...s,
                    instances: s.instances.filter((i) => i.id !== inst.id),
                  }));
                  flash(tx("channelsDeleted", "Deleted."), "ok");
                }}
                onTested={(result) => {
                  flash(
                    result.ok
                      ? tx("channelsTestOk", "Test message sent.")
                      : `${tx("channelsTestFailed", "Test failed: ")}${result.error ?? "?"}`,
                    result.ok ? "ok" : "err",
                  );
                }}
              />
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function KindPicker({
  kinds,
  onPick,
}: {
  kinds: ChannelKind[];
  onPick: (kind: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="channels-kind-picker">
      <button
        type="button"
        className="settings-btn primary"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        + {tx("channelsAdd", "Add channel")}
      </button>
      {open && (
        <div className="channels-kind-menu" role="menu">
          {kinds.map((k) => (
            <button
              key={k.kind}
              type="button"
              className="channels-kind-menu-item"
              role="menuitem"
              onClick={() => {
                onPick(k.kind);
                setOpen(false);
              }}
            >
              <strong>{k.label}</strong>
              <span>{k.description}</span>
            </button>
          ))}
          {kinds.length === 0 && (
            <span className="settings-section-desc">
              {tx("channelsNoKinds", "No channel kinds available.")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ChannelRow({
  inst,
  kindMeta,
  editing,
  onStartEdit,
  onCancelEdit,
  onPatched,
  onDeleted,
  onTested,
}: {
  inst: ChannelInstance;
  kindMeta: ChannelKind | null;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onPatched: (updated: ChannelInstance) => void;
  onDeleted: () => void;
  onTested: (result: { ok: boolean; error?: string }) => void;
}) {
  const [pending, setPending] = useState(false);

  const togglePause = async () => {
    setPending(true);
    try {
      const next: ChannelStatus =
        inst.status === "enabled" ? "disabled" : "enabled";
      const updated = await patchChannel(inst.id, { status: next });
      onPatched(updated);
    } finally {
      setPending(false);
    }
  };

  const onDelete = async () => {
    const confirmed = window.confirm(
      tx("channelsDeleteConfirm", "Delete this channel?") +
        ` (${inst.display_name})`,
    );
    if (!confirmed) return;
    setPending(true);
    try {
      const ok = await deleteChannel(inst.id);
      if (ok) onDeleted();
    } finally {
      setPending(false);
    }
  };

  const onTest = async () => {
    setPending(true);
    try {
      const r = await testChannel(inst.id);
      onTested(r);
    } finally {
      setPending(false);
    }
  };

  if (editing && kindMeta) {
    return (
      <li className={"channels-row status-" + inst.status}>
        <ChannelForm
          kinds={[kindMeta]}
          kind={inst.kind}
          existing={inst}
          onCancel={onCancelEdit}
          onSubmit={async (input) => {
            const updated = await patchChannel(inst.id, {
              display_name: input.display_name,
              config: input.config,
            });
            onPatched(updated);
          }}
        />
      </li>
    );
  }

  return (
    <li className={"channels-row status-" + inst.status}>
      <div className="channels-row-head">
        <span className="channels-row-name">{inst.display_name}</span>
        <span className={"channels-status-pill tone-" + inst.status}>
          {statusLabel(inst.status)}
        </span>
        <span className="channels-row-kind">
          {kindMeta?.label ?? inst.kind}
        </span>
      </div>
      <div className="channels-row-summary">{summariseConfig(inst)}</div>
      <div className="channels-row-actions">
        {kindMeta?.test_supported && (
          <button
            type="button"
            className="settings-btn"
            disabled={pending || inst.status === "disabled"}
            onClick={() => void onTest()}
          >
            {tx("channelsTest", "Test")}
          </button>
        )}
        <button
          type="button"
          className="settings-btn"
          disabled={pending}
          onClick={onStartEdit}
        >
          {tx("channelsEdit", "Edit")}
        </button>
        <button
          type="button"
          className="settings-btn"
          disabled={pending || inst.status === "unconfigured"}
          onClick={() => void togglePause()}
        >
          {inst.status === "enabled"
            ? tx("channelsPause", "Pause")
            : tx("channelsResume", "Resume")}
        </button>
        <button
          type="button"
          className="settings-btn danger"
          disabled={pending}
          onClick={() => void onDelete()}
        >
          {tx("channelsDelete", "Delete")}
        </button>
      </div>
    </li>
  );
}

/// Render `required` fields first (in their declared array order),
/// then the optional ones alphabetically. Server-side `serde_json`
/// returns object properties in alphabetical order without the
/// `preserve_order` feature, so without this the most-important
/// field (e.g. `webhook_url`) can sink below an optional one (e.g.
/// `default_mention`).
function orderedSchemaProps(
  schema: ChannelKind["schema"],
): Array<[string, ChannelKind["schema"]["properties"][string]]> {
  const required = new Set(schema.required ?? []);
  const requiredOrder = schema.required ?? [];
  const optional = Object.keys(schema.properties).filter((k) => !required.has(k));
  optional.sort();
  return [...requiredOrder, ...optional]
    .filter((k) => k in schema.properties)
    .map((k) => [k, schema.properties[k]] as const);
}

function statusLabel(s: ChannelStatus): string {
  if (s === "enabled") return tx("channelsStatusEnabled", "Enabled");
  if (s === "disabled") return tx("channelsStatusDisabled", "Paused");
  return tx("channelsStatusUnconfigured", "Needs config");
}

/// One-line digest of the row's config — masked per known field so
/// secrets never render in full.
function summariseConfig(inst: ChannelInstance): string {
  if (inst.kind === "wecom_webhook") {
    const url = (inst.config?.["webhook_url"] as string | undefined) ?? "";
    return tx("channelsSummaryWeComUrl", "Webhook: ") + maskUrl(url);
  }
  return JSON.stringify(inst.config).slice(0, 80);
}

function maskUrl(url: string): string {
  if (!url) return "(empty)";
  if (url.includes("${env:")) return url; // template — show verbatim, it's not a secret
  // Strip query string to avoid leaking webhook keys in the row preview.
  const qmark = url.indexOf("?");
  return qmark >= 0 ? url.slice(0, qmark) + "?…" : url;
}

interface ChannelFormInput {
  kind: string;
  display_name: string;
  config: Record<string, unknown>;
}

function ChannelForm({
  kinds,
  kind,
  existing,
  onCancel,
  onSubmit,
}: {
  kinds: ChannelKind[];
  kind: string;
  existing?: ChannelInstance;
  onCancel: () => void;
  onSubmit: (input: ChannelFormInput) => Promise<void>;
}) {
  const meta = kinds.find((k) => k.kind === kind);
  const [displayName, setDisplayName] = useState(existing?.display_name ?? "");
  const [config, setConfig] = useState<Record<string, unknown>>(
    existing?.config ?? {},
  );
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!meta) {
    return <div className="settings-error">Unknown kind: {kind}</div>;
  }

  const onSubmitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    try {
      await onSubmit({
        kind,
        display_name: displayName.trim(),
        config,
      });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="channels-form" onSubmit={(e) => void onSubmitForm(e)}>
      <div className="channels-form-head">
        <strong>{meta.label}</strong>
        <span className="settings-section-desc">{meta.description}</span>
      </div>
      <label className="channels-form-field">
        <span>{tx("channelsFieldDisplayName", "Display name")}</span>
        <input
          type="text"
          required
          maxLength={64}
          placeholder="prod-alerts"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="settings-input"
        />
      </label>
      {orderedSchemaProps(meta.schema).map(([key, spec]) => (
        <label key={key} className="channels-form-field">
          <span>{spec.title ?? key}</span>
          {spec.type === "array" ? (
            <input
              type="text"
              placeholder="@all,user_id_1"
              value={
                Array.isArray(config[key])
                  ? (config[key] as string[]).join(",")
                  : ""
              }
              onChange={(e) =>
                setConfig({
                  ...config,
                  [key]: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              className="settings-input"
            />
          ) : (
            <input
              type={key.toLowerCase().includes("password") ? "password" : "text"}
              placeholder={spec.example ?? ""}
              required={meta.schema.required?.includes(key) ?? false}
              value={(config[key] as string) ?? ""}
              onChange={(e) =>
                setConfig({ ...config, [key]: e.target.value })
              }
              className="settings-input"
            />
          )}
          {spec.description && (
            <span className="channels-form-hint">{spec.description}</span>
          )}
        </label>
      ))}
      {err && <div className="settings-error">{err}</div>}
      <div className="channels-form-actions">
        <button type="button" className="settings-btn" onClick={onCancel}>
          {tx("cancel", "Cancel")}
        </button>
        <button
          type="submit"
          className="settings-btn primary"
          disabled={submitting}
        >
          {existing
            ? tx("channelsSave", "Save")
            : tx("channelsCreateNow", "Create")}
        </button>
      </div>
    </form>
  );
}

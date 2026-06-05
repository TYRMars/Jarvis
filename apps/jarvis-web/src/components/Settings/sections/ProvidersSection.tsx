// Settings → Providers — full add / edit / delete / set-default
// surface. Everything `jarvis init` / `jarvis login` / config-file
// editing exposed from the CLI now also has a UI here.
//
// Reads from `appStore.providers` for the live registry; writes via
// `services/providerAdmin.ts` (POST/PATCH/DELETE/PUT default). On
// mutation the server broadcasts `providers_changed`; the WS frame
// handler refetches `/v1/providers` via `loadProviders`, which
// updates `appStore.providers` and re-renders this section.

import { useEffect, useState } from "react";
import { useAppStore } from "../../../store/appStore";
import {
  createProvider,
  deleteProvider,
  getProvider,
  probeProvider,
  setDefaultProvider,
  updateProvider,
  type ProbeResult,
  type ProviderDef,
  type ProviderSnapshot,
} from "../../../services/providerAdmin";
import type { ProviderInfo } from "../../../store/types";
import { Section } from "./Section";
import { t } from "../../../utils/i18n";
import { confirm, Modal, Select } from "../../ui";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

interface KindOption {
  value: string;
  labelKey: string;
  labelFallback: string;
  hintKey: string;
  hintFallback: string;
}

const KIND_OPTIONS: ReadonlyArray<KindOption> = [
  {
    value: "openai",
    labelKey: "settingsProvidersKindOpenaiLabel",
    labelFallback: "OpenAI / OpenAI-compatible",
    hintKey: "settingsProvidersKindOpenaiHint",
    hintFallback:
      "Chat-completions API. Set base_url to point at Ollama, OpenRouter, Together, etc.",
  },
  {
    value: "openai-responses",
    labelKey: "settingsProvidersKindOpenaiResponsesLabel",
    labelFallback: "OpenAI (Responses)",
    hintKey: "settingsProvidersKindOpenaiResponsesHint",
    hintFallback: "Reasoning models (o1/o3/gpt-5). Same key as openai.",
  },
  {
    value: "anthropic",
    labelKey: "settingsProvidersKindAnthropicLabel",
    labelFallback: "Anthropic",
    hintKey: "settingsProvidersKindAnthropicHint",
    hintFallback:
      "Claude (claude-3-5-sonnet, etc.). Sends `x-api-key` + `anthropic-version`.",
  },
  {
    value: "google",
    labelKey: "settingsProvidersKindGoogleLabel",
    labelFallback: "Google Gemini",
    hintKey: "settingsProvidersKindGoogleHint",
    hintFallback: "GOOGLE_API_KEY or GEMINI_API_KEY.",
  },
  {
    value: "openrouter",
    labelKey: "settingsProvidersKindOpenrouterLabel",
    labelFallback: "OpenRouter",
    hintKey: "settingsProvidersKindOpenrouterHint",
    hintFallback:
      "Multi-model router. Requests travel through a third party — see privacy hint.",
  },
  {
    value: "kimi",
    labelKey: "settingsProvidersKindKimiLabel",
    labelFallback: "Kimi (Moonshot)",
    hintKey: "settingsProvidersKindKimiHint",
    hintFallback: "MOONSHOT_API_KEY / KIMI_API_KEY. Default base: api.moonshot.cn/v1.",
  },
  {
    value: "kimi-code",
    labelKey: "settingsProvidersKindKimiCodeLabel",
    labelFallback: "Kimi Code",
    hintKey: "settingsProvidersKindKimiCodeHint",
    hintFallback: "Kimi's coding endpoint with empty reasoning_content compat.",
  },
  {
    value: "nvidia-nim",
    labelKey: "settingsProvidersKindNimLabel",
    labelFallback: "NVIDIA NIM",
    hintKey: "settingsProvidersKindNimHint",
    hintFallback:
      "Enterprise / self-hosted NIM endpoint. Verify base URL against your tenant before relying on the default.",
  },
  {
    value: "nous",
    labelKey: "settingsProvidersKindNousLabel",
    labelFallback: "Nous Portal",
    hintKey: "settingsProvidersKindNousHint",
    hintFallback: "Hermes & Nous-research models. Verify base URL before use.",
  },
  {
    value: "minimax",
    labelKey: "settingsProvidersKindMinimaxLabel",
    labelFallback: "MiniMax",
    hintKey: "settingsProvidersKindMinimaxHint",
    hintFallback: "Chinese OpenAI-compatible endpoint. Verify base URL before use.",
  },
  {
    value: "mimo",
    labelKey: "settingsProvidersKindMimoLabel",
    labelFallback: "Xiaomi MiMo",
    hintKey: "settingsProvidersKindMimoHint",
    hintFallback: "Xiaomi's MiMo endpoint. Verify base URL before use.",
  },
  {
    value: "huggingface",
    labelKey: "settingsProvidersKindHfLabel",
    labelFallback: "Hugging Face Inference",
    hintKey: "settingsProvidersKindHfHint",
    hintFallback: "Serverless or dedicated endpoint via api-inference.huggingface.co.",
  },
  {
    value: "ollama",
    labelKey: "settingsProvidersKindOllamaLabel",
    labelFallback: "Ollama (local)",
    hintKey: "settingsProvidersKindOllamaHint",
    hintFallback: "No api key needed for the local server (default localhost:11434).",
  },
  {
    value: "lmstudio",
    labelKey: "settingsProvidersKindLmstudioLabel",
    labelFallback: "LM Studio (local)",
    hintKey: "settingsProvidersKindLmstudioHint",
    hintFallback: "Local desktop app exposing an OpenAI-compatible endpoint on :1234.",
  },
  {
    value: "codex",
    labelKey: "settingsProvidersKindCodexLabel",
    labelFallback: "Codex (ChatGPT OAuth)",
    hintKey: "settingsProvidersKindCodexHint",
    hintFallback:
      "Use `jarvis login --provider codex` from the CLI to set up auth — the OAuth flow isn't wired into the Web UI yet.",
  },
];

// Per-kind smart defaults. Only used to prefill *empty* fields when
// the user picks a kind — typed input is never overwritten.
const KIND_DEFAULTS: Record<string, { default_model?: string; base_url?: string }> = {
  openai: { default_model: "gpt-4o-mini" },
  "openai-responses": { default_model: "gpt-5-mini" },
  anthropic: { default_model: "claude-3-5-sonnet-latest" },
  google: { default_model: "gemini-1.5-flash" },
  openrouter: {
    default_model: "anthropic/claude-sonnet-4.5",
    base_url: "https://openrouter.ai/api/v1",
  },
  kimi: { default_model: "kimi-k2-thinking", base_url: "https://api.moonshot.cn/v1" },
  "kimi-code": {
    default_model: "kimi-k2-thinking",
    base_url: "https://api.moonshot.cn/v1",
  },
  "nvidia-nim": {
    default_model: "meta/llama-3.3-70b-instruct",
    base_url: "https://integrate.api.nvidia.com/v1",
  },
  nous: {
    default_model: "hermes-4",
    base_url: "https://inference-api.nousresearch.com/v1",
  },
  minimax: { default_model: "abab6.5", base_url: "https://api.minimax.chat/v1" },
  mimo: { default_model: "mimo-7b-rl", base_url: "https://mimo.xiaomi.com/v1" },
  huggingface: {
    default_model: "meta-llama/Llama-3.3-70B-Instruct",
    base_url: "https://api-inference.huggingface.co/v1",
  },
  ollama: { default_model: "llama3", base_url: "http://localhost:11434/v1" },
  lmstudio: { default_model: "openai/gpt-oss-20b", base_url: "http://localhost:1234/v1" },
  codex: { default_model: "gpt-5-mini" },
};

export function ProvidersSection({ embedded }: { embedded?: boolean } = {}) {
  const providers = useAppStore((s) => s.providers);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // provider name
  const [creating, setCreating] = useState(false);
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // op name

  return (
    <Section
      id="providers"
      titleKey="settingsProvidersTitle"
      titleFallback="Providers"
      descKey="settingsProvidersEditableDesc"
      descFallback="Add, edit, delete, or pick a default. Changes apply immediately and persist to ~/.config/jarvis/config.json. API keys land in ~/.config/jarvis/auth/<name>.json (chmod 0600). Codex's OAuth flow still needs `jarvis login --provider codex` from the CLI."
      embedded={embedded}
    >
      {error ? (
        <div className="settings-inline-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="provider-toolbar">
        <button
          type="button"
          className="agent-profile-create-btn"
          onClick={() => {
            setCreating(true);
            setEditing(null);
            setError(null);
          }}
        >
          {tx("settingsProvidersAdd", "Add provider")}
        </button>
      </div>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        busy={creatingBusy}
        title={tx("settingsProvidersAdd", "Add provider")}
        size="lg"
      >
        {creating ? (
          <ProviderForm
            mode="create"
            inModal
            onBusyChange={setCreatingBusy}
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              setError(null);
            }}
            onError={setError}
          />
        ) : null}
      </Modal>

      {providers.length === 0 ? (
        <p className="settings-empty">
          {tx(
            "settingsProvidersEmpty",
            "No providers configured. Add one above to get started.",
          )}
        </p>
      ) : (
        <ul className="settings-providers">
          {providers.map((p) => (
            <li key={p.name} className="settings-provider">
              {editing === p.name ? (
                <ProviderForm
                  mode="edit"
                  initialName={p.name}
                  onCancel={() => setEditing(null)}
                  onSaved={() => {
                    setEditing(null);
                    setError(null);
                  }}
                  onError={setError}
                />
              ) : (
                <ProviderRow
                  info={p}
                  busy={busy === p.name}
                  onEdit={() => {
                    setEditing(p.name);
                    setCreating(false);
                    setError(null);
                  }}
                  onProbe={async () => {
                    setError(null);
                    return await probeProvider(p.name);
                  }}
                  onMakeDefault={async () => {
                    setBusy(p.name);
                    setError(null);
                    try {
                      await setDefaultProvider(p.name);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setBusy(null);
                    }
                  }}
                  onDelete={async () => {
                    const titleFn = t("settingsProvidersDeleteConfirmTitle");
                    const title =
                      typeof titleFn === "function"
                        ? (titleFn as (n: string) => string)(p.name)
                        : `Delete provider "${p.name}"?`;
                    const ok = await confirm({
                      title,
                      detail: tx(
                        "settingsProvidersDeleteConfirmDetail",
                        "This removes it from config.json and deletes the api-key file.",
                      ),
                      danger: true,
                      confirmLabel: t("uiConfirmDeleteOk"),
                    });
                    if (!ok) return;
                    setBusy(p.name);
                    setError(null);
                    try {
                      await deleteProvider(p.name, true);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setBusy(null);
                    }
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------- read-mode row -------------------------------------------

function badgesForModel(info: ProviderInfo, model: string): string[] {
  const cap = (info.capabilities ?? []).find((c) => c.model === model);
  if (!cap) return [];
  const out: string[] = [];
  if (cap.supportsToolCalls === true) out.push("tools");
  if (cap.supportsReasoning === true) out.push("reasoning");
  if (cap.supportsImages === true) out.push("vision");
  if ((cap.contextWindow ?? 0) >= 64000) out.push("64k+");
  if (cap.privacyHint === "local") out.push("local");
  if (cap.privacyHint === "third-party-router") out.push("router");
  return out;
}

function ProviderRow({
  info,
  busy,
  onEdit,
  onProbe,
  onMakeDefault,
  onDelete,
}: {
  info: ProviderInfo;
  busy: boolean;
  onEdit: () => void;
  onProbe: () => Promise<ProbeResult>;
  onMakeDefault: () => void;
  onDelete: () => void;
}) {
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const handleProbe = async () => {
    setProbing(true);
    setProbeError(null);
    try {
      const r = await onProbe();
      setProbeResult(r);
    } catch (e) {
      setProbeError(e instanceof Error ? e.message : String(e));
      setProbeResult(null);
    } finally {
      setProbing(false);
    }
  };

  const defaultBadges = badgesForModel(info, info.default_model);
  return (
    <>
      <div className="settings-provider-head">
        <strong>{info.name}</strong>
        {info.is_default ? (
          <span className="settings-tag">
            {tx("settingsProvidersDefault", "default")}
          </span>
        ) : null}
        {info.kind && info.kind !== info.name ? (
          <span className="settings-tag" title={t("setSecBProvidersProfileKind")}>
            {info.kind}
          </span>
        ) : null}
      </div>
      <div className="settings-provider-default-model">
        <span className="settings-row-hint">
          {tx("settingsProvidersDefaultModel", "default model")}:{" "}
        </span>
        <span className="mono">{info.default_model}</span>
        {defaultBadges.map((b) => (
          <span key={b} className="settings-tag" title={t("setSecBProvidersCapability", b)}>
            {b}
          </span>
        ))}
      </div>
      {info.models.length > 1 ? (
        <ul className="settings-provider-models">
          {info.models
            .filter((m) => m !== info.default_model)
            .map((m) => {
              const bs = badgesForModel(info, m);
              return (
                <li key={m} className="mono">
                  {m}
                  {bs.map((b) => (
                    <span
                      key={b}
                      className="settings-tag"
                      title={t("setSecBProvidersCapability", b)}
                    >
                      {b}
                    </span>
                  ))}
                </li>
              );
            })}
        </ul>
      ) : null}
      <div className="provider-row-actions">
        <button type="button" onClick={onEdit} disabled={busy || probing}>
          {tx("settingsProvidersEdit", "Edit")}
        </button>
        <button type="button" onClick={handleProbe} disabled={busy || probing}>
          {probing
            ? tx("settingsProvidersProbing", "Probing…")
            : tx("settingsProvidersProbe", "Probe")}
        </button>
        {!info.is_default ? (
          <button type="button" onClick={onMakeDefault} disabled={busy || probing}>
            {tx("settingsProvidersMakeDefault", "Make default")}
          </button>
        ) : null}
        <button
          type="button"
          className="agent-profile-delete"
          onClick={onDelete}
          disabled={busy || probing}
        >
          {tx("settingsProvidersDelete", "Delete")}
        </button>
      </div>
      {probeResult ? (
        <div className="settings-row-hint" role="status">
          {probeResult.auth_ok ? t("setSecBProvidersAuthOk") : t("setSecBProvidersAuthFailed")}
          {" · "}
          {probeResult.default_model_ok
            ? t("setSecBProvidersModelOk")
            : t("setSecBProvidersModelError", probeResult.error ?? t("error"))}
          {" · "}
          {t("setSecBProvidersLatencyMs", probeResult.latency_ms)}
        </div>
      ) : null}
      {probeError ? (
        <div className="settings-inline-error" role="alert">
          {probeError}
        </div>
      ) : null}
    </>
  );
}

// ---------- create/edit form ----------------------------------------

interface FormProps {
  mode: "create" | "edit";
  initialName?: string;
  inModal?: boolean;
  onCancel: () => void;
  onSaved: () => void;
  onError: (msg: string | null) => void;
  onBusyChange?: (busy: boolean) => void;
}

function ProviderForm({
  mode,
  initialName,
  inModal,
  onCancel,
  onSaved,
  onError,
  onBusyChange,
}: FormProps) {
  const [snapshot, setSnapshot] = useState<ProviderSnapshot | null>(null);
  const [name, setName] = useState(initialName ?? "");
  const [kind, setKind] = useState<string>(KIND_OPTIONS[0].value);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [modelsCsv, setModelsCsv] = useState("");
  const [version, setVersion] = useState("");
  const [reasoningSummary, setReasoningSummary] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [includeEncryptedReasoning, setIncludeEncryptedReasoning] = useState(false);
  const [serviceTier, setServiceTier] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusyLocal] = useState(false);
  const setBusy = (next: boolean) => {
    setBusyLocal(next);
    onBusyChange?.(next);
  };

  // Load snapshot when editing.
  useEffect(() => {
    if (mode !== "edit" || !initialName) return;
    void getProvider(initialName)
      .then((s) => {
        setSnapshot(s);
        setName(s.name);
        setKind(s.kind);
        setBaseUrl(s.base_url ?? "");
        setDefaultModel(s.default_model);
        setModelsCsv(s.models.filter((m) => m !== s.default_model).join(", "));
        setVersion(s.version ?? "");
        setReasoningSummary(s.reasoning_summary ?? "");
        setReasoningEffort(s.reasoning_effort ?? "");
        setIncludeEncryptedReasoning(s.include_encrypted_reasoning ?? false);
        setServiceTier(s.service_tier ?? "");
        if (
          s.version ||
          s.reasoning_summary ||
          s.reasoning_effort ||
          s.include_encrypted_reasoning ||
          s.service_tier
        ) {
          setShowAdvanced(true);
        }
      })
      .catch((e) => onError(e instanceof Error ? e.message : String(e)));
  }, [mode, initialName, onError]);

  const handleKindChange = (next: string) => {
    const meta = KIND_DEFAULTS[next];
    if (meta) {
      if (!defaultModel.trim() && meta.default_model) {
        setDefaultModel(meta.default_model);
      }
      if (!baseUrl.trim() && meta.base_url) {
        setBaseUrl(meta.base_url);
      }
    }
    setKind(next);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    onError(null);
    if (!name.trim()) {
      onError(tx("settingsProvidersErrNameRequired", "Name is required"));
      return;
    }
    if (!defaultModel.trim()) {
      onError(tx("settingsProvidersErrModelRequired", "Default model is required"));
      return;
    }
    setBusy(true);
    try {
      const def: ProviderDef = {
        name: name.trim(),
        kind: kind.trim(),
        api_key: apiKey.trim() ? apiKey.trim() : undefined,
        base_url: baseUrl.trim() ? baseUrl.trim() : undefined,
        default_model: defaultModel.trim(),
        models: modelsCsv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        version: version.trim() ? version.trim() : undefined,
        reasoning_summary: reasoningSummary.trim() ? reasoningSummary.trim() : undefined,
        reasoning_effort: reasoningEffort.trim() ? reasoningEffort.trim() : undefined,
        include_encrypted_reasoning: includeEncryptedReasoning ? true : undefined,
        service_tier: serviceTier.trim() ? serviceTier.trim() : undefined,
      };
      if (mode === "create") {
        await createProvider(def);
      } else {
        await updateProvider(initialName!, def);
      }
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const showAdvancedTab = ["anthropic", "codex", "openai-responses"].includes(kind);
  const isCodex = kind === "codex";

  return (
    <form
      className={`provider-form${inModal ? " provider-form-in-modal" : ""}`}
      onSubmit={submit}
    >
      {/* ---------- Identity ---------- */}
      <div className="provider-form-group">
        <h4 className="provider-form-group-title">
          {tx("settingsProvidersGroupIdentity", "Identity")}
        </h4>
        <label className="agent-profile-field full">
          <span>{tx("settingsProvidersFieldName", "Name")}</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy || mode === "edit"}
            placeholder={tx("settingsProvidersFieldNamePh", "my-custom-openai")}
          />
        </label>
        <div className="provider-form-kind-label">
          {tx("settingsProvidersFieldKind", "Kind")}
        </div>
        <div className="provider-kind-grid" role="radiogroup" aria-label={tx("settingsProvidersFieldKind", "Kind")}>
          {KIND_OPTIONS.map((o) => {
            const selected = kind === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`provider-kind-tile${selected ? " is-selected" : ""}`}
                onClick={() => handleKindChange(o.value)}
                disabled={busy}
              >
                <strong>{tx(o.labelKey, o.labelFallback)}</strong>
                <span className="provider-kind-tile-hint">
                  {tx(o.hintKey, o.hintFallback)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ---------- Authentication ---------- */}
      <div className="provider-form-group">
        <h4 className="provider-form-group-title">
          {tx("settingsProvidersGroupAuth", "Authentication")}
        </h4>
        <label className="agent-profile-field full">
          <span>
            {tx("settingsProvidersFieldApiKey", "API key")}
            {snapshot?.has_api_key ? (
              <em className="provider-form-key-on-file">
                {" · "}
                {tx(
                  "settingsProvidersFieldApiKeyOnFile",
                  "on file (leave blank to keep)",
                )}
              </em>
            ) : null}
          </span>
          <div className="provider-form-key-row">
            <input
              type={showKey && !isCodex ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={busy || isCodex}
              placeholder={
                isCodex
                  ? tx(
                      "settingsProvidersFieldApiKeyCodexPh",
                      "use `jarvis login --provider codex`",
                    )
                  : tx("settingsProvidersFieldApiKeyPh", "sk-...")
              }
              autoComplete="off"
            />
            {!isCodex ? (
              <button
                type="button"
                className="provider-form-key-toggle"
                onClick={() => setShowKey((v) => !v)}
                disabled={busy}
                aria-pressed={showKey}
              >
                {showKey
                  ? tx("settingsProvidersFieldApiKeyHide", "Hide")
                  : tx("settingsProvidersFieldApiKeyShow", "Show")}
              </button>
            ) : null}
          </div>
        </label>
      </div>

      {/* ---------- Models ---------- */}
      <div className="provider-form-group">
        <h4 className="provider-form-group-title">
          {tx("settingsProvidersGroupModels", "Models")}
        </h4>
        <div className="provider-form-row">
          <label className="agent-profile-field">
            <span>{tx("settingsProvidersFieldDefaultModel", "Default model")}</span>
            <input
              type="text"
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              disabled={busy}
              placeholder={tx("settingsProvidersFieldDefaultModelPh", "gpt-4o-mini")}
            />
          </label>
          <label className="agent-profile-field">
            <span>{tx("settingsProvidersFieldBaseUrl", "Base URL (optional)")}</span>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              disabled={busy}
              placeholder={
                kind === "ollama"
                  ? tx(
                      "settingsProvidersFieldBaseUrlOllamaPh",
                      "http://localhost:11434/v1",
                    )
                  : tx(
                      "settingsProvidersFieldBaseUrlPh",
                      "https://api.example.com/v1",
                    )
              }
            />
          </label>
        </div>

        <label className="agent-profile-field full">
          <span>
            {tx(
              "settingsProvidersFieldModelsCsv",
              "Models (comma-separated, optional)",
            )}
          </span>
          <input
            type="text"
            value={modelsCsv}
            onChange={(e) => setModelsCsv(e.target.value)}
            disabled={busy}
            placeholder={tx(
              "settingsProvidersFieldModelsCsvPh",
              "gpt-4o, gpt-4o-mini, o3-mini",
            )}
          />
        </label>
      </div>

      {/* ---------- Advanced ---------- */}
      {showAdvancedTab ? (
        <div className="provider-form-group">
          <details
            open={showAdvanced}
            onToggle={(e) =>
              setShowAdvanced((e.target as HTMLDetailsElement).open)
            }
            className="provider-form-advanced"
          >
            <summary className="provider-form-group-title">
              {tx("settingsProvidersGroupAdvanced", "Advanced")}
            </summary>
            {kind === "anthropic" ? (
              <label className="agent-profile-field">
                <span>
                  {tx(
                    "settingsProvidersFieldVersion",
                    "anthropic-version (optional)",
                  )}
                </span>
                <input
                  type="text"
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  disabled={busy}
                  placeholder={tx("settingsProvidersFieldVersionPh", "2023-06-01")}
                />
              </label>
            ) : null}
            {(kind === "codex" || kind === "openai-responses") && (
              <>
                <div className="provider-form-row">
                  <label className="agent-profile-field">
                    <span>
                      {tx(
                        "settingsProvidersFieldReasoningSummary",
                        "reasoning.summary",
                      )}
                    </span>
                    <Select
                      value={reasoningSummary}
                      onChange={setReasoningSummary}
                      disabled={busy}
                      ariaLabel="reasoning.summary"
                      options={[
                        {
                          value: "",
                          label: tx("settingsProvidersFieldUnset", "(unset)"),
                        },
                        { value: "auto", label: "auto" },
                        { value: "concise", label: "concise" },
                        { value: "detailed", label: "detailed" },
                      ]}
                    />
                  </label>
                  <label className="agent-profile-field">
                    <span>
                      {tx(
                        "settingsProvidersFieldReasoningEffort",
                        "reasoning.effort",
                      )}
                    </span>
                    <Select
                      value={reasoningEffort}
                      onChange={setReasoningEffort}
                      disabled={busy}
                      ariaLabel="reasoning.effort"
                      options={[
                        {
                          value: "",
                          label: tx("settingsProvidersFieldUnset", "(unset)"),
                        },
                        { value: "low", label: "low" },
                        { value: "medium", label: "medium" },
                        { value: "high", label: "high" },
                        { value: "max", label: "max" },
                      ]}
                    />
                  </label>
                </div>
                <label className="agent-profile-field">
                  <span>
                    {tx("settingsProvidersFieldServiceTier", "service_tier")}
                  </span>
                  <Select
                    value={serviceTier}
                    onChange={setServiceTier}
                    disabled={busy}
                    ariaLabel="service_tier"
                    options={[
                      {
                        value: "",
                        label: tx("settingsProvidersFieldUnset", "(unset)"),
                      },
                      { value: "auto", label: "auto" },
                      { value: "priority", label: "priority" },
                      { value: "flex", label: "flex" },
                    ]}
                  />
                </label>
                <label className="provider-form-checkbox">
                  <input
                    type="checkbox"
                    checked={includeEncryptedReasoning}
                    onChange={(e) =>
                      setIncludeEncryptedReasoning(e.target.checked)
                    }
                    disabled={busy}
                  />
                  <span>
                    {tx(
                      "settingsProvidersFieldEncryptedReasoning",
                      "Include encrypted reasoning content (reasoning models only)",
                    )}
                  </span>
                </label>
              </>
            )}
          </details>
        </div>
      ) : null}

      <div className="agent-profile-actions">
        <button type="submit" disabled={busy || !name.trim() || !defaultModel.trim()}>
          {busy
            ? tx("settingsProvidersSaving", "Saving…")
            : mode === "create"
              ? tx("settingsProvidersCreate", "Create provider")
              : tx("settingsProvidersSave", "Save")}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          {tx("settingsProvidersCancel", "Cancel")}
        </button>
      </div>
    </form>
  );
}

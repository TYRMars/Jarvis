// Model + effort dropdown anchored under the composer. Clicking the
// trigger opens a panel with two columns: one model per provider
// (default model bubbled up; default provider tagged), and one
// effort level per row. Selecting a model dispatches through the
// bridge so the WS configure frame ships immediately.

import { useEffect, useRef } from "react";
import { useAppStore, type EffortLevel, type ProviderInfo } from "../../store/appStore";
import { t } from "../../utils/i18n";
import { selectModel } from "../../services/socket";

const EFFORT_OPTIONS: { value: EffortLevel; labelKey: string }[] = [
  { value: "low", labelKey: "effortLow" },
  { value: "medium", labelKey: "effortMedium" },
  { value: "high", labelKey: "effortHigh" },
  { value: "extra-high", labelKey: "effortExtraHigh" },
  { value: "max", labelKey: "effortMax" },
];

/// Friendly name for a model id. Matches the legacy `formatModelLabel`
/// table so the dropdown reads the same after migration.
const KNOWN_LABELS: Record<string, string> = {
  "kimi-k2.6": "Kimi K2.6",
  "kimi-for-coding": "Kimi Coding",
  "gpt-5.5": "GPT 5.5",
  "gpt-5.4": "GPT 5.4",
  "gpt-5.4-mini": "GPT 5.4 Mini",
  "gpt-5.3-codex": "GPT 5.3 Codex",
  "gpt-5.2": "GPT 5.2",
};

function formatModelLabel(model: string): string {
  if (!model) return t("serverDefault");
  if (KNOWN_LABELS[model]) return KNOWN_LABELS[model];
  return model
    .replace(/^gpt-/i, "GPT ")
    .replace(/^claude-/i, "")
    .replace(/^kimi-/i, "Kimi ")
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => (part.length <= 2 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(" ");
}

interface RoutingOption {
  value: string; // "<provider>|<model>"
  provider: string;
  model: string;
  label: string;
  isDefault: boolean;
}

function flattenRoutingOptions(providers: ProviderInfo[]): RoutingOption[] {
  const out: RoutingOption[] = [];
  for (const p of providers) {
    const seen = new Set<string>();
    const ordered = [p.default_model, ...(p.models || [])].filter(
      (m) => m && !seen.has(m) && (seen.add(m), true),
    );
    for (const m of ordered) {
      out.push({
        value: `${p.name}|${m}`,
        provider: p.name,
        model: m,
        label: `${p.name} · ${formatModelLabel(m)}`,
        isDefault: p.is_default && m === p.default_model,
      });
    }
  }
  return out;
}

function effortLabel(value: EffortLevel): string {
  const opt = EFFORT_OPTIONS.find((o) => o.value === value) || EFFORT_OPTIONS[1];
  return t(opt.labelKey);
}

export function ModelSummary() {
  const providers = useAppStore((s) => s.providers);
  const routing = useAppStore((s) => s.routing);
  const effort = useAppStore((s) => s.effort);
  let modelLabel = t("serverDefault");
  if (routing) {
    const opt = flattenRoutingOptions(providers).find((o) => o.value === routing);
    if (opt) modelLabel = opt.label;
    else {
      const [, m] = routing.split("|");
      modelLabel = formatModelLabel(m || "");
    }
  }
  return <span id="model-summary">{`${modelLabel} · ${effortLabel(effort)}`}</span>;
}

export function ModelMenu() {
  const providers = useAppStore((s) => s.providers);
  const routing = useAppStore((s) => s.routing);
  const effort = useAppStore((s) => s.effort);
  const open = useAppStore((s) => s.modelMenuOpen);
  const setOpen = useAppStore((s) => s.setModelMenuOpen);
  const setEffort = useAppStore((s) => s.setEffort);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Click-outside closes. Bound at the document level because clicks
  // inside our wrapper bubble up to body anyway, and we want any
  // unrelated click (sidebar, chat, …) to dismiss.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, setOpen]);

  const opts = flattenRoutingOptions(providers);
  // Index 0 is reserved for "server default" (empty value).
  const allRows: RoutingOption[] = [
    { value: "", provider: "", model: "", label: t("serverDefault"), isDefault: false },
    ...opts,
  ];

  return (
    <div id="model-control" className="model-control" ref={wrapRef}>
      <button
        id="model-menu-button"
        type="button"
        className="model-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        <ModelSummary />
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div id="model-menu" className={"model-menu" + (open ? "" : " hidden")} role="menu">
        <div className="model-menu-section">
          <div className="model-menu-heading">
            <span>{t("models")}</span>
            <span className="shortcut-set" aria-hidden="true">
              <kbd>⇧</kbd><kbd>⌘</kbd><kbd>I</kbd>
            </span>
          </div>
          <div id="model-menu-models" className="model-menu-options">
            {allRows.map((row, i) => {
              const active = row.value === routing;
              return (
                <button
                  key={row.value || "__default"}
                  type="button"
                  className={"model-menu-item" + (active ? " active" : "")}
                  data-value={row.value}
                  onClick={() => {
                    selectModel(row.value);
                    setOpen(false);
                  }}
                >
                  <span className="model-menu-check">{active ? "✓" : ""}</span>
                  <span className="model-menu-label">{row.label}</span>
                  <span className="model-menu-key">{i ? String(i) : ""}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="model-menu-divider" />
        <div className="model-menu-section">
          <div className="model-menu-heading">
            <span>{t("effort")}</span>
            <span className="shortcut-set" aria-hidden="true">
              <kbd>⇧</kbd><kbd>⌘</kbd><kbd>E</kbd>
            </span>
          </div>
          <div id="effort-menu-options" className="model-menu-options">
            {EFFORT_OPTIONS.map((opt) => {
              const active = opt.value === effort;
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={"model-menu-item" + (active ? " active" : "")}
                  data-value={opt.value}
                  onClick={() => setEffort(opt.value)}
                >
                  <span className="model-menu-check">{active ? "✓" : ""}</span>
                  <span className="model-menu-label">{t(opt.labelKey)}</span>
                  <span className="model-menu-key" />
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// Settings → Routing — per-slot (provider, model) picker + a
// fallback chain editor. Backed by the route-policy admin REST
// (`GET/PUT /v1/routing`, `PATCH/DELETE /v1/routing/:slot`).
//
// Slots map to specific callsites in the runtime:
// - `summarization` → `SummarizingMemory` (live: changes here apply
//   on the next compaction call).
// - `coding` / `review` / `doc_reader` → SubAgent factories (pinned
//   at startup; the section warns the operator a restart is needed
//   for these to take effect).
// - `default` / `vision` / `local_private` → reserved for future
//   per-request resolvers.
//
// Fallbacks are a different thing: an ordered chain consulted by
// `FallbackProvider` on 429 / 5xx. Auth errors short-circuit so a
// bad key never walks the chain.

import { useEffect, useMemo, useState } from "react";
import { Section } from "./Section";
import { t } from "../../../utils/i18n";
import { useAppStore } from "../../../store/appStore";
import type { ProviderInfo } from "../../../store/types";
import {
  ALL_ROUTE_SLOTS,
  deleteRouteSlot,
  fetchRoutePolicy,
  patchRouteSlot,
  replaceRoutePolicy,
  type ModelTarget,
  type RoutePolicy,
  type RouteSlot,
} from "../../../services/routing";

interface Option {
  value: string; // `<provider>|<model>`
  provider: string;
  model: string;
  label: string;
}

function flattenOptions(providers: ProviderInfo[]): Option[] {
  const out: Option[] = [];
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
        label: `${p.name} · ${m}`,
      });
    }
  }
  return out;
}

function targetToValue(t: ModelTarget | undefined): string {
  if (!t) return "";
  return `${t.provider}|${t.model}`;
}

function valueToTarget(v: string): ModelTarget | null {
  if (!v) return null;
  const [provider, ...rest] = v.split("|");
  if (!provider || rest.length === 0) return null;
  return { provider, model: rest.join("|") };
}

const SLOT_DESCRIPTIONS: Record<RouteSlot, { title: string; desc: string }> = {
  default: {
    title: "Default",
    desc: "Fallback target every other slot inherits when unset.",
  },
  coding: {
    title: "Coding",
    desc: "Routes the codex SubAgent. Restart required for changes.",
  },
  review: {
    title: "Review",
    desc: "Routes the reviewer SubAgent. Restart required for changes.",
  },
  summarization: {
    title: "Summarization",
    desc: "Routes the summarising memory. Live — applies on the next compaction.",
  },
  doc_reader: {
    title: "Doc reader",
    desc: "Routes the doc-reader SubAgent. Restart required for changes.",
  },
  vision: {
    title: "Vision",
    desc: "Reserved for future per-request resolvers. Stored only.",
  },
  local_private: {
    title: "Local / private",
    desc: "Reserved for privacy-sensitive workloads. Stored only.",
  },
};

export function RoutingSection() {
  const providers = useAppStore((s) => s.providers);
  const [policy, setPolicy] = useState<RoutePolicy>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busySlot, setBusySlot] = useState<RouteSlot | "fallbacks" | null>(null);

  const options = useMemo(() => flattenOptions(providers), [providers]);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    fetchRoutePolicy()
      .then((p) => {
        if (!cancel) {
          setPolicy(p);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancel) setError(String(e));
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, []);

  async function onSetSlot(slot: RouteSlot, value: string) {
    setBusySlot(slot);
    try {
      const target = valueToTarget(value);
      const updated = target
        ? await patchRouteSlot(slot, target)
        : await deleteRouteSlot(slot);
      setPolicy(updated);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusySlot(null);
    }
  }

  async function onAddFallback(value: string) {
    const target = valueToTarget(value);
    if (!target) return;
    setBusySlot("fallbacks");
    try {
      const next: RoutePolicy = {
        ...policy,
        fallbacks: [...(policy.fallbacks || []), target],
      };
      const updated = await replaceRoutePolicy(next);
      setPolicy(updated);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusySlot(null);
    }
  }

  async function onRemoveFallback(idx: number) {
    setBusySlot("fallbacks");
    try {
      const next: RoutePolicy = {
        ...policy,
        fallbacks: (policy.fallbacks || []).filter((_, i) => i !== idx),
      };
      const updated = await replaceRoutePolicy(next);
      setPolicy(updated);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusySlot(null);
    }
  }

  async function onMoveFallback(idx: number, dir: -1 | 1) {
    const list = [...(policy.fallbacks || [])];
    const j = idx + dir;
    if (j < 0 || j >= list.length) return;
    [list[idx], list[j]] = [list[j], list[idx]];
    setBusySlot("fallbacks");
    try {
      const updated = await replaceRoutePolicy({ ...policy, fallbacks: list });
      setPolicy(updated);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusySlot(null);
    }
  }

  return (
    <Section
      id="routing"
      titleKey="settingsRoutingTitle"
      titleFallback="Routing"
      descKey="settingsRoutingDesc"
      descFallback="Per-slot model targets + a fallback chain. SubAgent slots take effect after a server restart; summarisation applies live."
    >
      {loading ? (
        <div className="muted">{t("loading")}</div>
      ) : (
        <>
          {error && (
            <div className="error-banner" role="alert" style={{ marginBottom: 12 }}>
              {error}
            </div>
          )}

          <div className="routing-slots">
            {ALL_ROUTE_SLOTS.map((slot) => {
              const current = policy[slot] as ModelTarget | undefined;
              const value = targetToValue(current);
              const meta = SLOT_DESCRIPTIONS[slot];
              return (
                <div key={slot} className="routing-row">
                  <div className="routing-row-label">
                    <strong>{meta.title}</strong>
                    <span className="muted small"> {meta.desc}</span>
                  </div>
                  <select
                    value={value}
                    disabled={busySlot === slot}
                    onChange={(e) => onSetSlot(slot, e.target.value)}
                    aria-label={`route ${slot}`}
                  >
                    <option value="">— inherit / unset —</option>
                    {options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>

          <h3 style={{ marginTop: 24 }}>Fallback chain</h3>
          <p className="muted small">
            Ordered list consulted by <code>FallbackProvider</code> on 429 /
            5xx / timeout. Auth errors short-circuit. Self-reference (the
            primary's own provider) is dropped at runtime.
          </p>

          <ol className="routing-fallbacks">
            {(policy.fallbacks || []).map((target, idx) => (
              <li key={`${target.provider}/${target.model}/${idx}`}>
                <span>
                  {target.provider} · {target.model}
                </span>
                <button
                  type="button"
                  onClick={() => onMoveFallback(idx, -1)}
                  disabled={idx === 0 || busySlot === "fallbacks"}
                  aria-label="move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => onMoveFallback(idx, 1)}
                  disabled={
                    idx === (policy.fallbacks?.length ?? 0) - 1 ||
                    busySlot === "fallbacks"
                  }
                  aria-label="move down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveFallback(idx)}
                  disabled={busySlot === "fallbacks"}
                >
                  Remove
                </button>
              </li>
            ))}
          </ol>
          <div>
            <select
              defaultValue=""
              disabled={busySlot === "fallbacks"}
              onChange={(e) => {
                if (e.target.value) {
                  void onAddFallback(e.target.value);
                  e.target.value = "";
                }
              }}
              aria-label="add fallback"
            >
              <option value="">+ Add fallback…</option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
    </Section>
  );
}

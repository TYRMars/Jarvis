// Composer-footer token-usage readout, fully React. Subscribes to
// `appStore.usage` which the imperative `legacy/usage.ts` mirrors
// via `appStore.getState().setUsage(...)` whenever a `usage` frame
// lands. Renders the same compact line the old `els.usageSlot`
// produced (`prompt 12k · cached 8k (66%) · out 543 · think 100`).

import { useAppStore } from "../store/appStore";
import { t } from "../utils/i18n";

function fmt(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(n);
}

export function UsageBadge() {
  const usage = useAppStore((s) => s.usage);

  if (!usage.calls) {
    return <span id="usage-slot" className="usage-slot hidden" />;
  }

  const parts: string[] = [];
  if (usage.prompt) {
    const cachedPct =
      usage.prompt > 0 ? Math.round((usage.cached / usage.prompt) * 100) : 0;
    parts.push(t("usagePrompt", fmt(usage.prompt)));
    if (usage.cached) parts.push(t("usageCached", fmt(usage.cached), cachedPct));
  }
  if (usage.completion) parts.push(t("usageCompletion", fmt(usage.completion)));
  if (usage.reasoning) parts.push(t("usageReasoning", fmt(usage.reasoning)));

  return (
    <span id="usage-slot" className="usage-slot">
      {parts.join(" · ")}
    </span>
  );
}

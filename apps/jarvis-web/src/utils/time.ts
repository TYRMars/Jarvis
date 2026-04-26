// Time formatting helpers used by the conversations rail / quick
// switcher. The locale-flavoured month-day branch leans on the
// store's `lang` so the output matches whatever language the rest
// of the UI is showing.

import { appStore } from "../store/appStore";
import { t } from "./i18n";
import type { ConvoListRow } from "../types/frames";

/// `2026-04-26T10:12:00Z` → `"3h ago"`-shaped string. Used for the
/// relative-time line under each conversation row. Returns the
/// empty string for null / unparseable input rather than something
/// like "NaNm ago" — the row still has id + message count to read
/// from, so a missing timestamp is recoverable.
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t0 = Date.parse(iso);
  if (Number.isNaN(t0)) return "";
  const diff = Math.max(0, Date.now() - t0);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t("relJustNow");
  if (min < 60) return t("relMinAgo", min);
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("relHourAgo", hr);
  const day = Math.floor(hr / 24);
  return t("relDayAgo", day);
}

/// Bucket label for the conversation rail: "Today" / "Yesterday" /
/// "Mar 12" (within 30 days, locale-aware) / "Older". Used to slot
/// rows into chronological groups so a long history reads at a
/// glance.
export function convoGroupLabel(row: ConvoListRow): string {
  const iso = row.updated_at || row.created_at;
  const ts = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(ts)) return t("groupOlder");

  const date = new Date(ts);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfRow = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfRow) / 86_400_000);
  if (dayDiff <= 0) return t("groupToday");
  if (dayDiff === 1) return t("groupYesterday");
  if (dayDiff < 30) {
    const lang = appStore.getState().lang;
    return date.toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", {
      month: "short",
      day: "numeric",
    });
  }
  return t("groupOlder");
}

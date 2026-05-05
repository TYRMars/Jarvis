// Shared activity-row presentation. Lifted out of `RequirementDetail.tsx`
// so the in-chat `SessionExecutionDrawer` can render the same rows
// without copy-pasting the per-`ActivityKind` template logic.
//
// Pure presentation — no data loading. Caller passes in the array
// (already sorted desc by created_at by `services/requirements`).

import type { Activity, ActivityActor } from "../../types/frames";
import { t } from "../../utils/i18n";
import { getAgentProfileFromCache } from "../../services/agentProfiles";

export function ActivityList({ activities }: { activities: Activity[] }) {
  if (activities.length === 0) {
    return <p className="requirement-detail-empty">{t("activityEmpty")}</p>;
  }
  return (
    <ol className="requirement-detail-activity-list">
      {activities.map((a) => (
        <li
          key={a.id}
          className={"requirement-detail-activity-row kind-" + a.kind}
        >
          <span className="requirement-detail-activity-time">
            {formatTime(a.created_at)}
          </span>
          <span className="requirement-detail-activity-actor">
            {actorLabel(a.actor)}
          </span>
          <span className="requirement-detail-activity-text">
            {activityText(a)}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function actorLabel(actor: ActivityActor): string {
  switch (actor.type) {
    case "human":
      return t("activityActorHuman");
    case "system":
      return t("activityActorSystem");
    case "agent":
      return t("activityActorAgent", actor.profile_id);
  }
}

export function activityText(a: Activity): string {
  const body = a.body as Record<string, string | undefined>;
  switch (a.kind) {
    case "status_change":
      return t("activityStatusChange", body.from ?? "?", body.to ?? "?");
    case "run_started":
      return t("activityRunStarted", shortenId(body.run_id));
    case "run_finished":
      return t(
        "activityRunFinished",
        shortenId(body.run_id),
        body.status ?? "?",
      );
    case "verification_finished":
      return t(
        "activityVerificationFinished",
        shortenId(body.run_id),
        body.status ?? "?",
      );
    case "assignee_change": {
      const fromName = assigneeName(body.from);
      const toName = assigneeName(body.to);
      return t("activityAssigneeChange", fromName, toName);
    }
    default:
      return t("activityFallback", a.kind);
  }
}

function assigneeName(id: string | undefined | null): string {
  if (id == null) return t("detailAssigneeUnassigned");
  const p = getAgentProfileFromCache(id);
  return p ? p.name : shortenId(id);
}

function shortenId(id: string | undefined): string {
  if (!id) return "?";
  return id.slice(0, 8);
}

export function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

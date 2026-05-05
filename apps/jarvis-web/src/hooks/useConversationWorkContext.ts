// Aggregate Requirement / RequirementRun / Activity for the
// in-session execution shoulder + drawer. Pure-frontend derivation
// from the existing services/requirements caches — Phase 1 of
// `docs/proposals/session-execution-context.zh-CN.md`. A future
// Phase 3 can swap this for `GET /v1/conversations/:id/work-context`.
//
// Reactivity model: the underlying `services/requirements.ts` caches
// already broadcast through their `subscribe*` APIs whenever a REST
// load or WS frame mutates state. We subscribe to all three streams
// and bump a local tick counter so the hook re-derives. Aggregation
// itself is cheap (one filter over project requirements + lookups
// in two Maps), so we don't bother memoising further.

import { useEffect, useMemo, useState } from "react";
import {
  listActivitiesForRequirement,
  listRequirements,
  listRunsForRequirement,
  loadActivitiesForRequirement,
  loadRequirements,
  loadRunsForRequirement,
  subscribeRequirementActivities,
  subscribeRequirementRuns,
  subscribeRequirements,
} from "../services/requirements";
import {
  pickPrimaryRequirement,
  type ConversationWorkContext,
} from "../components/Composer/sessionExecutionDisplay";
import type { Requirement, RequirementRun } from "../types/frames";

const RECENT_ACTIVITY_LIMIT = 25;

export function useConversationWorkContext(
  conversationId: string | null,
  projectId: string | null,
): ConversationWorkContext | null {
  const [tick, setTick] = useState(0);

  // Subscribe to every cache the derivation reads. Each subscription
  // returns an unsubscriber; React calls it on cleanup. The bump
  // forces useMemo below to re-run.
  useEffect(() => {
    const a = subscribeRequirements(() => setTick((t) => t + 1));
    const b = subscribeRequirementRuns(() => setTick((t) => t + 1));
    const c = subscribeRequirementActivities(() => setTick((t) => t + 1));
    return () => {
      a();
      b();
      c();
    };
  }, []);

  // Initial fetch: requirements for the project. The cache is
  // localStorage-backed, so the first paint usually has stale data
  // already; the load reconciles in the background.
  useEffect(() => {
    if (!projectId) return;
    void loadRequirements(projectId);
  }, [projectId]);

  // Whenever the picked-primary requirement changes (or the project
  // requirement list changes), pull its runs + activities.
  const primary = useMemo<Requirement | null>(() => {
    if (!conversationId || !projectId) return null;
    const candidates = listRequirements(projectId).filter((r) =>
      r.conversation_ids.includes(conversationId),
    );
    if (candidates.length === 0) return null;
    const runsByRequirement: Record<string, RequirementRun[]> = {};
    for (const c of candidates) {
      runsByRequirement[c.id] = listRunsForRequirement(c.id);
    }
    return pickPrimaryRequirement(candidates, runsByRequirement, conversationId);
    // `tick` is a derivation cue — when it bumps, the underlying
    // `listRequirements` / `listRunsForRequirement` reads return
    // fresh data and primary may change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, projectId, tick]);

  useEffect(() => {
    if (!primary?.id) return;
    void loadRunsForRequirement(primary.id);
    void loadActivitiesForRequirement(primary.id);
  }, [primary?.id]);

  return useMemo<ConversationWorkContext | null>(() => {
    if (!conversationId) return null;
    if (!primary) {
      return {
        conversationId,
        projectId,
        requirement: null,
        latestRun: null,
        recentActivities: [],
      };
    }
    const runs = listRunsForRequirement(primary.id);
    const latestRun = runs.length > 0 ? runs[0] : null;
    const activities = listActivitiesForRequirement(primary.id).slice(
      0,
      RECENT_ACTIVITY_LIMIT,
    );
    return {
      conversationId,
      projectId,
      requirement: primary,
      latestRun,
      recentActivities: activities,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, projectId, primary, tick]);
}

export type { ConversationWorkContext } from "../components/Composer/sessionExecutionDisplay";

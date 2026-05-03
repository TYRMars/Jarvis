// Hook that owns the lifecycle of the dashboard's two fetches plus
// WS-driven invalidation. Returns loading state + data + an explicit
// `refetch` so the time-window selector can force a reload without
// re-mounting components. Polling backs up the WS subscription so a
// dashboard left open for hours stays roughly fresh even when no
// run mutations fire.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchWorkOverview,
  fetchWorkQuality,
  type WindowDays,
  type WorkOverview,
  type WorkQuality,
} from "../../../services/workOverview";
import {
  subscribeRequirements,
  subscribeRequirementRuns,
} from "../../../services/requirements";

const POLL_INTERVAL_MS = 30_000;

export interface UseWorkOverviewState {
  overview: WorkOverview | null;
  quality: WorkQuality | null;
  /// `null` here means "endpoint returned 503" — distinct from a
  /// transient network error which surfaces in `error`.
  overviewUnavailable: boolean;
  qualityUnavailable: boolean;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useWorkOverview(windowDays: WindowDays): UseWorkOverviewState {
  const [overview, setOverview] = useState<WorkOverview | null>(null);
  const [quality, setQuality] = useState<WorkQuality | null>(null);
  const [overviewUnavailable, setOverviewUnavailable] = useState(false);
  const [qualityUnavailable, setQualityUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bump to trigger a reload without a deep-equal compare on data.
  const [tick, setTick] = useState(0);
  const refetch = useCallback(() => setTick((t) => t + 1), []);

  // Mount-aware fetch so a stale response from a slow window switch
  // doesn't clobber a fresh one.
  const reqId = useRef(0);
  useEffect(() => {
    const myId = ++reqId.current;
    setLoading(true);
    setError(null);
    Promise.all([fetchWorkOverview(windowDays), fetchWorkQuality(windowDays)])
      .then(([ov, q]) => {
        if (myId !== reqId.current) return;
        setOverview(ov);
        setQuality(q);
        setOverviewUnavailable(ov === null);
        setQualityUnavailable(q === null);
      })
      .catch((e) => {
        if (myId !== reqId.current) return;
        setError(String(e instanceof Error ? e.message : e));
      })
      .finally(() => {
        if (myId === reqId.current) setLoading(false);
      });
  }, [windowDays, tick]);

  // WS-driven invalidation. Run / requirement mutations are the
  // signal that the dashboard's numbers are stale. Coalesce bursts
  // (a flurry of frames in 200ms gets one refetch).
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        refetch();
      }, 200);
    };
    const offReqs = subscribeRequirements(schedule);
    const offRuns = subscribeRequirementRuns(schedule);
    return () => {
      if (pending) clearTimeout(pending);
      offReqs();
      offRuns();
    };
  }, [refetch]);

  // Polling fallback: cheap, and the only thing that catches changes
  // when the WS isn't connected (e.g. paused tab woken up).
  useEffect(() => {
    const id = window.setInterval(refetch, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refetch]);

  return {
    overview,
    quality,
    overviewUnavailable,
    qualityUnavailable,
    loading,
    error,
    refetch,
  };
}

// Native human-in-the-loop request cards. The agent fires
// `ask.<kind>` tool calls which the server lifts into typed
// `hitl_request` frames; the user answers via `hitl_response`.

import type { StateCreator } from "zustand";
import type { HitlRequest, HitlResponse } from "../../types/frames";
import type { FullState } from "../appStore";
import type { HitlCardState } from "../types";

export interface HitlSlice {
  /// Native `ask.*` requests rendered beside approval cards.
  hitls: HitlCardState[];

  pushHitlRequest: (request: HitlRequest) => void;
  setHitlResponse: (response: HitlResponse) => void;
  finalizePendingHitls: () => void;
  clearHitls: () => void;
}

export const createHitlSlice: StateCreator<FullState, [], [], HitlSlice> = (set) => ({
  hitls: [],

  pushHitlRequest: (request) => {
    set((s) => {
      if (s.hitls.some((c) => c.request.id === request.id)) return s;
      return {
        hitls: [...s.hitls, { request, status: "pending", reason: null }],
        emptyHintIdShort: null,
      };
    });
  },
  setHitlResponse: (response) => {
    set((s) => ({
      hitls: s.hitls.map((c) =>
        c.request.id === response.request_id
          ? {
              ...c,
              status: response.status,
              payload: response.payload,
              reason: response.reason || null,
            }
          : c,
      ),
    }));
  },
  finalizePendingHitls: () => {
    set((s) => ({
      hitls: s.hitls.map((c) =>
        c.status === "pending"
          ? { ...c, status: "cancelled", reason: c.reason ?? "(turn ended)" }
          : c,
      ),
    }));
  },
  clearHitls: () => set({ hitls: [] }),
});

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { SERVER_TOKEN } from "@/lib/api-client";

export type TabKey =
  | "home"
  | "search"
  | "watchlist"
  | "sweep"
  | "history"
  | "genesis"
  | "mission"
  | "live";

interface HunterState {
  token: string;
  activeTab: TabKey;
  setToken: (t: string) => void;
  setActiveTab: (t: TabKey) => void;
}

export const useHunterStore = create<HunterState>()(
  persist(
    (set) => ({
      token: "",
      activeTab: "home",
      setToken: (token) => set({ token }),
      setActiveTab: (activeTab) => set({ activeTab }),
    }),
    {
      name: "claude-hunter-v1",
      // The token is stored here only as a sentinel (@server) or empty — never a raw PAT.
      // Previously: persist without partialize/merge kept a raw token in localStorage forever
      // (a complete contradiction of the note in api-client: "the token lives on the server — the client never holds it").
      // One-time migration: a raw PAT already in storage is replaced with the sentinel; if it is not
      // on the server — the user pastes it once more (and it is immediately captured there via captureTokenFrom).
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<HunterState>;
        const raw = typeof p.token === "string" ? p.token : "";
        const token = raw === "" || raw === SERVER_TOKEN ? raw : SERVER_TOKEN;
        return { ...current, ...p, token, activeTab: p.activeTab ?? current.activeTab };
      },
    }
  )
);

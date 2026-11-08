import { create } from "zustand";
import { persist } from "zustand/middleware";

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
    { name: "claude-hunter-v1" }
  )
);

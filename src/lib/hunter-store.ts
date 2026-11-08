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
      // הטוקן נשמר כאן רק כסנטינל (@server) או ריק — לעולם לא PAT גולמי.
      // בעבר: persist בלי partialize/merge שמר טוקן גולמי ב-localStorage לנצח
      // (סתירה מלאה להערה ב-api-client: "הטוקן נמצא בשרת — הלקוח לא מחזיק אותו").
      // מיגרציה חד-פעמית: PAT גולמי שהיה כבר באחסון מוחלף בסנטינל; אם הוא לא
      // על השרת — המשתמש מדביק פעם אחת נוספת (ומיד נלכד שם דרך captureTokenFrom).
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<HunterState>;
        const raw = typeof p.token === "string" ? p.token : "";
        const token = raw === "" || raw === SERVER_TOKEN ? raw : SERVER_TOKEN;
        return { ...current, ...p, token, activeTab: p.activeTab ?? current.activeTab };
      },
    }
  )
);

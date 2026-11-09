"use client";

import type { TierKey } from "@/lib/hunter-types";

export const TIER_STYLE: Record<TierKey, { ring: string; bg: string; text: string; label: string; emoji: string }> = {
  elite: { ring: "border-emerald-500", bg: "bg-emerald-50 dark:bg-emerald-950/40", text: "text-emerald-700 dark:text-emerald-300", label: "Elite", emoji: "💎" },
  gold: { ring: "border-amber-500", bg: "bg-amber-50 dark:bg-amber-950/40", text: "text-amber-700 dark:text-amber-300", label: "Gold", emoji: "🥇" },
  silver: { ring: "border-zinc-400", bg: "bg-zinc-100 dark:bg-zinc-800/60", text: "text-zinc-600 dark:text-zinc-300", label: "Silver", emoji: "🥈" },
  bronze: { ring: "border-orange-500", bg: "bg-orange-50 dark:bg-orange-950/40", text: "text-orange-700 dark:text-orange-300", label: "Bronze", emoji: "🥉" },
  seed: { ring: "border-stone-300", bg: "bg-stone-50 dark:bg-stone-900/40", text: "text-stone-500 dark:text-stone-400", label: "Seed", emoji: "🌱" },
};

export function ScoreBadge({ score, tier, size = "md" }: { score: number; tier: TierKey; size?: "sm" | "md" | "lg" }) {
  const s = TIER_STYLE[tier] ?? TIER_STYLE.seed;
  const dims = size === "lg" ? "h-16 w-16 text-2xl" : size === "sm" ? "h-9 w-9 text-sm" : "h-12 w-12 text-lg";
  return (
    <div
      className={`${dims} shrink-0 rounded-full border-[3px] ${s.ring} ${s.bg} flex flex-col items-center justify-center leading-none`}
      title={`Investment score: ${score}/100 — Tier: ${s.label}`}
      aria-label={`Investment score ${score} out of 100, tier ${s.label}`}
    >
      <span className={`font-bold ${s.text}`}>{score}</span>
      {size !== "sm" && <span className="text-[8px] text-muted-foreground">/100</span>}
    </div>
  );
}

export function TierChip({ tier }: { tier: TierKey }) {
  const s = TIER_STYLE[tier] ?? TIER_STYLE.seed;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${s.bg} ${s.text}`}>
      {s.emoji} {s.label}
    </span>
  );
}

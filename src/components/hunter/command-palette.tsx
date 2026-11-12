"use client";

import { useEffect } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  LayoutDashboard,
  Swords,
  Target,
  Satellite,
  Dna,
  Search,
  Bookmark,
  History,
  Sun,
  Moon,
} from "lucide-react";
import { useTheme } from "next-themes";
import type { TabKey } from "@/lib/hunter-store";
import { RECIPES, type Recipe } from "@/lib/hunter-recipes";

export interface PaletteActions {
  onNavigate: (tab: TabKey) => void;
  onRecipe: (r: Recipe) => void;
  onAnalyze: (owner: string, repo: string) => void;
}

const NAV: { tab: TabKey; label: string; icon: typeof Search; hint: string }[] = [
  { tab: "home", label: "Home — Dashboard", icon: LayoutDashboard, hint: "Status overview, KPIs, quick actions" },
  { tab: "live", label: "Live Hunt", icon: Swords, hint: "Autonomous 8-stage kill chain" },
  { tab: "mission", label: "Missions", icon: Target, hint: "Mission compilation + autopilot" },
  { tab: "sweep", label: "Deep Sweep", icon: Satellite, hint: "Full intelligence operation + review" },
  { tab: "genesis", label: "Genesis — DNA Library", icon: Dna, hint: "Mining, chimeras, codex" },
  { tab: "search", label: "Search", icon: Search, hint: "repos + code, real-model gate" },
  { tab: "watchlist", label: "Watchlist", icon: Bookmark, hint: "Source repos + battle synthesis" },
  { tab: "history", label: "History", icon: History, hint: "Past searches to rerun" },
];

const QUICK_ANALYZE: { owner: string; repo: string; label: string }[] = [
  { owner: "storytold", repo: "craft-anything", label: "Analyze: storytold/craft-anything" },
  { owner: "public-apis", repo: "public-apis", label: "Analyze: public-apis/public-apis" },
];

export function CommandPalette({
  open,
  setOpen,
  actions,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  actions: PaletteActions;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  // Ctrl+K / ⌘K toggles the palette from anywhere
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(!open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [open, setOpen]);

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Where to go? What to analyze? (search in English)" />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>No matching action found</CommandEmpty>
        <CommandGroup heading="Navigation">
          {NAV.map((n) => (
            <CommandItem key={n.tab} value={`${n.label} ${n.hint} ${n.tab}`} onSelect={() => run(() => actions.onNavigate(n.tab))}>
              <n.icon className="ml-2 h-4 w-4" />
              <span className="flex-1">{n.label}</span>
              <span className="hidden text-[10px] text-muted-foreground sm:inline">{n.hint}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Preset Search Recipes">
          {RECIPES.map((r) => (
            <CommandItem
              key={r.id}
              value={`${r.title} ${r.desc} recipe ${r.id}`}
              onSelect={() => {
                if (r.analyze) run(() => actions.onAnalyze(r.analyze!.owner, r.analyze!.repo));
                else run(() => actions.onRecipe(r));
              }}
            >
              <span className="ml-1">{r.emoji}</span>
              <span className="flex-1">{r.title}</span>
              <span className="hidden text-[10px] text-muted-foreground sm:inline">{r.desc}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Quick Analyze">
          {QUICK_ANALYZE.map((q) => (
            <CommandItem key={q.repo} value={q.label} onSelect={() => run(() => actions.onAnalyze(q.owner, q.repo))}>
              <Search className="ml-2 h-4 w-4" />
              <span>{q.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="System">
          <CommandItem value="display mode dark light theme" onSelect={() => setTheme(dark ? "light" : "dark")}>
            {dark ? <Sun className="ml-2 h-4 w-4" /> : <Moon className="ml-2 h-4 w-4" />}
            {dark ? "Switch to light mode" : "Switch to dark mode"}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

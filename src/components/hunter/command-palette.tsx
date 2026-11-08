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
  { tab: "home", label: "בית — לוח מחוונים", icon: LayoutDashboard, hint: "סקירת מצב, KPI, פעולות מהירות" },
  { tab: "live", label: "ציד חי", icon: Swords, hint: "שרשרת הרג אוטונומית 8 שלבים" },
  { tab: "mission", label: "מבצעים", icon: Target, hint: "הידור משימות + טייס אוטומטי" },
  { tab: "sweep", label: "סריקת עומק", icon: Satellite, hint: "מבצע מודיעין מלא + ביקורת" },
  { tab: "genesis", label: "Genesis — ספריית DNA", icon: Dna, hint: "כרייה, כימרות, קודקס" },
  { tab: "search", label: "חיפוש", icon: Search, hint: "repos + code עם סף 5.5+" },
  { tab: "watchlist", label: "נשמרים", icon: Bookmark, hint: "מאגרי המקורות + סינתזת קרב" },
  { tab: "history", label: "היסטוריה", icon: History, hint: "חיפושים קודמים להרצה חוזרת" },
];

const QUICK_ANALYZE: { owner: string; repo: string; label: string }[] = [
  { owner: "storytold", repo: "craft-anything", label: "נתח: storytold/craft-anything" },
  { owner: "public-apis", repo: "public-apis", label: "נתח: public-apis/public-apis" },
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
      <CommandInput placeholder="לאן ללכת? מה לנתח? (חיפוש בעברית או אנגלית)" />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>לא נמצאה פעולה מתאימה</CommandEmpty>
        <CommandGroup heading="ניווט">
          {NAV.map((n) => (
            <CommandItem key={n.tab} value={`${n.label} ${n.hint} ${n.tab}`} onSelect={() => run(() => actions.onNavigate(n.tab))}>
              <n.icon className="ml-2 h-4 w-4" />
              <span className="flex-1">{n.label}</span>
              <span className="hidden text-[10px] text-muted-foreground sm:inline">{n.hint}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="מתכוני חיפוש מוכנים">
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
        <CommandGroup heading="ניתוח מהיר">
          {QUICK_ANALYZE.map((q) => (
            <CommandItem key={q.repo} value={q.label} onSelect={() => run(() => actions.onAnalyze(q.owner, q.repo))}>
              <Search className="ml-2 h-4 w-4" />
              <span>{q.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="מערכת">
          <CommandItem value="מצב תצוגה כהה בהיר theme dark light" onSelect={() => setTheme(dark ? "light" : "dark")}>
            {dark ? <Sun className="ml-2 h-4 w-4" /> : <Moon className="ml-2 h-4 w-4" />}
            {dark ? "עבור למצב בהיר" : "עבור למצב כהה"}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

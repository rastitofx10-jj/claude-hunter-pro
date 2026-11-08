"use client";

import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/hooks/use-hydrated";

/**
 * Light/dark switch. The whole app ships dark:* variants everywhere but never
 * had an actual toggle (round 4: the README promised כהה/בהיר — now it exists).
 * Hydration flag comes from the shared use-hydrated hook (no setState-in-effect).
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useHydrated();
  if (!mounted) {
    return <Button variant="ghost" size="sm" className="h-9 w-9 p-0" aria-label="מצב תצוגה" />;
  }
  const dark = resolvedTheme === "dark";
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-9 w-9 p-0"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={dark ? "עבור למצב בהיר" : "עבור למצב כהה"}
      title={dark ? "עבור למצב בהיר" : "עבור למצב כהה"}
    >
      {dark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
    </Button>
  );
}

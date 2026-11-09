"use client";

import { Star, GitFork, Clock, ExternalLink, Search, BookmarkPlus, BookmarkCheck } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { enUS } from "date-fns/locale";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScoreBadge } from "./score-badge";
import type { ScoredRepo } from "@/lib/hunter-types";

const LANG_COLORS: Record<string, string> = {
  TypeScript: "#3178c6", JavaScript: "#f1e05a", Python: "#3572A5", Rust: "#dea584",
  Go: "#00ADD8", Java: "#b07219", "C#": "#178600", Ruby: "#701516", PHP: "#4F5D95",
  "C++": "#f34b7d", C: "#555555", Swift: "#F05138", Kotlin: "#A97BFF", Shell: "#89e051",
  HTML: "#e34c26", CSS: "#563d7c", Vue: "#41b883", "Jupyter Notebook": "#DA5B0B",
  Clojure: "#db5855", Elixir: "#6e4a7e", Lua: "#000080", Scala: "#c22d40",
  Haskell: "#5e5086", Dart: "#00B4AB", MDX: "#fcb32c", Zig: "#ec915c",
};

export function RepoCard({
  item,
  onAnalyze,
  onSave,
  saved,
  saving,
}: {
  item: ScoredRepo;
  onAnalyze: () => void;
  onSave?: () => void;
  saved?: boolean;
  saving?: boolean;
}) {
  const updated = item.pushedAt
    ? formatDistanceToNow(new Date(item.pushedAt), { addSuffix: true, locale: enUS })
    : "unknown";
  const langColor = item.language ? LANG_COLORS[item.language] : undefined;
  const isPrivatePerson = item.owner?.type === "User";

  return (
    <Card className="group flex h-full flex-col transition-all hover:shadow-md hover:-translate-y-0.5">
      <CardContent className="flex h-full flex-col gap-3 p-4">
        {/* header */}
        <div className="flex items-start gap-3">
          <ScoreBadge score={item.score} tier={item.tier} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <a
                href={item.htmlUrl}
                target="_blank"
                rel="noreferrer"
                dir="ltr"
                className="truncate font-semibold hover:text-orange-600 hover:underline"
              >
                {item.fullName}
              </a>
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                {isPrivatePerson ? "Individual 👤" : "Organization 🏢"}
              </Badge>
              {item.archived && (
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">Archived</Badge>
              )}
            </div>
            <p className="mt-1 line-clamp-2 min-h-8 text-xs text-muted-foreground" dir="auto">
              {item.description || "No description"}
            </p>
          </div>
        </div>

        {/* stats */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
            {item.stars.toLocaleString()}
          </span>
          <span className="inline-flex items-center gap-1">
            <GitFork className="h-3.5 w-3.5" />
            {item.forks.toLocaleString()}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            {updated}
          </span>
          {item.language && (
            <span className="inline-flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: langColor ?? "#a1a1aa" }} />
              {item.language}
            </span>
          )}
        </div>

        {/* reasons */}
        {item.reasons.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {item.reasons.slice(0, 3).map((r) => (
              <Badge key={r} variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
                {r}
              </Badge>
            ))}
          </div>
        )}

        {/* topics */}
        {(item.topics?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1" dir="ltr">
            {item.topics!.slice(0, 4).map((t) => (
              <span key={t} className="rounded bg-orange-50 px-1.5 py-0.5 font-mono text-[10px] text-orange-700 dark:bg-orange-950/40 dark:text-orange-300">
                #{t}
              </span>
            ))}
          </div>
        )}

        {/* code matches */}
        {(item.matches?.length ?? 0) > 0 && (
          <div className="rounded-md bg-muted/60 p-2 text-[10px]" dir="ltr">
            {item.matches!.map((m) => (
              <a
                key={m.path}
                href={m.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="block truncate font-mono text-muted-foreground hover:text-orange-600 hover:underline"
              >
                {m.path}
              </a>
            ))}
            {(item.matchCount ?? 0) > item.matches!.length && (
              <span className="text-[10px] text-muted-foreground">+{item.matchCount! - item.matches!.length} more files</span>
            )}
          </div>
        )}

        {/* actions */}
        <div className="mt-auto flex items-center gap-1.5 pt-1">
          <Button size="sm" onClick={onAnalyze} className="h-8 flex-1 gap-1.5 text-xs">
            <Search className="h-3.5 w-3.5" />
            Deep analysis
          </Button>
          {onSave && (
            <Button size="sm" variant="outline" onClick={onSave} disabled={saving || saved} className="h-8 gap-1.5 text-xs">
              {saved ? <BookmarkCheck className="h-3.5 w-3.5 text-emerald-600" /> : <BookmarkPlus className="h-3.5 w-3.5" />}
              {saved ? "Saved" : "Save"}
            </Button>
          )}
          <Button size="sm" variant="ghost" asChild className="h-8 w-8 p-0">
            <a href={item.htmlUrl} target="_blank" rel="noreferrer" aria-label="Open on GitHub">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// Shared types between backend routes and frontend (Claude Hunter)

export type TierKey = "elite" | "gold" | "silver" | "bronze" | "seed";

export interface RepoOwner {
  login: string;
  type?: string;
  avatar_url?: string;
}

export interface RepoCore {
  id?: number;
  fullName: string;
  owner?: RepoOwner;
  htmlUrl: string;
  description?: string | null;
  stars: number;
  forks: number;
  watchers?: number;
  openIssues?: number;
  language?: string | null;
  topics?: string[];
  pushedAt?: string;
  createdAt?: string;
  size?: number;
  archived?: boolean;
  license?: string | null;
  defaultBranch?: string;
}

export interface CodeMatch {
  path: string;
  htmlUrl: string;
}

export interface ScoredRepo extends RepoCore {
  score: number;
  tier: TierKey;
  reasons: string[];
  matches?: CodeMatch[];
  matchCount?: number;
}

export interface SearchBody {
  mode: "repos" | "code";
  query?: string;
  topics?: string[];
  language?: string;
  minStars?: number;
  pushedWithinDays?: number;
  model?: string;
  hasClaudeMd?: boolean;
  ownerType?: "any" | "user" | "org";
  sort?: "best" | "stars" | "forks" | "updated";
  page?: number;
  perPage?: number;
}

export interface SearchResponse {
  mode: "repos" | "code";
  totalMatches: number;
  repoCount?: number;
  items: ScoredRepo[];
  note?: string;
  querySent: string;
  /** Number of repos hidden because only 4.x-and-below models were detected in them (the full blocking rule) */
  blockedHidden?: number;
  /** false in code mode — GitHub code search does not support real pagination (100 results per query) */
  canPaginate?: boolean;
  /** The search index is partial for this query (incomplete_results=true from GitHub) */
  incompleteResults?: boolean;
}

export interface ModelHit {
  id: string;
  label: string;
  weight: number;
  sources: string[];
  hits?: number;
  version?: number;
  /** false = not a qualifying model (below the 5.5+ threshold or unverified) — weight 0, not counted in the score */
  qualifying: boolean;
}

export interface EvidenceItem {
  kind: string;
  label: string;
  weight: number;
  detail?: string;
  url?: string;
}

export interface ClaudeFileInfo {
  path: string;
  kind: string;
  url: string;
}

export interface AnalyzeResponse {
  repo: RepoCore;
  score: {
    total: number;
    tier: TierKey;
    modelScore: number; // max 45 — real qualifying models only
    paidScore: number; // max 30
    tractionScore: number; // max 25
    usageScore: number; // max 15
    /** true only if at least one qualifying registered model was detected */
    meetsModelThreshold: boolean;
  };
  models: ModelHit[];
  evidence: EvidenceItem[];
  claudeFiles: ClaudeFileInfo[];
  commands: string[];
  agents: string[];
  mcpServers: string[];
  languages: { name: string; pct: number }[];
  contributors: number;
  readmeExcerpt?: string;
  mentions: { prices: string[]; tokens: string[]; claudeCode: number; builtWithClaude: boolean };
  insights: string[];
  warnings: string[];
  analyzedAt: string;
}

export interface WatchItem {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  url: string;
  description?: string | null;
  stars: number;
  score: number;
  models?: string | null;
  evidence?: string | null;
  notes?: string | null;
  createdAt: string;
}

export interface HistoryItem {
  id: number;
  mode: string;
  query: string;
  filters?: string | null;
  resultCount: number;
  createdAt: string;
}

export interface RateWindow {
  limit: number;
  remaining: number;
  used: number;
  reset: number;
}

export interface RateInfo {
  hasToken: boolean;
  error?: string;
  core?: RateWindow;
  search?: RateWindow;
  codeSearch?: RateWindow;
}

// ============================================================
// AI intelligence layer — closes the loop from "finding" to "decision"
// ============================================================

/** A "what to steal" idea — a proven advantage worth adopting into our interface */
export interface StealIdea {
  what: string;
  why: string;
  how?: string;
}

/** Their gap = our opportunity */
export interface BetterMove {
  gap: string;
  ourMove: string;
}

/** AI intelligence report for a single repo */
export interface RepoIntel {
  /** A strategic verdict in 1-2 sentences */
  verdict: string;
  /** Investment-depth assessment: certain / likely / weak + rationale */
  moneyVerdict: string;
  moneyLevel: "certain" | "likely" | "weak" | "unknown";
  whatTheyBuilt: string[];
  brilliant: string[];
  stealThis: StealIdea[];
  doBetter: BetterMove[];
  actionItems: string[];
  riskNotes: string[];
  generatedAt: string;
}

/** A cross-project pattern the AI identified in the synthesis */
export interface SynthPattern {
  pattern: string;
  repos: string[];
  insight: string;
}

/** A recommended strategic move for our product */
export interface TopMove {
  move: string;
  why: string;
  effort: "low" | "medium" | "high" | "unknown";
}

/** Battle synthesis — cross-repo intelligence from the entire watchlist */
export interface BattleSynthesis {
  execSummary: string;
  patterns: SynthPattern[];
  stackConsensus: string[];
  topMoves: TopMove[];
  differentiators: string[];
  battlePlan: string[];
  generatedAt: string;
}

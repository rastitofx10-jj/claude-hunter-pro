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
  /** מספר מאגרים שהוסתרו כי זוהו בהם רק מודלי 4.x ומטה (חוק החסימה המלאה) */
  blockedHidden?: number;
  /** false במצב קוד — GitHub code search לא מאפשר עימוד אמיתי (100 תוצאות לשאילתה) */
  canPaginate?: boolean;
  /** אינדקס החיפוש חלקי לשאילתה (incomplete_results=true מ-GitHub) */
  incompleteResults?: boolean;
}

export interface ModelHit {
  id: string;
  label: string;
  weight: number;
  sources: string[];
  hits?: number;
  version?: number;
  /** false = מודל חסום (מתחת לסף 5.5, כולל משפחת 4.x) — משקל 0 ולא נכלל בציון */
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
    modelScore: number; // max 45 — רק מודלים מזכים (5.5+)
    paidScore: number; // max 30
    tractionScore: number; // max 25
    usageScore: number; // max 15
    /** true רק אם זוהה לפחות מודל אחד ≥5.5 */
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
// שכבת מודיעין AI — סוגרת את הלולאה מ"מציאה" ל"החלטה"
// ============================================================

/** רעיון "מה לגנוב" — יתרון מוכח שכדאי לאמץ בממשק שלנו */
export interface StealIdea {
  what: string;
  why: string;
  how?: string;
}

/** פער שלהם = הזדמנות שלנו */
export interface BetterMove {
  gap: string;
  ourMove: string;
}

/** דוח מודיעין AI עבור מאגר בודד */
export interface RepoIntel {
  /** פסק דין אסטרטגי במשפט-שניים */
  verdict: string;
  /** הערכת עומק ההשקעה: בטוח / סביר / חלש + נימוק */
  moneyVerdict: string;
  moneyLevel: "בטוח" | "סביר" | "חלש" | "לא ידוע";
  whatTheyBuilt: string[];
  brilliant: string[];
  stealThis: StealIdea[];
  doBetter: BetterMove[];
  actionItems: string[];
  riskNotes: string[];
  generatedAt: string;
}

/** דפוס חוצה-פרויקטים שה-AI זיהה בסינתזה */
export interface SynthPattern {
  pattern: string;
  repos: string[];
  insight: string;
}

/** מהלך אסטרטגי מומלץ למוצר שלנו */
export interface TopMove {
  move: string;
  why: string;
  effort: "נמוך" | "בינוני" | "גבוה" | "לא ידוע";
}

/** סינתזת קרב — מודיעין חוצה-ריפואים מכל רשימת המעקב */
export interface BattleSynthesis {
  execSummary: string;
  patterns: SynthPattern[];
  stackConsensus: string[];
  topMoves: TopMove[];
  differentiators: string[];
  battlePlan: string[];
  generatedAt: string;
}

"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import {
  BrainCircuit,
  CheckCircle2,
  FileText,
  Languages,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Send,
  Sparkles,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-client";
import { useHunterStore } from "@/lib/hunter-store";
import { formatDistanceToNow } from "date-fns";

// ============================================================
// Round 15 — Operator Intel: the user's uploaded chats become
// field reports. This panel is the two-way organ:
//   1. Ingest upload/*.txt chats → DNA genes born (license "self")
//   2. Ask the Hunter — a sharp answer grounded in the whole
//      library (mined + field + chat-born genes), in the
//      question's language.
// Palette: the app's stone/amber/emerald accents — no indigo/blue.
// ============================================================

interface ChatFileMeta {
  fileName: string;
  bytes: number;
  mtime: string;
  state: "pending" | "ingesting" | "ingested" | "failed" | "duplicate";
  language: string | null;
  summary: string | null;
  genesBorn: number;
  error: string | null;
  duplicateOf: string | null;
}

interface ChatsResponse {
  files: ChatFileMeta[];
  stats: { files: number; ingested: number; pending: number; genesBorn: number; chatsKnown: number };
}

interface IngestOneResponse {
  ok: true;
  result: {
    fileName: string;
    language: string;
    summary: string;
    genesBorn: number;
    geneNames: string[];
    truncated: boolean;
  };
}

interface IngestAllResponse {
  ok: true;
  results: { fileName: string; status: "ingested" | "duplicate" | "failed"; genesBorn?: number; error?: string }[];
}

interface AskResponse {
  ok: true;
  answer: string;
  usedGenes: { name: string; source: string }[];
  stats: { totalGenes: number; fieldGenes: number; chatGenes: number; huntsDone: number };
}

const stateBadge: Record<ChatFileMeta["state"], { label: string; className: string }> = {
  pending: { label: "Pending", className: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300" },
  ingesting: { label: "Ingesting", className: "border-orange-300 bg-orange-50 text-orange-800 dark:border-orange-800 dark:bg-orange-950/50 dark:text-orange-300" },
  ingested: { label: "Learned", className: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" },
  failed: { label: "Failed", className: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-300" },
  duplicate: { label: "Duplicate", className: "border-stone-300 bg-stone-100 text-stone-600 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400" },
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function OperatorIntelPanel() {
  const token = useHunterStore((s) => s.token);
  const qc = useQueryClient();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskResponse | null>(null);

  const chats = useQuery({
    queryKey: ["intel-chats"],
    queryFn: () => apiFetch<ChatsResponse>("/api/intel/chats", token),
    refetchInterval: 15_000,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["intel-chats"] });
    void qc.invalidateQueries({ queryKey: ["stats"] });
    void qc.invalidateQueries({ queryKey: ["dna-library"] });
  };

  const ingestOne = useMutation({
    mutationFn: (fileName: string) =>
      apiFetch<IngestOneResponse>("/api/intel/chats", token, {
        method: "POST",
        body: JSON.stringify({ action: "ingest", fileName }),
      }),
    onSuccess: (data) => {
      invalidate();
      const r = data.result;
      toast({
        title: r.genesBorn > 0 ? `Chat learned — ${r.genesBorn} gene${r.genesBorn === 1 ? "" : "s"} born 🧬` : "Chat learned — no durable DNA found (honest zero)",
        description: r.summary?.slice(0, 140),
      });
    },
    onError: (e: Error) => toast({ title: "Ingestion failed", description: e.message, variant: "destructive" }),
  });

  const ingestAll = useMutation({
    mutationFn: () =>
      apiFetch<IngestAllResponse>("/api/intel/chats", token, {
        method: "POST",
        body: JSON.stringify({ action: "ingest-all" }),
      }),
    onSuccess: (data) => {
      invalidate();
      const learned = data.results.filter((r) => r.status === "ingested");
      const dup = data.results.filter((r) => r.status === "duplicate").length;
      const failed = data.results.filter((r) => r.status === "failed");
      const genes = learned.reduce((a, r) => a + (r.genesBorn ?? 0), 0);
      toast({
        title: `Ingestion sweep: ${learned.length} chat${learned.length === 1 ? "" : "s"} learned, ${genes} genes born`,
        description: [
          dup > 0 ? `${dup} duplicate skipped` : null,
          failed.length > 0 ? `${failed.length} failed (${failed[0].error?.slice(0, 80) ?? "unknown"})` : null,
          learned.length + dup + failed.length === 0 ? "nothing pending — every chat is already learned" : null,
        ]
          .filter(Boolean)
          .join(" · "),
      });
    },
    onError: (e: Error) => toast({ title: "Ingestion sweep failed", description: e.message, variant: "destructive" }),
  });

  const ask = useMutation({
    mutationFn: (q: string) =>
      apiFetch<AskResponse>("/api/intel/ask", token, {
        method: "POST",
        body: JSON.stringify({ question: q }),
      }),
    onSuccess: (data) => {
      setAnswer(data);
      void qc.invalidateQueries({ queryKey: ["intel-chats"] });
    },
    onError: (e: Error) => toast({ title: "The answer organ failed", description: e.message, variant: "destructive" }),
  });

  const stats = chats.data?.stats;
  const files = chats.data?.files ?? [];
  const pendingCount = files.filter((f) => f.state === "pending").length;
  const anyBusy = ingestOne.isPending || ingestAll.isPending;

  return (
    <div className="space-y-5">
      {/* ---------- header ---------- */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <MessageSquareText className="h-5 w-5 text-orange-600" aria-hidden />
            Operator Intel
            <span className="text-xs font-medium text-muted-foreground">— your chats become the hunter's field reports</span>
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Every chat log you drop into <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]" dir="ltr">upload/*.txt</code>{" "}
            is scanned here. Ingestion distills the durable lessons into DNA genes (born as our own IP —{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]" dir="ltr">license: self</code>) that feed every future
            hunt, mission and synthesis. Identical uploads are deduplicated by content hash.
          </p>
        </div>
        <Button
          onClick={() => ingestAll.mutate()}
          disabled={anyBusy || (pendingCount === 0 && !chats.isLoading)}
          className="gap-1.5"
        >
          {ingestAll.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Ingest all pending{pendingCount > 0 ? ` (${pendingCount})` : ""}
        </Button>
      </div>

      {/* ---------- stats row ---------- */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: "Chats detected", value: stats?.files ?? files.length, icon: FileText, tone: "text-stone-600 dark:text-stone-300" },
          { label: "Chats learned", value: stats?.ingested ?? 0, icon: CheckCircle2, tone: "text-emerald-600 dark:text-emerald-300" },
          { label: "Genes born from chats", value: stats?.genesBorn ?? 0, icon: BrainCircuit, tone: "text-orange-600 dark:text-orange-300" },
          { label: "Pending ingestion", value: stats?.pending ?? pendingCount, icon: RefreshCw, tone: "text-amber-600 dark:text-amber-300" },
        ].map((s) => (
          <Card key={s.label} className="py-4">
            <CardContent className="flex items-center gap-3 px-4">
              <s.icon className={`h-5 w-5 shrink-0 ${s.tone}`} aria-hidden />
              <div className="min-w-0">
                <div className="text-xl font-bold tabular-nums leading-none">{s.value}</div>
                <div className="mt-1 truncate text-[11px] text-muted-foreground">{s.label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ---------- chat files ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            <span className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-orange-600" aria-hidden /> Field chats
            </span>
            <Button variant="ghost" size="sm" className="gap-1.5 px-2" onClick={() => void chats.refetch()} disabled={chats.isFetching}>
              <RefreshCw className={`h-3.5 w-3.5 ${chats.isFetching ? "animate-spin" : ""}`} aria-hidden />
              Rescan
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {chats.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="h-20 animate-pulse rounded-xl border bg-muted/40" />
              ))}
            </div>
          ) : files.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">
              <p className="text-3xl">💬</p>
              <p className="mt-2 font-medium">No chat files detected</p>
              <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed">
                Upload your AI chat exports as <code className="font-mono text-xs" dir="ltr">.txt</code> files — they will appear here
                the moment you rescan. The hunter learns from every conversation you feed it.
              </p>
            </div>
          ) : (
            <ScrollArea className="max-h-96 pr-3">
              <ul className="space-y-2.5">
                {files.map((f) => {
                  const badge = stateBadge[f.state];
                  const busy = ingestOne.isPending && ingestOne.variables === f.fileName;
                  return (
                    <li key={f.fileName} className="rounded-xl border p-3.5 transition-colors hover:bg-muted/30">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate font-mono text-sm font-medium" dir="ltr" title={f.fileName}>
                              {f.fileName.length > 42 ? `${f.fileName.slice(0, 39)}…` : f.fileName}
                            </span>
                            <Badge variant="outline" className={`px-1.5 py-0 text-[10px] font-semibold ${badge.className}`}>
                              {busy ? "Ingesting…" : badge.label}
                            </Badge>
                            {f.language && (
                              <Badge variant="secondary" className="gap-0.5 px-1.5 py-0 text-[10px]">
                                <Languages className="h-2.5 w-2.5" aria-hidden /> {f.language}
                              </Badge>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                            <span className="tabular-nums">{formatBytes(f.bytes)}</span>
                            {f.mtime && <span>{formatDistanceToNow(new Date(f.mtime), { addSuffix: true })}</span>}
                            {f.genesBorn > 0 && (
                              <span className="font-medium text-emerald-700 dark:text-emerald-300">
                                🧬 {f.genesBorn} gene{f.genesBorn === 1 ? "" : "s"} born
                              </span>
                            )}
                            {f.duplicateOf && <span className="italic">same content as {f.duplicateOf.slice(0, 24)}…</span>}
                          </div>
                          {f.summary && (
                            <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{f.summary}</p>
                          )}
                          {f.error && (
                            <p className="mt-1.5 flex items-start gap-1 text-xs text-rose-600 dark:text-rose-400">
                              <XCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> {f.error.slice(0, 160)}
                            </p>
                          )}
                        </div>
                        {(f.state === "pending" || f.state === "failed") && (
                          <Button
                            size="sm"
                            variant={f.state === "failed" ? "outline" : "secondary"}
                            className="gap-1.5"
                            disabled={anyBusy}
                            onClick={() => ingestOne.mutate(f.fileName)}
                          >
                            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                            {f.state === "failed" ? "Retry" : "Learn"}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* ---------- ask the hunter ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BrainCircuit className="h-4 w-4 text-orange-600" aria-hidden />
            Ask the Hunter
            <span className="text-xs font-medium text-muted-foreground">
              — sharp answers grounded in {answer?.stats.totalGenes ?? "the whole"}-gene library
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="שאל את הצייד שאלה חדה… / Ask the hunter anything — it answers in your language, armed with everything it has learned from GitHub, its own hunts, and your chats."
              className="min-h-[72px] flex-1 resize-y text-sm"
              dir="auto"
              maxLength={4000}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  if (question.trim() && !ask.isPending) ask.mutate(question.trim());
                }
              }}
            />
            <Button
              onClick={() => question.trim() && ask.mutate(question.trim())}
              disabled={ask.isPending || !question.trim()}
              className="gap-1.5 sm:self-stretch"
            >
              {ask.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {ask.isPending ? "Thinking…" : "Ask"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Ctrl+Enter to send. The answer cites the library genes it used — no bluffing.
          </p>

          {ask.isPending && (
            <div className="space-y-2">
              <Progress value={100} className="h-1 animate-pulse" />
              <p className="text-xs text-muted-foreground">
                Retrieving field genes · scoring against the question · composing the sharp answer…
              </p>
            </div>
          )}

          {answer && !ask.isPending && (
            <div className="rounded-xl border bg-muted/20 p-4">
              <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="font-medium">Grounded in:</span>
                {answer.usedGenes.length === 0 ? (
                  <span className="italic">no library gene matched — answered from the organ's own knowledge</span>
                ) : (
                  answer.usedGenes.slice(0, 6).map((g) => (
                    <Badge key={`${g.source}/${g.name}`} variant="secondary" className="max-w-[220px] truncate px-1.5 py-0 font-mono text-[10px]">
                      {g.name}
                    </Badge>
                  ))
                )}
                <span className="ms-auto tabular-nums">
                  {answer.stats.totalGenes} genes · {answer.stats.chatGenes} chat-born · {answer.stats.huntsDone} hunts done
                </span>
              </div>
              <div className="prose prose-stone dark:prose-invert prose-sm max-w-none overflow-x-auto text-sm leading-relaxed [&_pre]:overflow-x-auto">
                <ReactMarkdown>{answer.answer}</ReactMarkdown>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

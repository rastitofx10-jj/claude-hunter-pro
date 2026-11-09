"use client";

import { useState } from "react";
import { KeyRound, ExternalLink, CheckCircle2, XCircle, Loader2, Trash2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHunterStore } from "@/lib/hunter-store";
import { apiFetch, SERVER_TOKEN } from "@/lib/api-client";
import type { RateInfo } from "@/lib/hunter-types";

interface ServerTokenInfo {
  exists: boolean;
  masked: string | null;
  updatedAt: string | null;
}

export function TokenDialog({ trigger }: { trigger?: React.ReactNode }) {
  const { token, setToken } = useHunterStore();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [test, setTest] = useState<{ loading: boolean; ok?: boolean; info?: RateInfo }>({ loading: false });
  const [saveError, setSaveError] = useState<string | null>(null);
  // Masked from the server — the client holds only the sentinel; previously the first 8 characters of the raw PAT were shown from the store
  const { data: serverInfo } = useQuery({
    queryKey: ["server-token"],
    queryFn: () => apiFetch<ServerTokenInfo>("/api/settings/token", ""),
    staleTime: 30_000,
    retry: 1,
  });

  // Reset local state on close — previously draft/test persisted between dialog openings
  // (in onOpenChange, not an effect — no cascading rerender)
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setDraft("");
      setTest({ loading: false });
      setSaveError(null);
    }
  };

  const runTest = async (t: string): Promise<boolean> => {
    setTest({ loading: true });
    try {
      const info = await apiFetch<RateInfo>("/api/rate-limit", t);
      const ok = !info.error;
      setTest({ loading: false, ok, info });
      return ok;
    } catch (e) {
      setTest({ loading: false, ok: false, info: { hasToken: false, error: e instanceof Error ? e.message : "Error" } });
      return false;
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" className="gap-1.5">
            <KeyRound className="h-4 w-4" />
            GitHub token
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>GitHub Token — Required for Full Power</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm leading-relaxed">
              <p>
                Without a token: only 60 requests/hour, and <b>code search is completely unavailable</b>. With a (free) token: 5,000 requests/hour + code search + deep analysis.
              </p>
              <a
                href="https://github.com/settings/tokens?type=beta"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-orange-600 hover:underline"
              >
                Create a token on GitHub (30 seconds) <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <p className="text-xs text-muted-foreground">
                No special permissions are needed for public repos. The token is stored only on the local server — not in the browser — and is sent only to GitHub.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-2" dir="ltr">
            <Input
              placeholder="github_pat_... / ghp_..."
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              // Test first, save only then — a bad token never enters the store and doesn't pollute
              // all subsequent requests (previously: an immediate setToken before any validation)
              onClick={async () => {
                const t = draft.trim();
                if (!t) return;
                const ok = await runTest(t);
                if (!ok) return;
                // Test passed = the token works against GitHub. Explicit save on the server
                // (the captureTokenFrom bug was fixed, but here it's explicit and unambiguous).
                // The client switches to the sentinel only — the raw PAT never enters state/localStorage.
                try {
                  const res = await fetch("/api/settings/token", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: t }),
                  });
                  const info = (await res.json().catch(() => null)) as ServerTokenInfo | null;
                  if (info?.exists) {
                    setToken(SERVER_TOKEN);
                    setSaveError(null);
                    setDraft("");
                  } else {
                    setSaveError("Verification passed but saving to the server failed — try again");
                  }
                } catch {
                  setSaveError("Verification passed but saving to the server failed — try again");
                }
              }}
              disabled={test.loading || !draft.trim()}
              className="gap-1.5"
            >
              {test.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Test & save
            </Button>
            {token && (
              <Button
                size="sm"
                variant="destructive"
                className="gap-1.5"
                onClick={async () => {
                  // Double delete: server + client — previously the button only deleted from the store while the server kept it
                  try {
                    await fetch("/api/settings/token", { method: "DELETE" });
                  } catch {
                    // best-effort
                  }
                  setToken("");
                  setDraft("");
                  setTest({ loading: false });
                }}
              >
                <Trash2 className="h-4 w-4" /> Clear saved token
              </Button>
            )}
            {token && !draft && (
              <Button size="sm" variant="secondary" onClick={() => void runTest(token)} disabled={test.loading}>
                Test saved token
              </Button>
            )}
          </div>

          {test.info && !test.loading && (
            <div
              className={`rounded-lg border p-3 text-sm ${
                test.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"
              }`}
            >
              {test.ok ? (
                <div className="space-y-1">
                  <p className="flex items-center gap-1.5 font-medium">
                    <CheckCircle2 className="h-4 w-4" /> The token is valid{draft.trim() && token !== draft.trim() ? " — saved to the store" : ""}!
                  </p>
                  {test.info.core && (
                    <p dir="ltr" className="font-mono text-xs">
                      core: {test.info.core.remaining}/{test.info.core.limit} · search: {test.info.search?.remaining}/
                      {test.info.search?.limit} · code: {test.info.codeSearch?.remaining}/{test.info.codeSearch?.limit}
                    </p>
                  )}
                </div>
              ) : (
                <p className="flex items-center gap-1.5">
                  <XCircle className="h-4 w-4" /> {test.info.error ?? "Token rejected"}
                </p>
              )}
            </div>
          )}

          {token && (
            <p className="text-xs text-muted-foreground">
              {serverInfo?.masked ? (
                <>Active token, stored on the server: <span dir="ltr" className="font-mono">{serverInfo.masked}</span></>
              ) : (
                "Active token — stored on the server"
              )}
            </p>
          )}
          {saveError && (
            <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
              {saveError}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

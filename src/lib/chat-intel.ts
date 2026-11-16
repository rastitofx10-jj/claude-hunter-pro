// ============================================================
// Round 15 — Operator Intel: the user's uploaded chats become
// field reports the hunter learns from.
//
// The user's field pattern: they export/paste their own AI chats
// into upload/*.txt ("Pasted Content_*.txt") and expect the hunter
// to USE them — extract every actionable lesson, birth it into the
// DNA library (license "self" — our own IP), and answer follow-up
// questions grounded in everything the hunter knows ("sharp
// response, maximum efficiency").
//
// Laws obeyed here:
//   * born-dna.ts sanitizeBornMeta on every AI-born name/description
//     (one law for every birth path — live-hunt grow, mission report, this)
//   * dedupe by content hash — the same chat uploaded twice (the two
//     identical "Pasted Content" files) is ingested exactly once
//   * genes are English (they feed English compiler/executor prompts);
//     only the conversational ask endpoint answers in the question's language
//   * secrets are never ingested: upload/*.secret files are skipped —
//     they are tokens, not chats
// ============================================================

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { db } from "./db";
import { emitDnaBorn } from "./event-bus";
import { sanitizeBornMeta } from "./born-dna";
import { llmJson, llmText } from "./llm";

export const CHAT_UPLOAD_DIR = process.env.HUNTER_CHAT_DIR ?? "upload";

/** How much of a chat file is sent to the extraction LLM (chars). The two
 * real field files are ~51KB; the tail beyond the cap is noted, not silently dropped. */
const EXTRACT_CAP = 40_000;
/** Max insights birthed per chat — a flood guard against a confused extraction. */
const MAX_INSIGHTS_PER_CHAT = 8;
/** Max field genes fed into an ask-context (name+description+excerpt). */
const ASK_GENE_LIMIT = 12;

export interface ChatFileMeta {
  fileName: string;
  bytes: number;
  fileHash: string;
  mtime: string;
  state: "pending" | "ingesting" | "ingested" | "failed" | "duplicate";
  language: string | null;
  summary: string | null;
  genesBorn: number;
  error: string | null;
  duplicateOf: string | null;
}

export class ChatIntelError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** The chat files currently in upload/ (newest first), joined with their ingestion state. */
export async function scanChatFiles(): Promise<ChatFileMeta[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(CHAT_UPLOAD_DIR, { withFileTypes: true });
  } catch {
    return []; // no upload dir → no chats — not an error
  }
  const names = entries
    .filter((e) => e.isFile() && /\.txt$/i.test(e.name))
    .map((e) => e.name);
  if (names.length === 0) return [];

  const metas: (ChatFileMeta & { mtimeMs: number })[] = [];
  for (const name of names) {
    const full = path.join(CHAT_UPLOAD_DIR, name);
    try {
      const [content, st] = await Promise.all([readFile(full, "utf8"), stat(full)]);
      const hash = sha256(content);
      const row = await db.chatIntel.findFirst({
        where: { fileName: name },
        orderBy: { id: "desc" },
      });
      // dedupe: same content already ingested under another name?
      const twin = row
        ? null
        : await db.chatIntel.findFirst({
            where: { fileHash: hash, status: "ingested" },
            orderBy: { id: "desc" },
          });
      metas.push({
        fileName: name,
        bytes: content.length,
        fileHash: hash,
        mtimeMs: st.mtimeMs,
        mtime: st.mtime.toISOString(),
        state: (row?.status as ChatFileMeta["state"]) ?? (twin ? "duplicate" : "pending"),
        language: row?.language ?? null,
        summary: row?.summary ?? null,
        genesBorn: row?.genesBorn ?? 0,
        error: row?.error ?? null,
        duplicateOf: twin?.fileName ?? null,
      });
    } catch {
      // unreadable file — surfaced as failed, never crashes the scan
      metas.push({
        fileName: name,
        bytes: 0,
        fileHash: "",
        mtimeMs: 0,
        mtime: new Date().toISOString(),
        state: "failed",
        language: null,
        summary: null,
        genesBorn: 0,
        error: "unreadable file",
        duplicateOf: null,
      });
    }
  }
  metas.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return metas.map(({ mtimeMs: _mtimeMs, ...rest }) => rest);
}

/** Aggregate stats for the panel header. */
export async function chatIntelStats(): Promise<{
  files: number;
  ingested: number;
  pending: number;
  genesBorn: number;
  chatsKnown: number;
}> {
  const [rows, geneCount] = await Promise.all([
    db.chatIntel.findMany({ select: { status: true, genesBorn: true } }),
    db.dnaArtifact.count({ where: { sourceRepo: { startsWith: "field:chat-" } } }),
  ]);
  return {
    files: rows.length,
    ingested: rows.filter((r) => r.status === "ingested").length,
    pending: rows.filter((r) => r.status === "pending").length,
    genesBorn: geneCount,
    chatsKnown: rows.filter((r) => r.status === "ingested").reduce((acc, r) => acc + r.genesBorn, 0),
  };
}

interface ExtractedInsight {
  name: string;
  description: string;
  content: string;
}

interface ExtractionResult {
  language: string;
  summary: string;
  insights: ExtractedInsight[];
}

const EXTRACT_SYSTEM = `You are the DNA extraction organ of Claude Hunter — an aggressive capability-intelligence engine.
You receive a raw chat log between a human operator and an AI assistant. Extract the OPERATIONAL KNOWLEDGE:

1. "language" — the dominant language of the conversation (ISO code: "he", "en", "ru", "mixed"...)
2. "summary" — one dense paragraph (max 80 words) describing what this chat was about and what was accomplished.
3. "insights" — up to ${MAX_INSIGHTS_PER_CHAT} actionable lessons worth remembering FOREVER. Each insight:
   - "name" — short kebab-case English handle (max 60 chars), e.g. "token-mirror-survives-db-recycles"
   - "description" — one sharp English sentence (max 200 chars) saying what the lesson teaches
   - "content" — a compact English SKILL.md-style markdown lesson (150-500 words): the principle, why it matters, how to apply it. Concrete and specific — no platitudes.

Rules:
- Only DURABLE knowledge: root causes, patterns, protocols, field facts, verified techniques, failure modes. NOT chat-specific trivia, NOT greetings, NOT pleasantries.
- If the chat teaches nothing durable, return an empty insights array — honesty over noise.
- Never invent facts that are not in the chat.
- Secrets (tokens, keys, passwords) appearing in the chat must NEVER be copied into insights — redact to "<REDACTED>" if contextually unavoidable.`;

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["language", "summary", "insights"],
  properties: {
    language: { type: "string" },
    summary: { type: "string" },
    insights: {
      type: "array",
      maxItems: MAX_INSIGHTS_PER_CHAT,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "content"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          content: { type: "string" },
        },
      },
    },
  },
};

/**
 * Ingest one chat file: extract → birth genes → record. Idempotent per (fileName,
 * hash): a re-ingest of the same content upserts the same genes (stable
 * sourceRepo/path keys) instead of duplicating them.
 */
export async function ingestChat(fileName: string): Promise<{
  fileName: string;
  language: string;
  summary: string;
  genesBorn: number;
  geneNames: string[];
  truncated: boolean;
}> {
  // path traversal guard — fileName comes from the request body
  const safe = path.basename(fileName);
  if (safe !== fileName || !/\.txt$/i.test(safe)) {
    throw new ChatIntelError("Only .txt chat files from the upload folder are accepted", 400);
  }
  const full = path.join(CHAT_UPLOAD_DIR, safe);
  let content: string;
  try {
    content = await readFile(full, "utf8");
  } catch {
    throw new ChatIntelError(`Chat file not found: ${safe}`, 404);
  }
  if (!content.trim()) throw new ChatIntelError(`Chat file is empty: ${safe}`, 400);

  const hash = sha256(content);
  const truncated = content.length > EXTRACT_CAP;
  const feed = truncated ? `${content.slice(0, EXTRACT_CAP)}\n\n[... truncated ${content.length - EXTRACT_CAP} chars ...]` : content;

  // claim the row (pending → ingesting) so two parallel clicks can't double-birth
  await db.chatIntel.upsert({
    where: { fileName: safe },
    create: { fileName: safe, fileHash: hash, bytes: content.length, status: "ingesting" },
    update: { fileHash: hash, bytes: content.length, status: "ingesting", error: null },
  });

  try {
    const raw = await llmJson(EXTRACT_SYSTEM, `CHAT LOG (file: ${safe}):\n\n${feed}`, {
      tier: "balanced",
      effort: "medium",
      maxTokens: 12_000,
      timeoutMs: 240_000,
      timeoutLabel: "chat-intel extraction",
      schema: EXTRACTION_SCHEMA,
    });

    const language = sanitizeBornMeta(raw.language, 12) || "en";
    const summary = sanitizeBornMeta(raw.summary, 600);
    const insights = Array.isArray(raw.insights)
      ? (raw.insights as unknown[])
          .filter((i): i is ExtractedInsight => !!i && typeof i === "object")
          .slice(0, MAX_INSIGHTS_PER_CHAT)
      : [];

    const repoKey = `field:chat-${hash.slice(0, 12)}`;
    const geneNames: string[] = [];
    let born = 0;
    for (let i = 0; i < insights.length; i++) {
      const ins = insights[i];
      // the born-dna law — same as live-hunt grow and mission report paths
      const name = sanitizeBornMeta(ins.name, 60) || `chat-lesson-${i + 1}`;
      const desc = sanitizeBornMeta(ins.description, 200);
      const md = String(ins.content ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, 8000);
      if (!md.trim()) continue; // an insight with no content births nothing — noise guard
      try {
        await db.dnaArtifact.upsert({
          where: { sourceRepo_path: { sourceRepo: repoKey, path: `field/insight-${i + 1}/SKILL.md` } },
          update: { name, description: desc, content: md, size: md.length },
          create: {
            sourceRepo: repoKey,
            path: `field/insight-${i + 1}/SKILL.md`,
            kind: "skill",
            name,
            description: desc,
            content: md,
            size: md.length,
            license: "self", // born from the operator's own field material — our IP
          },
        });
        born++;
        geneNames.push(name);
        emitDnaBorn({ name, source: repoKey, origin: "field", note: `operator chat: ${safe}` });
      } catch (e) {
        console.error(`[chat-intel] gene birth failed for ${safe} insight ${i + 1}:`, e);
      }
    }

    await db.chatIntel.update({
      where: { fileName: safe },
      data: { status: "ingested", language, summary, genesBorn: born, error: null },
    });

    return { fileName: safe, language, summary, genesBorn: born, geneNames, truncated };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "extraction failed";
    await db.chatIntel.update({
      where: { fileName: safe },
      data: { status: "failed", error: msg.slice(0, 500) },
    });
    throw new ChatIntelError(`Chat ingestion failed for ${safe}: ${msg}`, 502);
  }
}

/** Ingest every pending chat (newest first). Duplicates are skipped, not errors. */
export async function ingestAllPending(): Promise<{
  results: { fileName: string; status: "ingested" | "duplicate" | "failed"; genesBorn?: number; error?: string }[];
}> {
  const files = await scanChatFiles();
  const results: { fileName: string; status: "ingested" | "duplicate" | "failed"; genesBorn?: number; error?: string }[] = [];
  for (const f of files) {
    if (f.state === "duplicate") {
      results.push({ fileName: f.fileName, status: "duplicate" });
      continue;
    }
    if (f.state !== "pending") continue;
    try {
      const r = await ingestChat(f.fileName);
      results.push({ fileName: f.fileName, status: "ingested", genesBorn: r.genesBorn });
    } catch (e) {
      results.push({
        fileName: f.fileName,
        status: "failed",
        error: e instanceof Error ? e.message : "unknown error",
      });
    }
  }
  return { results };
}

// ---------- the sharp-answer endpoint ----------

export interface AskContext {
  totalGenes: number;
  fieldGenes: number;
  chatGenes: number;
  huntsDone: number;
}

/** Build the retrieval context: field genes first (our own IP — including the
 * chat-born ones), then a spread of fresh mined genes for breadth. */
async function buildAskContext(question: string): Promise<{
  context: string;
  usedGenes: { name: string; source: string }[];
  stats: AskContext;
}> {
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);
  const [totalGenes, fieldGenes, chatGenes, huntsDone] = await Promise.all([
    db.dnaArtifact.count(),
    db.dnaArtifact.count({ where: { license: "self" } }),
    db.dnaArtifact.count({ where: { sourceRepo: { startsWith: "field:chat-" } } }),
    db.liveHunt.count({ where: { status: "done" } }),
  ]);

  // retrieval: field genes scoring on question-word overlap in name+description+content excerpt
  const field = await db.dnaArtifact.findMany({
    where: { license: "self" },
    orderBy: { updatedAt: "desc" },
    take: 120,
  });
  const scored = field
    .map((g) => {
      const hay = `${g.name} ${g.description ?? ""} ${(g.content ?? "").slice(0, 2000)}`.toLowerCase();
      let score = 0;
      for (const w of words) if (hay.includes(w)) score++;
      return { g, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, ASK_GENE_LIMIT);

  const usedGenes = scored.map(({ g }) => ({ name: g.name, source: g.sourceRepo }));
  const blocks = scored.map(({ g }) => {
    const excerpt = (g.content ?? "").slice(0, 700).trim();
    return `### ${g.name}\nSource: ${g.sourceRepo}${g.description ? `\n${g.description}` : ""}\n${excerpt}`;
  });

  const context = [
    `LIBRARY STATE: ${totalGenes} total genes | ${fieldGenes} field-born (our own IP) | ${chatGenes} born from the operator's chats | ${huntsDone} completed live hunts.`,
    blocks.length ? `RELEVANT FIELD GENES (name + excerpt):\n\n${blocks.join("\n\n---\n\n")}` : "RELEVANT FIELD GENES: none matched the question keywords.",
  ].join("\n\n");

  return { context, usedGenes, stats: { totalGenes, fieldGenes, chatGenes, huntsDone } };
}

const ASK_SYSTEM = `You are Claude Hunter's field answer organ — the sharp, aggressive intelligence layer the operator talks to.
You have absorbed: elite Claude-AI capability DNA mined from GitHub, lessons born from your own autonomous hunts, and field reports extracted from the operator's own chats.

Answer style — the operator's explicit demand is a SHARP answer at MAXIMUM efficiency:
- Lead with the answer. One paragraph of verdict, then the details.
- No filler, no hedging, no "it depends", no restating the question.
- Concrete: numbers, commands, file paths, names — whatever the evidence holds.
- When the library context carries the answer, cite the gene names you used (they are English library artifacts — keep them verbatim).
- When the library does NOT hold the answer, say so in one line, then answer from your own knowledge — never bluff a citation.
- Format: tight markdown. Bold the single most important sentence.`;

/** The sharp answer: grounded in the DNA library + chat-born genes, multilingual. */
export async function askHunter(question: string): Promise<{
  answer: string;
  usedGenes: { name: string; source: string }[];
  stats: AskContext;
}> {
  const q = question.trim();
  if (!q) throw new ChatIntelError("A question is required", 400);
  if (q.length > 4000) throw new ChatIntelError("Question too long (max 4000 chars)", 400);
  const { context, usedGenes, stats } = await buildAskContext(q);
  const answer = await llmText(
    ASK_SYSTEM,
    `${context}\n\n====\nOPERATOR'S QUESTION:\n${q}`,
    {
      tier: "deep",
      effort: "high",
      maxTokens: 8000,
      timeoutMs: 240_000,
      timeoutLabel: "operator-intel answer",
      multilingualAnswer: true, // the sanctioned exception: Hebrew question → Hebrew answer
    }
  );
  if (!answer.trim()) throw new ChatIntelError("The answer organ returned an empty answer", 502);
  return { answer, usedGenes, stats };
}

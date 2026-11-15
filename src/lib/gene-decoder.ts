// ============================================================
// Gene decoder — turns a raw mined file into STRUCTURE.
//
// A gene in the library is text. To assemble genes into something installable (or to compare them)
// the system needs to know what each one actually declares: its frontmatter, the tools it asks for,
// the files it references, the hook events and MCP servers it wires up, the models it pins.
// "Decoding" here means exactly that — deterministic parsing of public, plain-text capability files.
// No network, no AI, no execution of anything inside a gene.
//
// Pure functions only (unit-tested without a DB).
// ============================================================

import { detectClaudeModels } from "./claude-models";

export interface GeneInput {
  id?: number;
  sourceRepo: string;
  path: string;
  kind: string;
  name: string;
  description?: string | null;
  content?: string | null;
  license?: string | null;
  rawUrl?: string | null;
}

export interface DecodedGene {
  sourceRepo: string;
  path: string;
  kind: string;
  name: string;
  description: string | null;
  license: string | null;
  bytes: number;
  /** parsed frontmatter (scalars, inline arrays and `- item` lists) */
  frontmatter: Record<string, string | string[]>;
  /** body without frontmatter */
  body: string;
  headings: string[];
  /** tools the capability asks for (frontmatter allowed-tools / tools) */
  allowedTools: string[];
  /** premium model ids the text pins (qualifying registry models only) */
  modelPins: string[];
  /** relative files the body points at (references/…, scripts/…, assets/…) */
  referencedFiles: string[];
  /** hook events declared (hook-config) */
  hookEvents: string[];
  /** shell commands that hooks would run — surfaced for review, never executed */
  hookCommands: string[];
  /** MCP servers declared (mcp-config / plugin manifest) */
  mcpServers: string[];
  /** commands that MCP servers would launch — surfaced for review, never executed */
  mcpCommands: string[];
  /** problems found while decoding (empty = clean) */
  issues: string[];
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** A deliberately small YAML subset: `key: value`, `key: [a, b]`, and `key:` followed by `- item` lines. */
export function parseFrontmatter(md: string): { data: Record<string, string | string[]>; body: string; ok: boolean } {
  const src = (md ?? "").replace(/^\uFEFF/, "").replace(/^\r?\n+/, "");
  const m = src.match(FM_RE);
  if (!m) return { data: {}, body: src, ok: false };
  const data: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const item = raw.match(/^\s+-\s+(.*)$/) ?? raw.match(/^-\s+(.*)$/);
    if (item && listKey) {
      const arr = data[listKey];
      (Array.isArray(arr) ? arr : (data[listKey] = [])).push(unquote(item[1]));
      continue;
    }
    const kv = raw.match(/^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (val === "" || val === "|" || val === ">") {
      data[key] = val === "" ? [] : "";
      listKey = val === "" ? key : null;
    } else if (val.startsWith("[") && val.endsWith("]")) {
      data[key] = val.slice(1, -1).split(",").map((x) => unquote(x)).filter(Boolean);
      listKey = null;
    } else {
      data[key] = unquote(val);
      listKey = null;
    }
  }
  // a `key:` with no list items is an empty scalar, not an empty list
  for (const [k, v] of Object.entries(data)) if (Array.isArray(v) && v.length === 0) data[k] = "";
  return { data, body: src.slice(m[0].length), ok: true };
}

/** "Read, Grep, Bash(git diff:*)" → ["Read","Grep","Bash(git diff:*)"] (commas inside parentheses are kept). */
export function splitTools(v: string | string[] | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => x.trim()).filter(Boolean);
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const REF_RE = /(?:^|[\s(`"'\[])((?:\.\/)?(?:references?|scripts|assets|resources|templates)\/[A-Za-z0-9._\/-]+\.[A-Za-z0-9]+)/g;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

export function decodeGene(g: GeneInput): DecodedGene {
  const content = g.content ?? "";
  const issues: string[] = [];
  const out: DecodedGene = {
    sourceRepo: g.sourceRepo,
    path: g.path,
    kind: g.kind,
    name: g.name,
    description: g.description ?? null,
    license: g.license ?? null,
    bytes: Buffer.byteLength(content, "utf8"),
    frontmatter: {},
    body: content,
    headings: [],
    allowedTools: [],
    modelPins: [],
    referencedFiles: [],
    hookEvents: [],
    hookCommands: [],
    mcpServers: [],
    mcpCommands: [],
    issues,
  };
  if (!content.trim()) {
    issues.push("empty content");
    return out;
  }

  const isJsonKind = g.kind === "mcp-config" || g.kind === "plugin-manifest" || g.kind === "hook-config";
  if (isJsonKind) {
    const j = safeJson(content);
    if (!isObj(j)) {
      issues.push("not a JSON object");
      return out;
    }
    if (typeof j.description === "string" && !out.description) out.description = j.description;
    // mcpServers (mcp-config, plugin.json, .mcp.json)
    const servers = j.mcpServers;
    if (isObj(servers)) {
      for (const [name, spec] of Object.entries(servers)) {
        out.mcpServers.push(name);
        if (isObj(spec)) {
          const cmd = [spec.command, ...(Array.isArray(spec.args) ? spec.args : [])].filter((x) => typeof x === "string").join(" ");
          if (cmd) out.mcpCommands.push(`${name}: ${cmd}`);
          else if (typeof spec.url === "string") out.mcpCommands.push(`${name}: ${spec.url}`);
        }
      }
    }
    // hooks: { Event: [ { matcher?, hooks: [ { type:"command", command } ] } ] }
    const hooks = j.hooks;
    if (isObj(hooks)) {
      for (const [event, groups] of Object.entries(hooks)) {
        out.hookEvents.push(event);
        if (Array.isArray(groups)) {
          for (const grp of groups) {
            const inner = isObj(grp) && Array.isArray(grp.hooks) ? grp.hooks : [];
            for (const h of inner) if (isObj(h) && typeof h.command === "string") out.hookCommands.push(`${event}: ${h.command}`);
          }
        }
      }
    }
    if (g.kind === "hook-config" && out.hookEvents.length === 0) issues.push("no hooks declared");
    return out;
  }

  // markdown kinds
  const fm = parseFrontmatter(content);
  out.frontmatter = fm.data;
  out.body = fm.body;
  if (g.kind === "skill" || g.kind === "command" || g.kind === "agent") {
    if (!fm.ok) issues.push("no valid frontmatter");
  }
  if (typeof fm.data.description === "string" && fm.data.description && !out.description) out.description = fm.data.description;
  if (typeof fm.data.name === "string" && fm.data.name && (g.kind === "skill" || g.kind === "agent")) out.name = fm.data.name;
  out.allowedTools = splitTools(fm.data["allowed-tools"] ?? fm.data["allowed_tools"] ?? fm.data.tools);
  out.headings = Array.from(fm.body.matchAll(/^#{1,3}\s+(.+)$/gm)).map((m) => m[1].trim()).slice(0, 40);
  const refs = new Set<string>();
  for (const m of fm.body.matchAll(REF_RE)) refs.add(m[1].replace(/^\.\//, ""));
  out.referencedFiles = Array.from(refs).slice(0, 40);
  out.modelPins = detectClaudeModels(`${typeof fm.data.model === "string" ? fm.data.model : ""}\n${content}`).qualifying.map((m) => m.id);
  if (g.kind === "skill") {
    if (!out.description) issues.push("skill has no description (it cannot trigger without one)");
    if (typeof fm.data.name === "string" && fm.data.name.length > 64) issues.push("skill name longer than 64 chars");
  }
  return out;
}

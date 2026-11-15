// ============================================================
// Gene assembler — builds an INSTALLABLE Claude Code plugin from genes in the library.
//
//   skills/<slug>/SKILL.md            ← skill genes (frontmatter normalized, name = directory)
//   skills/<slug>/references/*.md     ← skill-ref genes whose parent skill is in the selection
//   commands/<slug>.md · agents/<slug>.md
//   .mcp.json                         ← merged mcp-config genes        (opt-in: allowExecutables)
//   hooks/hooks.json                  ← merged hook-config genes       (opt-in: allowExecutables)
//   .claude-plugin/plugin.json · README.md · NOTICE.md
//
// Safety and legality rules (deliberate, all reported, none silent):
//   * LICENSES — only permissive SPDX licenses (MIT, Apache-2.0, BSD, ISC, Unlicense, CC0, 0BSD, Zlib,
//     BSL-1.0) and our own born genes ("self") are bundled. Unknown / copyleft / proprietary genes are
//     excluded with the reason, unless acceptLicenseRisk is set (then NOTICE says so loudly).
//   * EXECUTABLES — hooks run shell commands and MCP servers launch processes. They are excluded unless
//     allowExecutables is set, and when included every command is listed in the report for review.
//     `permissions` and `env` blocks inside settings-style configs are never imported.
//   * Nothing inside a gene is executed, fetched or evaluated here.
//   * NOTICE.md credits every included gene with repo, path and license.
//
// Pure function (no DB, no network) — unit-tested.
// ============================================================

import { createHash } from "node:crypto";
import { decodeGene, parseFrontmatter, type DecodedGene, type GeneInput } from "./gene-decoder";
import { hasFrontmatter, repairSkillMdFrontmatter } from "./skill-md";

export const PERMISSIVE_LICENSES = new Set([
  "mit", "apache-2.0", "bsd-2-clause", "bsd-3-clause", "isc", "unlicense", "cc0-1.0", "0bsd", "zlib", "bsl-1.0", "self",
]);

export interface AssembleOptions {
  name: string;
  description?: string;
  version?: string;
  author?: string;
  /** include hook-config and mcp-config genes (they execute commands) */
  allowExecutables?: boolean;
  /** bundle genes whose license is unknown / not permissive */
  acceptLicenseRisk?: boolean;
}

export interface AssembleReport {
  included: { gene: string; component: string }[];
  excluded: { gene: string; reason: string }[];
  conflicts: string[];
  warnings: string[];
  licenses: Record<string, number>;
  /** what would run if the plugin is installed — for human review */
  executables: { hooks: string[]; mcp: string[] };
  toolRequests: string[];
}

export interface AssembleResult {
  ok: boolean;
  files: Record<string, string>;
  report: AssembleReport;
}

const MAX_BUNDLE_BYTES = 2_000_000;
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

export function slugify(s: string, fallback = "gene"): string {
  const t = (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return t || fallback;
}

function uniqueSlug(base: string, taken: Set<string>, conflicts: string[], what: string): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  const s = `${base}-${i}`;
  taken.add(s);
  conflicts.push(`${what} name collision: "${base}" → renamed to "${s}"`);
  return s;
}

const gid = (g: { sourceRepo: string; path: string }) => `${g.sourceRepo}:${g.path}`;
const sha = (s: string) => createHash("sha1").update(s.replace(/\r\n/g, "\n").trim()).digest("hex");
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Force the frontmatter `name:` to the directory slug (adds the line if missing). */
export function setFrontmatterName(md: string, slug: string): string {
  const m = md.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!m) return md;
  const head = m[2];
  const nl = md.includes("\r\n") ? "\r\n" : "\n";
  const has = /^name\s*:.*$/m.test(head);
  const newHead = has ? head.replace(/^name\s*:.*$/m, `name: ${slug}`) : `name: ${slug}${nl}${head}`;
  return md.slice(0, m.index! + m[1].length) + newHead + md.slice(m.index! + m[1].length + head.length);
}

export function assemblePlugin(genes: GeneInput[], opts: AssembleOptions): AssembleResult {
  const report: AssembleReport = {
    included: [],
    excluded: [],
    conflicts: [],
    warnings: [],
    licenses: {},
    executables: { hooks: [], mcp: [] },
    toolRequests: [],
  };
  const fail = (msg: string): AssembleResult => {
    report.warnings.push(msg);
    return { ok: false, files: {}, report };
  };

  if (!PLUGIN_NAME_RE.test(opts.name ?? "")) return fail(`invalid plugin name "${opts.name}" — use 2-49 chars: lowercase letters, digits, hyphens`);
  if (!genes.length) return fail("no genes selected");

  const files: Record<string, string> = {};
  const seenContent = new Map<string, string>();
  const skillSlugs = new Set<string>();
  const cmdSlugs = new Set<string>();
  const agentSlugs = new Set<string>();
  const skillByDir = new Map<string, string>(); // `${repo}:${dir}` → slug
  const licenseUsed = new Map<string, { repo: string; path: string; license: string }[]>();
  const toolSet = new Set<string>();

  const exclude = (g: GeneInput, reason: string) => report.excluded.push({ gene: gid(g), reason });
  const include = (g: GeneInput, d: DecodedGene, component: string) => {
    report.included.push({ gene: gid(g), component });
    const lic = (g.license ?? "unknown").trim() || "unknown";
    report.licenses[lic] = (report.licenses[lic] ?? 0) + 1;
    const arr = licenseUsed.get(gid(g)) ?? [];
    arr.push({ repo: g.sourceRepo, path: g.path, license: lic });
    licenseUsed.set(gid(g), arr);
    for (const t of d.allowedTools) toolSet.add(t);
  };

  // ---- 1. gate: content, duplicates, license ----
  const candidates: { g: GeneInput; d: DecodedGene }[] = [];
  for (const g of genes) {
    if (!g.content || !g.content.trim()) {
      exclude(g, "no content");
      continue;
    }
    const h = sha(g.content);
    const dup = seenContent.get(h);
    if (dup) {
      exclude(g, `duplicate of ${dup}`);
      continue;
    }
    const lic = (g.license ?? "").trim().toLowerCase();
    if (!opts.acceptLicenseRisk && !PERMISSIVE_LICENSES.has(lic)) {
      exclude(g, lic ? `license "${g.license}" is not on the permissive list` : "license unknown");
      continue;
    }
    seenContent.set(h, gid(g));
    candidates.push({ g, d: decodeGene(g) });
  }

  // ---- 2. skills first (references attach to them) ----
  for (const { g, d } of candidates.filter((c) => c.g.kind === "skill")) {
    let md = g.content as string;
    const desc = d.description;
    if (!hasFrontmatter(md)) {
      if (!desc) {
        exclude(g, "no frontmatter and no description — a skill cannot trigger without one");
        continue;
      }
      md = repairSkillMdFrontmatter(md, { name: d.name, description: desc }).md;
    } else if (!desc) {
      exclude(g, "skill has no description — it cannot trigger without one");
      continue;
    }
    const slug = uniqueSlug(slugify(d.name || g.name, "skill"), skillSlugs, report.conflicts, "skill");
    md = setFrontmatterName(md, slug);
    files[`skills/${slug}/SKILL.md`] = md.endsWith("\n") ? md : `${md}\n`;
    const dir = g.path.replace(/\/?SKILL\.md$/i, "");
    skillByDir.set(`${g.sourceRepo}:${dir}`, slug);
    include(g, d, `skills/${slug}`);
    for (const t of d.allowedTools) {
      if (/^(\*|Bash)$/.test(t)) report.warnings.push(`skill "${slug}" requests unrestricted ${t}`);
    }
  }

  // ---- 3. everything else ----
  const mcpServers: Record<string, unknown> = {};
  const hooksMerged: Record<string, unknown[]> = {};
  const hookSeen = new Set<string>();

  for (const { g, d } of candidates) {
    switch (g.kind) {
      case "skill":
        break;
      case "skill-ref": {
        const m = g.path.match(/^(.*?)\/?(?:references?|resources)\/([^/]+\.md)$/i);
        const slug = m ? skillByDir.get(`${g.sourceRepo}:${m[1]}`) : undefined;
        if (!m || !slug) {
          exclude(g, "orphan reference — its SKILL.md is not part of the selection");
          break;
        }
        files[`skills/${slug}/references/${m[2]}`] = g.content as string;
        include(g, d, `skills/${slug}/references`);
        break;
      }
      case "command": {
        const slug = uniqueSlug(slugify(g.path.split("/").pop()?.replace(/\.md$/i, "") || g.name, "command"), cmdSlugs, report.conflicts, "command");
        files[`commands/${slug}.md`] = g.content as string;
        include(g, d, `commands/${slug}`);
        break;
      }
      case "agent": {
        const slug = uniqueSlug(slugify(d.name || g.name, "agent"), agentSlugs, report.conflicts, "agent");
        files[`agents/${slug}.md`] = g.content as string;
        include(g, d, `agents/${slug}`);
        break;
      }
      case "mcp-config": {
        if (!opts.allowExecutables) {
          exclude(g, `MCP servers launch processes (${d.mcpServers.join(", ") || "none parsed"}) — pass allowExecutables after review`);
          break;
        }
        const j = JSON.parse(g.content as string) as Record<string, unknown>;
        const servers = isObj(j.mcpServers) ? j.mcpServers : {};
        let added = 0;
        for (const [name, spec] of Object.entries(servers)) {
          if (name in mcpServers) {
            if (JSON.stringify(mcpServers[name]) !== JSON.stringify(spec)) {
              report.conflicts.push(`MCP server "${name}" is defined differently in ${gid(g)} — kept the first definition`);
            }
            continue;
          }
          mcpServers[name] = spec;
          added++;
        }
        if (added === 0) {
          exclude(g, "no new MCP servers");
          break;
        }
        report.executables.mcp.push(...d.mcpCommands.filter((c) => c.split(":")[0] in mcpServers));
        include(g, d, ".mcp.json");
        break;
      }
      case "hook-config": {
        if (!opts.allowExecutables) {
          exclude(g, `hooks run shell commands (${d.hookEvents.join(", ") || "none parsed"}) — pass allowExecutables after review`);
          break;
        }
        const j = JSON.parse(g.content as string) as Record<string, unknown>;
        if (isObj(j.permissions) || isObj(j.env)) report.warnings.push(`${gid(g)}: "permissions"/"env" blocks were NOT imported`);
        const hooks = isObj(j.hooks) ? j.hooks : {};
        let added = 0;
        for (const [event, groups] of Object.entries(hooks)) {
          if (!Array.isArray(groups)) continue;
          for (const grp of groups) {
            const key = `${event}:${JSON.stringify(grp)}`;
            if (hookSeen.has(key)) continue;
            hookSeen.add(key);
            (hooksMerged[event] ??= []).push(grp);
            added++;
          }
        }
        if (added === 0) {
          exclude(g, "no new hooks");
          break;
        }
        report.executables.hooks.push(...d.hookCommands);
        include(g, d, "hooks/hooks.json");
        break;
      }
      case "plugin-manifest":
        exclude(g, "plugin manifest — the assembler writes its own manifest");
        break;
      case "claude-md":
      case "agents-md":
        exclude(g, "repo-level contract file — not a plugin component");
        break;
      default:
        exclude(g, `unsupported kind "${g.kind}"`);
    }
  }

  if (Object.keys(mcpServers).length) files[".mcp.json"] = JSON.stringify({ mcpServers }, null, 2) + "\n";
  if (Object.keys(hooksMerged).length) files["hooks/hooks.json"] = JSON.stringify({ hooks: hooksMerged }, null, 2) + "\n";

  if (report.included.length === 0) {
    report.warnings.push("nothing could be assembled — see the exclusion reasons");
    return { ok: false, files: {}, report };
  }

  report.toolRequests = Array.from(toolSet).sort();

  // ---- 4. manifest, README, NOTICE ----
  const description = (opts.description ?? "").trim() || `Plugin assembled from ${report.included.length} capability genes`;
  files[".claude-plugin/plugin.json"] =
    JSON.stringify(
      { name: opts.name, version: opts.version || "0.1.0", description, author: { name: opts.author || "assembled with Claude Hunter" }, keywords: ["assembled", "claude-hunter"] },
      null,
      2
    ) + "\n";

  const components = report.included.map((i) => `- \`${i.component}\` ← ${i.gene}`).join("\n");
  files["README.md"] =
    `# ${opts.name}\n\n${description}\n\n## Components\n\n${components}\n\n` +
    (report.toolRequests.length ? `## Tools requested by skills\n\n${report.toolRequests.map((t) => `- \`${t}\``).join("\n")}\n\n` : "") +
    (report.executables.hooks.length || report.executables.mcp.length
      ? `## Review before installing — this plugin runs commands\n\n${[...report.executables.hooks.map((c) => `- hook ${c}`), ...report.executables.mcp.map((c) => `- mcp ${c}`)].join("\n")}\n\n`
      : "") +
    `Install: \`/plugin install\` from a marketplace that lists this folder, or point Claude Code at it with \`--plugin-dir\`.\n`;

  const rows = Array.from(licenseUsed.values()).flat().map((l) => `| ${l.repo} | ${l.path} | ${l.license} |`).join("\n");
  files["NOTICE.md"] =
    `# Third-party notices\n\nThis plugin contains material from the repositories below. Each component remains under its original license.\n\n` +
    (opts.acceptLicenseRisk ? `> WARNING: assembled with license risk accepted — genes with unknown or non-permissive licenses may be included. Verify each license before distributing.\n\n` : "") +
    `| Repository | Path | License |\n|---|---|---|\n${rows}\n`;

  const total = Object.values(files).reduce((s, t) => s + Buffer.byteLength(t, "utf8"), 0);
  if (total > MAX_BUNDLE_BYTES) return fail(`bundle is ${total} bytes — over the ${MAX_BUNDLE_BYTES} byte cap; select fewer genes`);

  // deterministic key order
  const ordered: Record<string, string> = {};
  for (const k of Object.keys(files).sort()) ordered[k] = files[k];
  return { ok: true, files: ordered, report };
}

// re-export for callers that only need the parser
export { parseFrontmatter };

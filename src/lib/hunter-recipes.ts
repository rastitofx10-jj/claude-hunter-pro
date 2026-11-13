import type { SearchBody } from "./hunter-types";

export interface Recipe {
  id: string;
  emoji: string;
  title: string;
  desc: string;
  body: Partial<SearchBody>;
  analyze?: { owner: string; repo: string };
}

export const RECIPES: Recipe[] = [
  {
    id: "hot-claude-code",
    emoji: "🔥",
    title: "Hot Claude Code projects",
    desc: "Repos with the claude-code topic, updated in the last 90 days, sorted by stars",
    body: { mode: "repos", query: "claude code", topics: ["claude-code"], minStars: 5, pushedWithinDays: 90, sort: "stars" },
  },
  {
    id: "opus45-skill-files",
    emoji: "🧠",
    title: "Opus 4.5 inside skill files",
    desc: "Code search for claude-opus-4-5 in SKILL.md files — direct evidence of the strongest real model",
    body: { mode: "code", query: "filename:SKILL.md", model: "claude-opus-4-5" },
  },
  {
    id: "anthropic-key",
    emoji: "🔑",
    title: "Anthropic key in .env.example",
    desc: "Evidence of a paid Anthropic API connection",
    body: { mode: "code", query: "ANTHROPIC_API_KEY", hasClaudeMd: false },
  },
  {
    id: "claudemd",
    emoji: "📄",
    title: "Repos with CLAUDE.md",
    desc: "Code search for the Claude Code instructions file — a sign of serial development with Claude",
    body: { mode: "code", hasClaudeMd: true },
  },
  {
    id: "official-sdk",
    emoji: "🏗️",
    title: "Official SDK in package.json",
    desc: "@anthropic-ai/sdk in package.json files — apps built on the API",
    body: { mode: "code", query: "\"@anthropic-ai/sdk\"", language: "JSON" },
  },
  {
    id: "mcp-claude",
    emoji: "🔌",
    title: "MCP servers with Claude",
    desc: "topic mcp-server + a claude mention, sorted by stars",
    body: { mode: "repos", topics: ["mcp-server"], query: "claude", minStars: 10, sort: "stars" },
  },
  {
    id: "opus-45-wave",
    emoji: "✨",
    title: "Opus 4.5 — the real frontier",
    desc: "Code search for claude-opus-4-5 pins — the strongest model that actually exists",
    body: { mode: "code", model: "claude-opus-4-5" },
  },
  {
    id: "premium-settings",
    emoji: "⚙️",
    title: "Claude Code settings with Opus 4.5",
    desc: "Claude Code settings files configured for the real flagship",
    body: { mode: "code", query: "claude-opus-4-5", hasClaudeMd: false },
  },
  {
    id: "analyze-craft",
    emoji: "🎭",
    title: "Analysis: storytold/craft-anything",
    desc: "A deep analysis of the repo you mentioned",
    body: {},
    analyze: { owner: "storytold", repo: "craft-anything" },
  },
  {
    id: "analyze-public-apis",
    emoji: "📚",
    title: "Analysis: public-apis/public-apis",
    desc: "A deep analysis of the big public-apis list",
    body: {},
    analyze: { owner: "public-apis", repo: "public-apis" },
  },
];

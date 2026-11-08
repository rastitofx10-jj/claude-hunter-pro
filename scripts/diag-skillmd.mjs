import ZAI from "z-ai-web-dev-sdk";

const prompt = `Write a complete SKILL.md file (in English) for the mission below. This file will be injected into .claude/skills/m365-bridge-due-diligence/SKILL.md so any Claude Code agent can execute the mission.

Mission goal: Due diligence on KilimcininKorOglu/M365Bridge

Phases:
1. Intelligence gathering — map the repo surface
2. Deep analysis — extract premium model usage patterns

Requirements:
- Start with YAML frontmatter: name: m365-bridge-due-diligence and a one-line description
- Then operational instructions: role, rules, step-by-step procedure aligned to the phases, verification checklist, and failure-recovery guidance
- Minimum 35 lines of practical content, markdown only — no code fences around the whole file (fenced code examples INSIDE are allowed and encouraged)`;

const zai = await ZAI.create();
const completion = await zai.chat.completions.create({
  messages: [
    { role: "assistant", content: "You are an elite skills engineer. Respond with the raw SKILL.md file content only — markdown, starting with YAML frontmatter. No surrounding code fences." },
    { role: "user", content: prompt },
  ],
  thinking: { type: "disabled" },
});
const content = completion.choices[0]?.message?.content ?? "";
console.log("LENGTH:", content.length);
console.log("STARTS_WITH_---:", /^---/.test(content));
console.log("FIRST 300 CHARS:");
console.log(JSON.stringify(content.slice(0, 300)));
process.exit(0);

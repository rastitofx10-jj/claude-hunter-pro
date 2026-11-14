// ============================================================
// born-dna — the shared law for EVERY path that births a gene
// from our own field experience (manual field reports, live-hunt
// grow retries, reflexion lessons).
//
// round 12 (MEDIUM-6 truth fix): sanitizeBornMeta lived as a private
// copy inside mission/report/route.ts — the comment above it promised
// "a DNA's name/description enters future compiler/executor prompts;
// control characters and name fences are an instruction-injection door"
// — but live-hunt's stageGrow upserted the SAME data class (raw LLM
// name/description) into the SAME library table with NO sanitization
// at all. The system claimed the injection door was closed while one
// of the two birth paths held it wide open. One law, one implementation,
// every birth path: this module.
// ============================================================

/** Sanitize AI-born metadata before it enters the library — a DNA's
 *  name/description enters future compiler/executor prompts; control
 *  characters, fences and markup brackets are an instruction-injection
 *  door (previously: a completely free-form field). */
export function sanitizeBornMeta(v: unknown, max: number): string {
  return String(v ?? "")
    .replace(/[<>`\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

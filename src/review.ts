// review.ts — the automated review pass.
//
// Every push to a task branch gets a review attached before a human decides.
// The review is two layers:
//   1. Heuristic review (always runs): diffstat, new/deleted files, size
//      flags, TODO/FIXME scan, secret scan. Deterministic, explainable.
//   2. LLM review (hook): if the Worker has an AI binding (e.g. Workers AI),
//      the diff is summarized by a model. Absent the binding, this layer is
//      skipped openly — the heuristic review stands alone.

import { LineDiff } from "./logic.js";
import { Task } from "./tasks.js";

export interface ReviewFinding {
  severity: "info" | "warn" | "block";
  message: string;
}

export interface Review {
  at: number;
  filesChanged: number;
  added: number;
  removed: number;
  findings: ReviewFinding[];
  summary: string;
  llmSummary: string | null; // null when no AI binding is configured
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{8,}\b/,                 // API keys
  /\bghp_[A-Za-z0-9]{8,}\b/,               // GitHub tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,     // private keys
  /\bAKIA[0-9A-Z]{16}\b/,                  // AWS keys
  /password\s*[:=]\s*["'][^"']{4,}["']/i,   // passwords in config
];

export async function runReview(task: Task, diff: LineDiff[], ai?: any): Promise<Review> {
  const findings: ReviewFinding[] = [];
  let added = 0, removed = 0;
  for (const f of diff) {
    added += f.added; removed += f.removed;
    if (f.added > 500) findings.push({ severity: "warn", message: `${f.path}: large addition (${f.added} lines) — review carefully` });
    if (!f.hunks.length && f.added === 0 && f.removed > 0) findings.push({ severity: "info", message: `${f.path}: file deleted` });
    if (f.removed === 0 && f.added > 0 && !f.hunks.some(h => h.startsWith("-")))
      findings.push({ severity: "info", message: `${f.path}: new file` });
    const text = f.hunks.join("\n");
    if (/\bTODO\b|\bFIXME\b|\bHACK\b/.test(text))
      findings.push({ severity: "info", message: `${f.path}: contains TODO/FIXME markers` });
    for (const pat of SECRET_PATTERNS) {
      if (pat.test(text)) {
        findings.push({ severity: "block", message: `${f.path}: possible secret committed — do not merge until removed` });
        break;
      }
    }
  }
  if (diff.length === 0) findings.push({ severity: "warn", message: "empty diff — nothing to review" });

  const summary =
    `${diff.length} file(s) changed, +${added}/-${removed}. ` +
    (findings.length ? `${findings.length} finding(s).` : "No heuristic findings.");

  let llmSummary: string | null = null;
  if (ai) {
    try {
      llmSummary = await llmReview(ai, task, diff);
    } catch (e) {
      findings.push({ severity: "info", message: `LLM review skipped: ${String(e)}` });
    }
  }

  return { at: Date.now(), filesChanged: diff.length, added, removed, findings, summary, llmSummary };
}

/** LLM hook: summarize the diff for the human. Bring your own model binding. */
async function llmReview(ai: any, task: Task, diff: LineDiff[]): Promise<string> {
  const digest = diff
    .map(f => `### ${f.path} (+${f.added}/-${f.removed})\n${f.hunks.slice(0, 60).join("\n")}`)
    .join("\n\n")
    .slice(0, 6000);
  const prompt =
    `You are reviewing an AI agent's code change for a human who will approve or reject it.\n` +
    `Intent: ${task.intent}\n\nDiff:\n${digest}\n\n` +
    `Reply in 5 sentences or fewer: what changed, whether it matches the intent, and any risk.`;
  // Workers AI binding shape: ai.run(model, input)
  const res = await ai.run("@cf/meta/llama-3.1-8b-instruct", { prompt });
  return typeof res?.response === "string" ? res.response : JSON.stringify(res).slice(0, 2000);
}

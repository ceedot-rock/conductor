// logic.ts — pure functions shared by the Worker and the tests.
// No I/O, no Cloudflare APIs. Everything here is unit-tested.

export interface LineDiff {
  path: string;
  added: number;
  removed: number;
  hunks: string[];
}

/** Naive line diff between old and new file text. Good enough for review summaries. */
export function diffLines(oldText: string, newText: string): { added: number; removed: number; hunks: string[] } {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  // LCS on lines (fine for review-sized files)
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const hunks: string[] = [];
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) { i++; j++; }
    else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) { hunks.push("+" + b[j]); added++; j++; }
    else { hunks.push("-" + a[i]); removed++; i++; }
  }
  return { added, removed, hunks };
}

export interface OutputComparison {
  exact: boolean;
  reference: string;          // seat whose output is the reference
  divergent: Record<string, string>; // seat -> its stdout, for seats that differ
  diff: string;               // unified-style diff of divergent outputs vs reference
}

/** Byte-exact stdout comparison across seats. The heart of the CuNi verdict. */
export function compareOutputs(outputs: Record<string, string>): OutputComparison {
  const seats = Object.keys(outputs);
  if (seats.length === 0) return { exact: true, reference: "", divergent: {}, diff: "" };
  const reference = seats[0];
  const refOut = outputs[reference];
  const divergent: Record<string, string> = {};
  for (const s of seats.slice(1)) {
    if (outputs[s] !== refOut) divergent[s] = outputs[s];
  }
  let diff = "";
  if (Object.keys(divergent).length > 0) {
    const refLines = refOut.split("\n");
    for (const [seat, out] of Object.entries(divergent)) {
      diff += `--- reference (${reference})\n+++ ${seat}\n`;
      const { hunks } = diffLines(refOut, out);
      const maxShow = 40;
      diff += hunks.slice(0, maxShow).join("\n") + "\n";
      if (hunks.length > maxShow) diff += `... (${hunks.length - maxShow} more lines)\n`;
      void refLines;
    }
  }
  return { exact: Object.keys(divergent).length === 0, reference, divergent, diff };
}

/** Short hex digest helper (FNV-1a, non-crypto — for display only). */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

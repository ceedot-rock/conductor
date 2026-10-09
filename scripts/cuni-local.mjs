// cuni-local.mjs — REAL CuNi exactness verification against the local binary.
//
// Usage:
//   node scripts/cuni-local.mjs --source examples/fee.cuni --seats py,js [--out demo/cuni-example.json]
//
// What it does (no mocks, no invented output):
//   1. Runs `cuni <source> --emit <seat> <file>` for each seat.
//   2. Executes each emitted program with that seat's real toolchain.
//   3. Compares stdout byte-for-byte.
//   4. Prints EXACT (identical everywhere) or REFUSE (with the diff),
//      and optionally writes the full evidence bundle as JSON.
//
// If `cuni` refuses to emit a seat, that is reported as a refusal —
// the exactness law working as designed.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

const CUNI = process.env.CUNI_BIN ?? new URL("../../cuni-langs/target/debug/cuni", import.meta.url).pathname;

const RUNNERS = {
  py: ["python3"],
  js: ["node"],
  rb: ["ruby"],
  lua: ["lua"],
};

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function run(cmd, args, cwd, timeoutMs = 30_000) {
  try {
    const out = execFileSync(cmd, args, { cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, stdout: out };
  } catch (e) {
    return { ok: false, stdout: (e.stdout ?? "").toString(), error: String(e.message).slice(0, 300) };
  }
}

function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

function unifiedDiff(refName, ref, seatName, out) {
  const a = ref.split("\n"), b = out.split("\n");
  const lines = [`--- reference (${refName})`, `+++ ${seatName}`];
  const n = Math.max(a.length, b.length);
  let shown = 0;
  for (let i = 0; i < n && shown < 40; i++) {
    if (a[i] !== b[i]) {
      if (a[i] !== undefined) { lines.push("-" + a[i]); shown++; }
      if (b[i] !== undefined) { lines.push("+" + b[i]); shown++; }
    }
  }
  return lines.join("\n");
}

const sourceFile = resolve(arg("source") ?? "");
const seats = (arg("seats", "py,js") ?? "py,js").split(",").map((s) => s.trim()).filter(Boolean);
const outFile = arg("out") ? resolve(arg("out")) : null;

if (!process.argv.includes("--source")) { console.error("usage: node scripts/cuni-local.mjs --source <file.cuni> --seats py,js [--out out.json]"); process.exit(2); }

const source = readFileSync(sourceFile, "utf8");
const dir = mkdtempSync(join(tmpdir(), "cuni-exact-"));
const results = [];
const refusals = [];

for (const seat of seats) {
  const runner = RUNNERS[seat];
  if (!runner) { refusals.push({ seat, reason: `no local runner configured for seat '${seat}'` }); continue; }
  const ext = seat === "py" ? "py" : seat === "js" ? "js" : seat === "rb" ? "rb" : "lua";
  const target = join(dir, `out.${ext}`);
  const emit = run(CUNI, [sourceFile, "--emit", seat, target], dir);
  if (!emit.ok) { refusals.push({ seat, reason: `cuni refused to emit: ${emit.error}` }); continue; }
  const code = readFileSync(target, "utf8");
  const exec = run(runner[0], [target], dir);
  if (!exec.ok) { refusals.push({ seat, reason: `seat execution failed: ${exec.error}` }); continue; }
  results.push({ seat, code, stdout: exec.stdout });
}

let verdict;
if (refusals.length > 0) {
  verdict = {
    status: "REFUSE",
    sourceHash: shortHash(source),
    seats,
    detail: `Refused: ${refusals.map((r) => `${r.seat} (${r.reason})`).join("; ")}`,
  };
} else if (results.length === 0) {
  verdict = { status: "REFUSE", sourceHash: shortHash(source), seats, detail: "No seats produced output." };
} else {
  const ref = results[0];
  const divergent = results.slice(1).filter((r) => r.stdout !== ref.stdout);
  if (divergent.length === 0) {
    verdict = {
      status: "EXACT",
      sourceHash: shortHash(source),
      seats: results.map((r) => r.seat),
      stdout: ref.stdout,
      stdoutHash: shortHash(ref.stdout),
      detail: `${results.length} seats, byte-identical stdout.`,
    };
  } else {
    verdict = {
      status: "REFUSE",
      sourceHash: shortHash(source),
      seats: results.map((r) => r.seat),
      divergent: Object.fromEntries(divergent.map((r) => [r.seat, r.stdout])),
      diff: divergent.map((r) => unifiedDiff(ref.seat, ref.stdout, r.seat, r.stdout)).join("\n"),
      detail: `Refused: ${divergent.map((r) => r.seat).join(", ")} diverged from ${ref.seat}.`,
    };
  }
}

console.log(`cuni-exactness: ${verdict.status} — ${verdict.detail}`);
const bundle = { source, results, verdict, generatedBy: "cuni-local.mjs", at: new Date().toISOString() };
if (outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(bundle, null, 2));
  console.log(`wrote ${outFile}`);
}
process.exit(verdict.status === "EXACT" ? 0 : 1);

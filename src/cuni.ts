// cuni.ts — the CuNi integration. Corey's differentiator.
//
// The idea: a human speaks an intent ("add a 0.5% fee to every order").
// CuNi turns that intent into code in ANY programming language — and the
// exactness law holds: the emitted programs print byte-identical output
// everywhere, or CuNi refuses to emit at all.
//
// Two paths:
//   1. Worker (production): POST the CuNi source to a CuNi emit service
//      (CUNI_SERVICE_URL). The service contract is documented below —
//      cuni-studio exposes it, or run the local binary behind an endpoint.
//   2. Local/dev/demo: scripts/cuni-local.mjs shells out to the real
//      `cuni` binary, emits to N seats, runs each seat's toolchain, and
//      compares stdout byte-for-byte. The demo panel shows a REAL example
//      produced this way (demo/cuni-example.json), generated with
//      cuni 0.9.0 — no mock outputs anywhere.

import { compareOutputs, shortHash } from "./logic.js";

export interface SeatResult {
  seat: string;
  code: string;    // emitted source in that language
  stdout: string;  // what running it printed
}

export interface CuniVerdict {
  status: "EXACT" | "REFUSE";
  sourceHash: string;
  seats: string[];
  /** Present when EXACT: the identical stdout every seat produced. */
  stdout?: string;
  /** Present when EXACT: sha of the common stdout (display only). */
  stdoutHash?: string;
  /** Present when REFUSE: which seats diverged and how. */
  divergent?: Record<string, string>;
  diff?: string;
  detail: string;
}

/**
 * Service contract for POST {CUNI_SERVICE_URL}/emit :
 *   request:  { source: string, seats: string[] }
 *   response: { results: [{ seat, code, stdout }] }
 * The service emits the CuNi source to each seat, RUNS each emitted
 * program with that seat's toolchain, and returns the captured stdout.
 * Timeouts and missing toolchains must surface as errors, never as
 * invented stdout.
 */
export async function emitViaService(
  source: string,
  seats: string[],
  serviceUrl: string,
  timeoutMs = 60_000,
): Promise<SeatResult[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${serviceUrl.replace(/\/$/, "")}/emit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, seats }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`CuNi service ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { results?: SeatResult[] };
    if (!Array.isArray(data.results) || data.results.length === 0)
      throw new Error("CuNi service returned no results");
    return data.results;
  } finally {
    clearTimeout(t);
  }
}

/** The verdict: byte-identical everywhere, or refuse with the diff. */
export function judgeEmission(source: string, results: SeatResult[]): CuniVerdict {
  const outputs: Record<string, string> = {};
  for (const r of results) outputs[r.seat] = r.stdout;
  const cmp = compareOutputs(outputs);
  const sourceHash = shortHash(source);
  if (cmp.exact) {
    const stdout = results[0]?.stdout ?? "";
    return {
      status: "EXACT",
      sourceHash,
      seats: results.map(r => r.seat),
      stdout,
      stdoutHash: shortHash(stdout),
      detail: `${results.length} seats, byte-identical stdout.`,
    };
  }
  return {
    status: "REFUSE",
    sourceHash,
    seats: results.map(r => r.seat),
    divergent: cmp.divergent,
    diff: cmp.diff,
    detail: `Refused: ${Object.keys(cmp.divergent).join(", ")} diverged from ${cmp.reference}.`,
  };
}

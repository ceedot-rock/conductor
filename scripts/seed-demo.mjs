// seed-demo.mjs — seeds the Conductor demo end-to-end.
//
// Prerequisite: the Worker running locally (`npm run dev`, default http://localhost:8787).
//
// What it does:
//   1. Dispatches 3 intents -> 3 agent task workspaces.
//   2. Simulates agent pushes (labeled demo) -> review passes run.
//   3. Generates the REAL CuNi example (cuni 0.9.0 -> py + js -> run -> compare)
//      into public/demo/cuni-example.json for the panel's CuNi tab.
//
// Everything the video shows comes from these calls. No hand-edited fixtures.

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${data.error ?? "?"}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`seeding Conductor demo against ${BASE}`);

// FIRST: the real CuNi example. Writing to public/ makes `wrangler dev`
// reload the worker (fresh isolate), so this must happen before any
// tasks are created — otherwise the reload wipes them.
mkdirSync("public/demo", { recursive: true });
execFileSync(
  "node",
  ["scripts/cuni-local.mjs", "--source", "examples/fee.cuni", "--seats", "py,js", "--out", "public/demo/cuni-example.json"],
  { stdio: "inherit" },
);
console.log("waiting for the dev server to settle after the asset write...");
await sleep(4000);

// Task 1: the fee story (matches the CuNi example).
const t1 = await post("/api/intent", {
  repo: "demo-shop",
  text: "Add a 0.5% fee to every order total",
});
console.log(`task 1: ${t1.task.id} (${t1.task.branch})`);

await post(`/api/demo/push/${t1.task.id}`, {
  message: "agent: implement 0.5% order fee",
  files: {
    "src/orders.py": `FEE_RATE = 0.0050\n\ndef total(items):\n    """Order total with the 0.5% lab fee applied."""\n    return sum(items) * (1 + FEE_RATE)\n\ndef fee(items):\n    return sum(items) * FEE_RATE\n`,
  },
});
console.log("task 1: agent pushed fee implementation -> review ran");

// Task 2: a change with a problem the review catches (secret in code).
const t2 = await post("/api/intent", {
  repo: "demo-shop",
  text: "Wire up the payments client",
});
await post(`/api/demo/push/${t2.task.id}`, {
  message: "agent: add payments client",
  files: {
    "src/payments.py": `API_KEY = "sk-live4f8a2b9c1dEFGH5678"\n\ndef charge(amount):\n    # TODO: use the real gateway\n    return {"charged": amount, "key": API_KEY}\n`,
  },
});
console.log("task 2: agent pushed payments client -> review flagged the secret");

// Task 3: still open — agent hasn't pushed yet.
const t3 = await post("/api/intent", {
  repo: "demo-shop",
  text: "Write a README section documenting the fee",
});
console.log(`task 3: ${t3.task.id} open, awaiting agent push`);

await sleep(500);

console.log("\ndemo seeded. Open the control panel and:");
console.log("  1. Approve task 1 (clean fee change) -> merges to main.");
console.log("  2. Reject task 2 (review blocked: committed secret).");
console.log("  3. Open the CuNi tab for the byte-identical proof.");

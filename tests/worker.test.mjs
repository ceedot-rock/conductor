// end-to-end API test: drives the Worker's fetch handler directly
// (dist build, MemoryStore backend — no network, no Cloudflare).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "../dist/index.js";

const ENV = {};
async function call(method, path, body) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, ENV);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

describe("worker API", () => {
  it("full demo arc: intent -> push -> review -> approve", async () => {
    const repos = await call("GET", "/api/repos");
    assert.equal(repos.status, 200);
    assert.ok(repos.data.repos.some((r) => r.name === "demo-shop"));

    const created = await call("POST", "/api/intent", { text: "add a fee", repo: "demo-shop" });
    assert.equal(created.status, 201);
    const id = created.data.task.id;
    assert.equal(created.data.task.status, "open");

    const pushed = await call("POST", `/api/demo/push/${id}`, {
      files: { "src/orders.py": "FEE = 0.005\n" },
      message: "agent: fee",
    });
    assert.equal(pushed.status, 200);
    assert.equal(pushed.data.task.status, "in_review");
    assert.ok(pushed.data.task.review);

    const got = await call("GET", `/api/tasks/${id}`);
    assert.equal(got.data.task.diff.length, 1);

    const approved = await call("POST", `/api/tasks/${id}/approve`, {});
    assert.equal(approved.data.task.status, "merged");
    assert.ok(approved.data.task.mergeCommit);

    const list = await call("GET", "/api/tasks");
    assert.ok(list.data.tasks.length >= 1);
  });

  it("rejects empty intents and unknown tasks cleanly", async () => {
    const bad = await call("POST", "/api/intent", { text: "  " });
    assert.equal(bad.status, 400);
    const missing = await call("GET", "/api/tasks/t-nope");
    assert.equal(missing.status, 404);
    const badRepo = await call("POST", "/api/intent", { text: "x", repo: "nope" });
    assert.equal(badRepo.status, 404);
  });

  it("cuni emit without a service URL is an honest 501", async () => {
    const r = await call("POST", "/api/cuni/emit", { source: "say(1)", seats: ["py"] });
    assert.equal(r.status, 501);
    assert.match(r.data.error, /CUNI_SERVICE_URL/);
  });
});

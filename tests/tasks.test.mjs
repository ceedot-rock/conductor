// tests for the task lifecycle on the MemoryStore (dist build).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../dist/store.js";
import { TaskService, makeTaskBackend } from "../dist/tasks.js";

async function setup() {
  const store = new MemoryStore();
  await store.createRepo("shop", { "src/a.py": "X = 1\n" });
  const svc = new TaskService(store, makeTaskBackend());
  return { store, svc };
}

describe("task lifecycle", () => {
  it("intent -> push -> review -> approve merges to main", async () => {
    const { store, svc } = await setup();
    const task = await svc.createIntent("shop", "bump X to 2");
    assert.equal(task.status, "open");
    assert.ok(task.branch.startsWith("agent/"));

    const pushed = await svc.demoPush(task.id, { "src/a.py": "X = 2\n" }, "agent: bump X");
    assert.equal(pushed.status, "in_review");
    assert.ok(pushed.review);
    assert.equal(pushed.diff.length, 1);
    assert.equal(pushed.diff[0].path, "src/a.py");

    const merged = await svc.approve(task.id);
    assert.equal(merged.status, "merged");
    assert.ok(merged.mergeCommit);
    assert.equal(await store.readFile("shop", "main", "src/a.py"), "X = 2\n");
  });

  it("reject closes the task without merging", async () => {
    const { store, svc } = await setup();
    const task = await svc.createIntent("shop", "do something bad");
    await svc.demoPush(task.id, { "src/a.py": "X = 999\n" }, "agent: bad change");
    const rejected = await svc.reject(task.id);
    assert.equal(rejected.status, "rejected");
    assert.equal(await store.readFile("shop", "main", "src/a.py"), "X = 1\n");
  });

  it("review flags a committed secret as blocking", async () => {
    const { svc } = await setup();
    const task = await svc.createIntent("shop", "add client");
    const pushed = await svc.demoPush(task.id, { "src/k.py": 'KEY = "sk-abcdefgh12345678"\n' }, "agent: add key");
    const block = pushed.review.findings.find((f) => f.severity === "block");
    assert.ok(block, "expected a blocking secret finding");
    assert.match(block.message, /secret/i);
  });

  it("unknown task ids are 404s", async () => {
    const { svc } = await setup();
    await assert.rejects(() => svc.get("nope").then((t) => { if (!t) throw Object.assign(new Error("x"), { status: 404 }); }), /x/);
    await assert.rejects(() => svc.approve("t-missing"), (e) => e.status === 404);
  });
});

// tests for the pure logic module (dist build).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffLines, compareOutputs, shortHash } from "../dist/logic.js";

describe("diffLines", () => {
  it("finds added and removed lines", () => {
    const d = diffLines("a\nb\nc", "a\nB\nc\nd");
    assert.equal(d.added, 2);   // B, d
    assert.equal(d.removed, 1); // b
    assert.ok(d.hunks.includes("+B"));
    assert.ok(d.hunks.includes("-b"));
  });
  it("empty diff for identical text", () => {
    const d = diffLines("x\ny", "x\ny");
    assert.equal(d.added, 0);
    assert.equal(d.removed, 0);
  });
});

describe("compareOutputs — the exactness verdict", () => {
  it("EXACT when all seats print byte-identical stdout", () => {
    const c = compareOutputs({ py: "0.5\n12.5\n", js: "0.5\n12.5\n" });
    assert.equal(c.exact, true);
    assert.deepEqual(Object.keys(c.divergent), []);
    assert.equal(c.diff, "");
  });
  it("REFUSE with a diff when a seat diverges", () => {
    const c = compareOutputs({ py: "0.5\n12.5\n", js: "0.5\n12.6\n" });
    assert.equal(c.exact, false);
    assert.deepEqual(Object.keys(c.divergent), ["js"]);
    assert.ok(c.diff.includes("+++ js"));
    assert.ok(c.diff.includes("-12.5"));
    assert.ok(c.diff.includes("+12.6"));
  });
  it("a single trailing newline counts as divergence", () => {
    const c = compareOutputs({ py: "x\n", js: "x" });
    assert.equal(c.exact, false);
  });
});

describe("shortHash", () => {
  it("is deterministic", () => {
    assert.equal(shortHash("fee"), shortHash("fee"));
    assert.notEqual(shortHash("fee"), shortHash("Fee"));
  });
});

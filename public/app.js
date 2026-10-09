// app.js — Conductor control panel. No build step, no framework.
// Polls the Worker API and renders tasks, diffs, reviews, and the CuNi example.

const $ = (id) => document.getElementById(id);
const api = {
  async get(p) { const r = await fetch(p); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); },
  async post(p, body) {
    const r = await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `${p}: ${r.status}`);
    return d;
  },
};

let selectedTask = null;

// --- tabs ---
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    $("tab-panel").hidden = btn.dataset.tab !== "panel";
    $("tab-cuni").hidden = btn.dataset.tab !== "cuni";
    if (btn.dataset.tab === "cuni") loadCuniExample();
  });
});

// --- intent dispatch ---
$("dispatch").addEventListener("click", async () => {
  const text = $("intent").value.trim();
  if (!text) return;
  $("dispatch").disabled = true;
  try {
    const { task } = await api.post("/api/intent", { text, repo: $("repo").value });
    $("intent").value = "";
    selectedTask = task.id;
    await refresh();
  } catch (e) { alert(`Dispatch failed: ${e.message}`); }
  $("dispatch").disabled = false;
});

$("voice").addEventListener("click", () => {
  alert("Voice input is a stretch goal for the competition entry.\nHook point: WebRTC audio -> speech-to-text -> POST /api/intent.\nSee README for the integration plan.");
});

// --- task feed ---
function statusBadge(s) {
  const cls = { open: "b-open", in_review: "b-review", merged: "b-merged", rejected: "b-rejected" }[s] || "";
  return `<span class="badge ${cls}">${s.replace("_", " ")}</span>`;
}

function renderTasks(tasks) {
  const el = $("tasks");
  if (!tasks.length) { el.innerHTML = `<p class="muted">No tasks yet. Dispatch an intent above.</p>`; return; }
  el.innerHTML = tasks.map((t) => `
    <div class="task ${t.id === selectedTask ? "sel" : ""}" data-id="${t.id}">
      <div class="task-head">${statusBadge(t.status)}<span class="mono">${t.branch}</span></div>
      <div class="task-intent">${escapeHtml(t.intent)}</div>
      <div class="task-meta">${new Date(t.createdAt).toLocaleTimeString()} · ${t.review ? `${t.review.filesChanged} files changed` : "waiting for agent push"}</div>
    </div>`).join("");
  el.querySelectorAll(".task").forEach((n) => n.addEventListener("click", () => { selectedTask = n.dataset.id; refresh(); }));
}

function renderDetail(t) {
  const el = $("task-detail");
  if (!t) { el.innerHTML = `<p class="muted">Select a task to inspect its branch, diff, and review.</p>`; return; }
  let html = `
    <div class="detail-head">${statusBadge(t.status)} <span class="mono">${t.branch}</span></div>
    <p class="intent-quote">“${escapeHtml(t.intent)}”</p>`;
  if (t.review) {
    html += `<h3>Review ${t.review.llmSummary ? "(heuristic + LLM)" : "(heuristic)"}</h3>
      <p>${escapeHtml(t.review.summary)}</p>`;
    if (t.review.llmSummary) html += `<blockquote>${escapeHtml(t.review.llmSummary)}</blockquote>`;
    if (t.review.findings.length) {
      html += `<ul class="findings">` + t.review.findings.map((f) =>
        `<li class="${f.severity}"><strong>${f.severity}</strong> — ${escapeHtml(f.message)}</li>`).join("") + `</ul>`;
    }
  }
  if (t.diff && t.diff.length) {
    html += `<h3>Diff vs main</h3>` + t.diff.map((f) => `
      <div class="file"><div class="file-head mono">${escapeHtml(f.path)} <span class="add">+${f.added}</span> <span class="del">-${f.removed}</span></div>
      <pre class="diff">${f.hunks.slice(0, 80).map((h) =>
        `<span class="${h.startsWith("+") ? "add" : "del"}">${escapeHtml(h)}</span>`).join("\n")}</pre></div>`).join("");
  }
  if (t.status === "in_review") {
    html += `<div class="actions">
      <button id="approve" class="go">Approve & merge → main</button>
      <button id="reject" class="stop">Reject</button></div>`;
  }
  if (t.status === "merged") html += `<p class="muted">Merged${t.mergeCommit ? ` as <span class="mono">${escapeHtml(t.mergeCommit)}</span>` : ""}.</p>`;
  el.innerHTML = html;
  const ap = $("approve"), rj = $("reject");
  if (ap) ap.addEventListener("click", () => decide("approve"));
  if (rj) rj.addEventListener("click", () => decide("reject"));
}

async function decide(kind) {
  try {
    await api.post(`/api/tasks/${selectedTask}/${kind}`, {});
    await refresh();
  } catch (e) { alert(`${kind} failed: ${e.message}`); }
}

// --- CuNi example tab ---
async function loadCuniExample() {
  try {
    const r = await fetch("/demo/cuni-example.json");
    if (!r.ok) throw new Error("not seeded");
    const ex = await r.json();
    $("cuni-source").textContent = ex.source;
    $("cuni-verdict").textContent =
      `status: ${ex.verdict.status}\nseats: ${ex.verdict.seats.join(", ")}\n` +
      (ex.verdict.status === "EXACT"
        ? `stdout sha: ${ex.verdict.stdoutHash}\n\nidentical stdout:\n${ex.verdict.stdout}`
        : `detail: ${ex.verdict.detail}\n\ndiff:\n${ex.verdict.diff}`);
    $("cuni-py").textContent = ex.results.find((x) => x.seat === "py")?.code ?? "";
    $("cuni-js").textContent = ex.results.find((x) => x.seat === "js")?.code ?? "";
  } catch {
    $("cuni-source").textContent = "No example seeded yet — run: npm run seed";
    $("cuni-verdict").textContent = "";
    $("cuni-py").textContent = "";
    $("cuni-js").textContent = "";
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function refresh() {
  try {
    const { tasks } = await api.get("/api/tasks");
    renderTasks(tasks);
    const t = tasks.find((x) => x.id === selectedTask) ?? tasks[0] ?? null;
    if (t && !selectedTask) selectedTask = t.id;
    renderDetail(t);
    const { repos } = await api.get("/api/repos").catch(() => ({ repos: [] }));
    const sel = $("repo");
    if (repos.length && !sel.options.length) sel.innerHTML = repos.map((r) => `<option>${r.name}</option>`).join("");
  } catch (e) {
    $("tasks").innerHTML = `<p class="muted">API unreachable (${escapeHtml(e.message)}). Start the worker: <code>npm run dev</code></p>`;
  }
}

refresh();
setInterval(refresh, 3000);

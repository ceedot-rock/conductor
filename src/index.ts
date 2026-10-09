// index.ts — Conductor Worker entry point.
//
// Routes:
//   POST /api/intent            { text, repo? } -> creates a task (forks repo)
//   GET  /api/tasks             list tasks
//   GET  /api/tasks/:id         one task, with diff + review
//   POST /api/tasks/:id/approve merge task branch -> main
//   POST /api/tasks/:id/reject  close the task
//   POST /api/tasks/:id/push    agent push notification (runs the review pass)
//   GET  /api/repos             list repos
//   POST /api/cuni/emit         { source, seats[] } -> CuNi exactness verdict
//   POST /api/demo/push         demo-only: simulate an agent push
//
// Queue: consumes Artifacts push events (cf.artifacts.repo.pushed) and runs
// the review pass on the matching task branch.

import { ArtifactsStore, MemoryStore, RepoStore } from "./store.js";
import { makeTaskBackend, TaskService } from "./tasks.js";
import { emitViaService, judgeEmission } from "./cuni.js";

export interface Env {
  ARTIFACTS?: any;
  TASKS?: KVNamespace;
  AI?: any;
  CUNI_SERVICE_URL?: string;
}

// One store/task-service per isolate; MemoryStore keeps demo state warm.
let store: RepoStore | null = null;
let svc: TaskService | null = null;

function services(env: Env): { store: RepoStore; tasks: TaskService } {
  if (!svc || !store) {
    store = env.ARTIFACTS ? new ArtifactsStore(env.ARTIFACTS) : new MemoryStore();
    svc = new TaskService(store, makeTaskBackend(env.TASKS));
    // Seed a demo repo in local mode so the panel is never empty.
    if (!env.ARTIFACTS) {
      void (store as MemoryStore).createRepo("demo-shop", {
        "README.md": "# demo-shop\nA tiny store used by the Conductor demo.\n",
        "src/orders.py": "FEE_RATE = 0.0\n\ndef total(items):\n    return sum(items) * (1 + FEE_RATE)\n",
        "AGENTS.md": "# Agent instructions\nKeep functions small. No secrets in code.\n",
      }).catch(() => {});
    }
  }
  return { store, tasks: svc };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readJson(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

function err(e: unknown): Response {
  const status = (e as any)?.status ?? 500;
  const message = e instanceof Error ? e.message : String(e);
  return json({ error: message }, status);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const { store: repoStore, tasks: svc } = services(env);

    try {
      // --- intents & tasks ---
      if (path === "/api/intent" && req.method === "POST") {
        const body = await readJson(req);
        const text = String(body.text ?? "").trim();
        const repo = String(body.repo ?? "demo-shop");
        if (!text) return json({ error: "intent text is required" }, 400);
        const task = await svc.createIntent(repo, text);
        return json({ task }, 201);
      }
      if (path === "/api/tasks" && req.method === "GET") {
        return json({ tasks: await svc.list() });
      }
      const mTask = path.match(/^\/api\/tasks\/([^/]+)$/);
      if (mTask && req.method === "GET") {
        const t = await svc.get(mTask[1]);
        return t ? json({ task: t }) : json({ error: "not found" }, 404);
      }
      const mApprove = path.match(/^\/api\/tasks\/([^/]+)\/approve$/);
      if (mApprove && req.method === "POST") {
        return json({ task: await svc.approve(mApprove[1]) });
      }
      const mReject = path.match(/^\/api\/tasks\/([^/]+)\/reject$/);
      if (mReject && req.method === "POST") {
        return json({ task: await svc.reject(mReject[1]) });
      }
      const mPush = path.match(/^\/api\/tasks\/([^/]+)\/push$/);
      if (mPush && req.method === "POST") {
        // Agent push notification: run the review pass.
        const t = await svc.onPush(mPush[1]);
        return json({ task: t });
      }

      // --- repos ---
      if (path === "/api/repos" && req.method === "GET") {
        return json({ repos: await repoStore.listRepos() });
      }

      // --- CuNi exactness ---
      if (path === "/api/cuni/emit" && req.method === "POST") {
        const body = await readJson(req);
        const source = String(body.source ?? "");
        const seats: string[] = Array.isArray(body.seats) && body.seats.length ? body.seats : ["py", "js"];
        if (!source.trim()) return json({ error: "CuNi source is required" }, 400);
        const serviceUrl = env.CUNI_SERVICE_URL;
        if (!serviceUrl) return json({ error: "CUNI_SERVICE_URL is not configured" }, 501);
        const results = await emitViaService(source, seats, serviceUrl);
        return json({ verdict: judgeEmission(source, results) });
      }

      // --- demo simulation (clearly labeled; not part of production flow) ---
      const mDemo = path.match(/^\/api\/demo\/push\/([^/]+)$/);
      if (mDemo && req.method === "POST") {
        const body = await readJson(req);
        const files = (body.files ?? {}) as Record<string, string>;
        const message = String(body.message ?? "agent push (demo simulation)");
        const t = await svc.demoPush(mDemo[1], files, message);
        return json({ task: t, demo: true });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return err(e);
    }
  },

  // Artifacts event subscription: every push triggers a review pass.
  // Wire the queue to Artifacts events per the README.
  async queue(batch: any, env: Env): Promise<void> {
    const { tasks: svc } = services(env);
    for (const message of batch.messages) {
      const event = message.body as any;
      if (event?.type !== "cf.artifacts.repo.pushed") continue;
      const ref: string = event?.payload?.ref ?? "";
      const m = ref.match(/^agent\/(t-[\w-]+)$/);
      if (!m) continue; // not a task branch
      try {
        await svc.onPush(m[1]);
      } catch (e) {
        console.error("review-on-push failed", e);
      }
    }
  },
};

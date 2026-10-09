// tasks.ts — the task lifecycle. A task is one unit of agent work:
// one human intent -> one workspace branch -> one review -> one decision.
//
// Status flow: open -> in_review -> merged | rejected
// A push to the task branch moves open -> in_review and runs the review pass.

import { RepoStore } from "./store.js";
import { runReview, Review } from "./review.js";
import { LineDiff } from "./logic.js";

export type TaskStatus = "open" | "in_review" | "merged" | "rejected";

export interface Task {
  id: string;
  repo: string;
  branch: string;
  intent: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  workspace: { remote: string; token: string };
  review: Review | null;
  diff: LineDiff[] | null;
  mergeCommit?: string;
}

interface TaskBackend {
  get(id: string): Promise<Task | null>;
  put(task: Task): Promise<void>;
  list(): Promise<Task[]>;
}

class MemoryTaskBackend implements TaskBackend {
  private tasks = new Map<string, Task>();
  async get(id: string) { return this.tasks.get(id) ?? null; }
  async put(task: Task) { this.tasks.set(task.id, task); }
  async list() { return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt); }
}

class KvTaskBackend implements TaskBackend {
  constructor(private kv: KVNamespace) {}
  private key(id: string) { return `task:${id}`; }
  async get(id: string): Promise<Task | null> {
    return (await this.kv.get(this.key(id), "json")) as Task | null;
  }
  async put(task: Task): Promise<void> {
    await this.kv.put(this.key(idOf(task)), JSON.stringify(task));
    // maintain a simple index
    const idx = ((await this.kv.get("task:index", "json")) as string[] | null) ?? [];
    if (!idx.includes(task.id)) { idx.unshift(task.id); await this.kv.put("task:index", JSON.stringify(idx.slice(0, 500))); }
  }
  async list(): Promise<Task[]> {
    const idx = ((await this.kv.get("task:index", "json")) as string[] | null) ?? [];
    const out: Task[] = [];
    for (const id of idx) {
      const t = await this.get(id);
      if (t) out.push(t);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
}
function idOf(t: Task) { return t.id; }

export function makeTaskBackend(kv?: KVNamespace): TaskBackend {
  return kv ? new KvTaskBackend(kv) : new MemoryTaskBackend();
}

let seq = 0;
export function newTaskId(): string {
  seq += 1;
  return `t-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export class TaskService {
  constructor(private store: RepoStore, private backend: TaskBackend) {}

  async createIntent(repo: string, intent: string): Promise<Task> {
    const r = await this.store.getRepo(repo);
    if (!r) throw Object.assign(new Error(`unknown repo: ${repo}`), { status: 404 });
    const id = newTaskId();
    const ws = await this.store.forkForTask(repo, id);
    // Hand the agent the project's own instructions, if present.
    const instructions = await this.store.readFile(repo, r.defaultBranch, "AGENTS.md").catch(() => null);
    const task: Task = {
      id, repo, branch: ws.branch, intent,
      status: "open",
      createdAt: Date.now(), updatedAt: Date.now(),
      workspace: { remote: ws.remote, token: ws.token },
      review: null, diff: null,
    };
    void instructions; // passed to agents via the workspace in production
    await this.backend.put(task);
    return task;
  }

  async list(): Promise<Task[]> { return this.backend.list(); }
  async get(id: string): Promise<Task | null> { return this.backend.get(id); }

  /** Called when an agent pushes to the task branch (or the demo simulates it). */
  async onPush(taskId: string): Promise<Task> {
    const task = await this.backend.get(taskId);
    if (!task) throw Object.assign(new Error(`unknown task: ${taskId}`), { status: 404 });
    const r = await this.store.getRepo(task.repo);
    const diff = await this.store.diff(task.repo, r?.defaultBranch ?? "main", task.branch);
    const review = await runReview(task, diff);
    task.diff = diff;
    task.review = review;
    task.status = "in_review";
    task.updatedAt = Date.now();
    await this.backend.put(task);
    return task;
  }

  async approve(id: string): Promise<Task> {
    const task = await this.backend.get(id);
    if (!task) throw Object.assign(new Error(`unknown task: ${id}`), { status: 404 });
    if (task.status === "merged") return task;
    const r = await this.store.getRepo(task.repo);
    const { commit } = await this.store.mergeBranch(task.repo, task.branch, r?.defaultBranch ?? "main");
    task.status = "merged";
    task.mergeCommit = commit;
    task.updatedAt = Date.now();
    await this.backend.put(task);
    return task;
  }

  async reject(id: string): Promise<Task> {
    const task = await this.backend.get(id);
    if (!task) throw Object.assign(new Error(`unknown task: ${id}`), { status: 404 });
    task.status = "rejected";
    task.updatedAt = Date.now();
    await this.backend.put(task);
    return task;
  }

  /** Demo-only: simulate an agent pushing files to the task branch. */
  async demoPush(id: string, files: Record<string, string>, message: string): Promise<Task> {
    const task = await this.backend.get(id);
    if (!task) throw Object.assign(new Error(`unknown task: ${id}`), { status: 404 });
    await this.store.writeFiles(task.repo, task.branch, files, message);
    return this.onPush(id);
  }
}

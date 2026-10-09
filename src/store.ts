// store.ts — repository storage behind one interface.
//
// Production: ArtifactsStore, which speaks to Cloudflare Artifacts
// (the versioned filesystem that speaks Git) through the ARTIFACTS binding.
// Local dev / demo: MemoryStore, an in-memory git-shaped simulation with
// the same semantics (repos -> branches -> files, diff, merge).
// The Worker picks ArtifactsStore when the binding exists, else MemoryStore.

import { diffLines, LineDiff } from "./logic.js";

export interface RepoInfo {
  name: string;
  defaultBranch: string;
}

export interface TaskWorkspace {
  name: string;      // workspace repo name
  branch: string;    // branch agents work on
  remote: string;    // git remote URL for agents
  token: string;     // repo-scoped token for agents
}

export interface RepoStore {
  listRepos(): Promise<RepoInfo[]>;
  getRepo(name: string): Promise<RepoInfo | null>;
  createRepo(name: string, files?: Record<string, string>): Promise<RepoInfo>;
  forkForTask(repo: string, taskId: string): Promise<TaskWorkspace>;
  readFile(repo: string, ref: string, path: string): Promise<string | null>;
  listFiles(repo: string, ref: string): Promise<string[]>;
  writeFiles(repo: string, branch: string, files: Record<string, string>, message: string): Promise<{ commit: string }>;
  diff(repo: string, base: string, head: string): Promise<LineDiff[]>;
  mergeBranch(repo: string, head: string, base?: string): Promise<{ commit: string }>;
  branches(repo: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// ArtifactsStore — the real Cloudflare backend.
// API shape follows the Artifacts binding documented for the open beta:
//   const project = await env.ARTIFACTS.get("my-project");
//   const ws = await project.fork("task-<id>");   // -> { name, remote, token }
//   const repo = await env.ARTIFACTS.get(ws.name);
//   await repo.readFile({ ref, path });
// ---------------------------------------------------------------------------
export class ArtifactsStore implements RepoStore {
  constructor(private artifacts: any) {}

  async listRepos(): Promise<RepoInfo[]> {
    // The binding surfaces namespaces; fall back to a configured project list.
    // Real deployments enumerate via the Artifacts REST control plane.
    throw new Error("listRepos: enumerate via the Artifacts REST API for your namespace (see README)");
  }

  async getRepo(name: string): Promise<RepoInfo | null> {
    try {
      const repo = await this.artifacts.get(name);
      const info = await repo.info();
      return { name, defaultBranch: info.defaultBranch ?? "main" };
    } catch {
      return null;
    }
  }

  async createRepo(name: string, _files: Record<string, string> = {}): Promise<RepoInfo> {
    // Namespace creation goes through the REST control plane; the binding
    // operates on repos inside a namespace. See README for the setup.
    throw new Error("createRepo: create the repo via the Artifacts REST API or dashboard first");
  }

  async forkForTask(repo: string, taskId: string): Promise<TaskWorkspace> {
    const project = await this.artifacts.get(repo);
    const info = await project.info();
    const wsName = `task-${taskId}`;
    const ws = await project.fork(wsName);
    // Give agents the repo's own instructions, if the project keeps them.
    return {
      name: ws.name ?? wsName,
      branch: `agent/${taskId}`,
      remote: ws.remote,
      token: ws.token,
    };
  }

  async readFile(repo: string, ref: string, path: string): Promise<string | null> {
    const r = await this.artifacts.get(repo);
    const f = await r.readFile({ ref, path });
    if (!f) return null;
    return await f.text();
  }

  async listFiles(_repo: string, _ref: string): Promise<string[]> {
    throw new Error("listFiles: use the Artifacts REST tree endpoint (see README)");
  }

  async writeFiles(_repo: string, _branch: string, _files: Record<string, string>, _message: string): Promise<{ commit: string }> {
    throw new Error("writeFiles: agents push via git using the workspace remote + token");
  }

  async diff(_repo: string, _base: string, _head: string): Promise<LineDiff[]> {
    throw new Error("diff: use the Artifacts REST compare endpoint (see README)");
  }

  async mergeBranch(_repo: string, _head: string, _base = "main"): Promise<{ commit: string }> {
    // Merge via git on the workspace remote, or the REST merge endpoint.
    throw new Error("mergeBranch: merge via git client on the workspace remote (see README)");
  }

  async branches(_repo: string): Promise<string[]> {
    throw new Error("branches: use the Artifacts REST refs endpoint (see README)");
  }
}

// ---------------------------------------------------------------------------
// MemoryStore — in-memory git-shaped simulation. Same interface, zero
// network. Used for local dev, tests, and the demo seed. Branches are
// file maps; commits are content snapshots with messages.
// ---------------------------------------------------------------------------
interface MemBranch {
  files: Map<string, string>;
  commits: { id: string; message: string; at: number }[];
}

export class MemoryStore implements RepoStore {
  private repos = new Map<string, { defaultBranch: string; branches: Map<string, MemBranch> }>();
  private counter = 0;

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.counter}`;
  }

  async listRepos(): Promise<RepoInfo[]> {
    return [...this.repos.entries()].map(([name, r]) => ({ name, defaultBranch: r.defaultBranch }));
  }

  async getRepo(name: string): Promise<RepoInfo | null> {
    const r = this.repos.get(name);
    return r ? { name, defaultBranch: r.defaultBranch } : null;
  }

  async createRepo(name: string, files: Record<string, string> = {}): Promise<RepoInfo> {
    if (this.repos.has(name)) throw new Error(`repo exists: ${name}`);
    const branches = new Map<string, MemBranch>();
    branches.set("main", {
      files: new Map(Object.entries(files)),
      commits: [{ id: this.nextId("c"), message: "initial commit", at: Date.now() }],
    });
    this.repos.set(name, { defaultBranch: "main", branches });
    return { name, defaultBranch: "main" };
  }

  async forkForTask(repo: string, taskId: string): Promise<TaskWorkspace> {
    const r = this.repos.get(repo);
    if (!r) throw new Error(`unknown repo: ${repo}`);
    const branch = `agent/${taskId}`;
    const base = r.branches.get(r.defaultBranch)!;
    r.branches.set(branch, {
      files: new Map(base.files),
      commits: [{ id: this.nextId("c"), message: `task workspace for ${taskId}`, at: Date.now() }],
    });
    return { name: repo, branch, remote: `memory://${repo}#${branch}`, token: "demo-token" };
  }

  async readFile(repo: string, ref: string, path: string): Promise<string | null> {
    const b = this.repos.get(repo)?.branches.get(ref);
    if (!b) return null;
    return b.files.get(path) ?? null;
  }

  async listFiles(repo: string, ref: string): Promise<string[]> {
    const b = this.repos.get(repo)?.branches.get(ref);
    return b ? [...b.files.keys()].sort() : [];
  }

  async writeFiles(repo: string, branch: string, files: Record<string, string>, message: string): Promise<{ commit: string }> {
    const r = this.repos.get(repo);
    const b = r?.branches.get(branch);
    if (!r || !b) throw new Error(`unknown repo/branch: ${repo}#${branch}`);
    for (const [p, content] of Object.entries(files)) b.files.set(p, content);
    const id = this.nextId("c");
    b.commits.push({ id, message, at: Date.now() });
    return { commit: id };
  }

  async diff(repo: string, base: string, head: string): Promise<LineDiff[]> {
    const r = this.repos.get(repo);
    const bb = r?.branches.get(base);
    const hb = r?.branches.get(head);
    if (!r || !bb || !hb) throw new Error(`unknown repo/branch`);
    const paths = new Set([...bb.files.keys(), ...hb.files.keys()]);
    const out: LineDiff[] = [];
    for (const p of [...paths].sort()) {
      const oldT = bb.files.get(p) ?? "";
      const newT = hb.files.get(p) ?? "";
      if (oldT === newT) continue;
      const { added, removed, hunks } = diffLines(oldT, newT);
      out.push({ path: p, added, removed, hunks });
    }
    return out;
  }

  async mergeBranch(repo: string, head: string, base = "main"): Promise<{ commit: string }> {
    const r = this.repos.get(repo);
    const hb = r?.branches.get(head);
    const bb = r?.branches.get(base);
    if (!r || !hb || !bb) throw new Error(`unknown repo/branch`);
    for (const [p, content] of hb.files) bb.files.set(p, content);
    const id = this.nextId("c");
    bb.commits.push({ id, message: `merge ${head} into ${base}`, at: Date.now() });
    return { commit: id };
  }

  async branches(repo: string): Promise<string[]> {
    const r = this.repos.get(repo);
    return r ? [...r.branches.keys()].sort() : [];
  }
}

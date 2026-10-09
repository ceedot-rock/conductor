# Conductor — the all-AI git platform

**You speak. Agents do the git.**

Conductor is a rethink of the git platform for the agentic era, built on
Cloudflare Workers + Artifacts for the Cloudflare "next Git platform"
competition. There are no git commands for the human. You type (or speak)
an intent — *"add a 0.5% fee to every order"* — and agents fan out across
forked workspaces. A mission-control panel shows every agent, every branch,
and every diff live. One tap approves a change into main, or rejects it.

This is deliberately **not** "GitHub with agents bolted on." Repositories,
branches, and pull requests still exist underneath (agents speak git just
fine), but the human never touches them. The human's interface is intent in,
decision out.

## The differentiator: CuNi exactness

CuNi is a programming language with one hard rule: write once, and the code
behaves *exactly* the same in every language it builds for — or it refuses
to build at all. Conductor wires that in: speak an intent, and CuNi emits it
as Python, JavaScript, Go, or any of 144 languages, with byte-identical
stdout proven across seats — or a refusal with the diff. No other entrant
has this. See the **CuNi exactness** tab in the panel for a real,
compiler-generated example.

## Architecture

```
human intent ──► POST /api/intent ──► fork repo ──► agent workspace
                                                        │  (git push)
                                                        ▼
                                              push event ──► review pass
                                                        │     (heuristic + LLM hook)
                                                        ▼
                                              control panel: diff + review
                                                        │
                              ┌─────────────────────────┴─────────────────────────┐
                              ▼                                                   ▼
                    POST /tasks/:id/approve                              POST /tasks/:id/reject
                    merge branch → main                                     close task
```

- **Worker API** (`src/`): intents, tasks, approve/reject, automated
  reviews, CuNi verdicts. `src/store.ts` abstracts repository storage:
  `ArtifactsStore` (Cloudflare Artifacts binding) in production,
  `MemoryStore` (in-memory, same semantics) for local dev and demo.
- **Control panel** (`public/`): single-page app, no build step. Live task
  feed (3s poll), diff viewer, one-tap approve/reject, intent box.
- **CuNi module** (`src/cuni.ts`): the exactness verdict — byte-identical
  stdout across seats, or refuse with the diff. The Worker calls a CuNi
  emit service (`CUNI_SERVICE_URL`); `scripts/cuni-local.mjs` runs the
  real `cuni` binary locally for the demo.
- **Review** (`src/review.ts`): heuristic pass (diffstat, secret scan,
  TODO scan, size flags) plus an LLM hook via the Workers AI binding
  when configured.

## Run locally

```bash
npm install
npm test          # typecheck + 13 tests, all green
npm run dev       # wrangler dev → http://localhost:8787
# in another terminal:
npm run seed      # seeds 3 demo tasks + the real CuNi example
```

Open http://localhost:8787 — the panel is live. Dispatch an intent, watch
the task appear, inspect its diff and review, approve or reject.

## Deploy

```bash
npx wrangler login        # one manual step: fresh auth (the stored token on the build machine is dead)
npm run deploy            # wrangler deploy
```

Optional production pieces (all commented in `wrangler.toml`):
- `TASKS` KV namespace for task metadata: `wrangler kv namespace create TASKS`
- `ARTIFACTS` binding (open beta, Workers Paid plan)
- Queue consumer on `cf.artifacts.repo.pushed` → triggers the review pass
  (see `src/index.ts` `queue()` — already implemented, just wire the queue)
- `AI` binding (Workers AI) for the LLM review layer

Without them, the Worker runs on the in-memory store — fully functional
for demo and judging.

## API

| Method | Path | What |
|---|---|---|
| POST | /api/intent | `{ text, repo? }` → creates task + forks repo |
| GET | /api/tasks | list tasks (newest first) |
| GET | /api/tasks/:id | task with diff + review |
| POST | /api/tasks/:id/approve | merge branch → main |
| POST | /api/tasks/:id/reject | close task |
| POST | /api/tasks/:id/push | agent push notification → runs review |
| GET | /api/repos | list repos |
| POST | /api/cuni/emit | `{ source, seats[] }` → `{ verdict: EXACT \| REFUSE }` |

## Voice input (stretch)

The panel has a voice button, honestly marked *stretch*. The hook point:
WebRTC audio → speech-to-text → `POST /api/intent`. The text path is the
complete product; voice is a 20-line client addition once an STT endpoint
is chosen.

## License

Apache-2.0. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Workspace, ops, GK_DIR } from '@gatekeeper/core';

function findRoot(start: string): string {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, GK_DIR)) || fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return path.resolve(start);
    d = up;
  }
}

const argRoot = process.argv.indexOf('--root');
const root = argRoot > 0 ? path.resolve(process.argv[argRoot + 1]) : process.env.GK_ROOT ? path.resolve(process.env.GK_ROOT) : findRoot(process.cwd());

// One warm workspace; every call syncs first so edits made by the agent are always visible.
let wsP: Promise<Workspace> | null = null;
async function ws(): Promise<Workspace> {
  if (!wsP) wsP = Workspace.open(root);
  const w = await wsP;
  await w.sync();
  return w;
}

const server = new McpServer({ name: 'gatekeeper', version: '0.1.0' });

const reply = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (w: Workspace, a: z.objectOutputType<S, z.ZodTypeAny>) => unknown | Promise<unknown>) =>
  server.registerTool(name, { description, inputSchema: shape } as any, (async (a: any) => {
    try {
      return reply(await fn(await ws(), a));
    } catch (e: any) {
      return { ...reply({ ok: false, error: String(e?.message ?? e) }), isError: true };
    }
  }) as any);

tool('gk_init', 'Create .gatekeeper/ in the project root and build the first graph. Call once if gk_tree reports an empty store and the developer agrees.', {}, async (w) => {
  ops.init(w);
  return { root, ...(await ops.sync(w)) };
});

tool('gk_context', 'BUILD MODE first call. Budgeted (~8k token) context pack for a task or symbols: 2-hop graph, assumptions, outcomes, then source for hop-0 symbols. Work from this, not from reading files.',
  { task: z.string().optional(), symbols: z.array(z.string()).optional(), budget: z.number().optional() },
  (w, a) => ops.context(w, a));

tool('gk_plan', 'Write the subtask decomposition (3 to 7 units of the change, never steps of your own process). Each task is a branch; its nodes are the files or file:symbol targets it touches, each with a one-line note. The editor panel renders the tree immediately. replace=true redecomposes from scratch. Writing code is blocked until the developer approves each subtask in the panel.',
  {
    feature: z.string(),
    tasks: z.array(z.union([z.string(), z.object({ title: z.string(), nodes: z.array(z.object({ target: z.string(), note: z.string().optional() })).optional() })])).min(1),
    replace: z.boolean().optional(),
  },
  (w, a) => ops.plan(w, a));

tool('gk_next', 'Returns ONLY the next subtask: its nodes and graph context for those nodes, as a ready prompt. Call before writing code for each subtask. If not approved yet, it says to wait for the developer.',
  {}, (w) => ops.next(w));

tool('gk_record', 'Call IMMEDIATELY after each subtask code is written, never batched. assumes = what must stay TRUE for the code to keep working (not what it does).',
  {
    id: z.string(), status: z.enum(['done', 'failed', 'skipped', 'planned']).optional(), symbols: z.array(z.string()).optional(),
    assumes: z.array(z.string()).optional(), chose: z.string().optional(), rejected: z.string().optional(), why: z.string().optional(),
    by: z.enum(['agent', 'developer']).optional(),
  },
  (w, a) => ops.record(w, a));

tool('gk_tree', 'Current plan as app > feature > subtask > symbol, with assumptions and symbol health (missing / changed since recorded).',
  { feature: z.string().optional() }, (w, a) => ops.tree(w, a));

tool('gk_remove', 'Remove a subtask (or a whole feature) from the tree. History stays in intent.jsonl as a tombstone.',
  { id: z.string().optional(), feature: z.string().optional() }, (w, a) => ops.remove(w, a));

tool('gk_edit', 'Rename a subtask or move it to another feature.',
  { id: z.string(), title: z.string().optional(), feature: z.string().optional() }, (w, a) => ops.edit(w, a));

tool('gk_suspects', 'DEBUG MODE first call. Rank recorded subtasks against a symptom. Returns suspects, also_considered (promotable on assumption grounds), cleared (ids only). Score is lexical+structural: you must test each assumption against the symptom yourself.',
  { error: z.string().optional(), terms: z.array(z.string()).optional(), symbols: z.array(z.string()).optional() },
  (w, a) => ops.suspects(w, a));

tool('gk_check', 'Log whether a suspect was the true cause (confirmed) or ruled out (cleared). Feeds outcomes.jsonl and the meta loop.',
  { id: z.string(), result: z.enum(['confirmed', 'cleared']), qid: z.string().optional() }, (w, a) => ops.check(w, a));

tool('gk_miss', 'Log that the true cause was NOT in the record. Hiding misses makes the ranker unevaluable.',
  { note: z.string(), qid: z.string().optional() }, (w, a) => ops.miss(w, a));

tool('gk_verify', 'Outer loop: rebuild changed files, repair renames, report orphan rate and drift rate.', {}, (w) => ops.verify(w));
tool('gk_meta', 'Meta loop report: hit@1, hit@3, signal distribution. May write a weights proposal; never applies it.', {}, (w) => ops.meta(w));

await server.connect(new StdioServerTransport());

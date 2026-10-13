import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace, ops } from '../src/index.ts';
import { buildContext } from '../src/context.ts';

function fixture(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-'));
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'src/quota.ts'), `
import { store } from './store';
export function checkQuota(user: string): boolean {
  return store.count(user) < LIMIT;
}
const LIMIT = 10;
export class Meter { bump(user: string) { return checkQuota(user); } }
`);
  fs.writeFileSync(path.join(d, 'src/store.ts'), `export const store = { count(u: string) { return 0; } };\nexport function lookup(id: string) { return id; }\n`);
  fs.writeFileSync(path.join(d, 'src/api.ts'), `import { checkQuota } from './quota';\nexport function handle(u: string) { return checkQuota(u); }\n`);
  fs.writeFileSync(path.join(d, 'svc.py'), `import os\n\nCACHE = {}\n\ndef fetch(k):\n    return CACHE.get(k)\n\nclass Repo:\n    def load(self, k):\n        return fetch(k)\n`);
  return d;
}

test('parses ts and py, resolves cross-file calls, exposes the three queries', async () => {
  const d = fixture();
  const ws = await Workspace.open(d);
  assert.ok(ws.graph.has('src/quota.ts:checkQuota'));
  assert.ok(ws.graph.has('svc.py:Repo.load'));
  assert.ok(ws.graph.get('src/api.ts:handle')!.edges.some((e) => e.to === 'src/quota.ts:checkQuota' && e.kind === 'calls'));
  assert.ok(ws.graph.get('svc.py:Repo.load')!.edges.some((e) => e.to === 'svc.py:fetch'));
  assert.ok(ws.graph.get('svc.py:fetch')!.edges.some((e) => e.kind === 'dataflow' && e.to === 'svc.py:CACHE'));
  const blast = ws.graph.blastRadius('src/quota.ts:checkQuota');
  assert.ok(blast.has('src/api.ts:handle') && blast.has('src/quota.ts:Meter.bump'));
  assert.ok(ws.graph.pathBetween('src/api.ts:handle', 'src/store.ts:store'));
  assert.equal(ws.graph.neighbors('src/quota.ts:checkQuota', 1).dist.get('src/api.ts:handle'), 1);
});

test('tree is dynamic: removal and code edits show up', async () => {
  const d = fixture();
  const ws = await Workspace.open(d);
  const { tasks } = ops.plan(ws, { feature: 'quota', tasks: ['A', 'B'] });
  await ops.record(ws, { id: tasks[0].id, symbols: ['checkQuota'], assumes: ['store.count is monotonic within a window'] });
  assert.equal(ops.tree(ws).features[0].tasks.length, 2);
  ops.remove(ws, { id: tasks[1].id });
  assert.equal(ops.tree(ws).features[0].tasks.length, 1);
  // code edit: body changes, tree flags drift
  fs.writeFileSync(path.join(d, 'src/quota.ts'), fs.readFileSync(path.join(d, 'src/quota.ts'), 'utf8').replace('< LIMIT', '<= LIMIT'));
  const r = await ws.saveFile('src/quota.ts');
  assert.equal(r.status, 'updated');
  assert.ok(r.modified.includes('src/quota.ts:checkQuota'));
  assert.ok(r.blast.includes('src/api.ts:handle'));
  assert.equal(ops.tree(ws).features[0].tasks[0].symbols[0].drifted, true);
});

test('rename keeps intent attached (orphan rate 0)', async () => {
  const d = fixture();
  const ws = await Workspace.open(d);
  const { tasks } = ops.plan(ws, { feature: 'q', tasks: ['A'] });
  await ops.record(ws, { id: tasks[0].id, symbols: ['checkQuota'], assumes: ['x'] });
  for (const f of ['src/quota.ts', 'src/api.ts']) {
    const p = path.join(d, f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/checkQuota/g, 'enforceQuota'));
  }
  const rep = await ws.outer();
  assert.equal(rep.renamed.length, 1);
  assert.equal(rep.orphanCount, 0);
  assert.equal(ops.tree(ws).features[0].tasks[0].symbols[0].id, 'src/quota.ts:enforceQuota');
});

test('deleting a symbol surfaces as an orphan', async () => {
  const d = fixture();
  const ws = await Workspace.open(d);
  const { tasks } = ops.plan(ws, { feature: 'q', tasks: ['A'] });
  await ops.record(ws, { id: tasks[0].id, symbols: ['lookup'], assumes: ['x'] });
  fs.writeFileSync(path.join(d, 'src/store.ts'), `export const store = { count(u: string) { return 0; } };\n`);
  const rep = await ws.outer();
  assert.equal(rep.orphanCount, 1);
});

test('trap: a record with an assumption and zero lexical overlap is never cleared', async () => {
  const d = fixture();
  const ws = await Workspace.open(d);
  const { tasks } = ops.plan(ws, { feature: 'f', tasks: ['Quota guard', 'Memoize repo reads', 'Plain thing'] });
  await ops.record(ws, { id: tasks[0].id, symbols: ['checkQuota'], assumes: ['limit is read once at boot'] });
  await ops.record(ws, { id: tasks[1].id, symbols: ['Repo.load'], assumes: ['a 60s stale read is acceptable'] });
  await ops.record(ws, { id: tasks[2].id, symbols: ['lookup'] });
  const r = ops.suspects(ws, { error: 'checkQuota sometimes allows one request too many', symbols: ['checkQuota'] });
  assert.equal(r.suspects[0].id, tasks[0].id);
  assert.ok(r.also_considered.some((e) => e.id === tasks[1].id), 'caching record must be promotable');
  assert.ok(r.cleared.includes(tasks[2].id));
  assert.ok(!r.cleared.includes(tasks[1].id));
  assert.ok(ops.litBands(ws, r).get('svc.py:Repo.load')!.band === 'possible');
});

test('context budget drops source before assumptions', async () => {
  const d = fixture();
  const ws = await Workspace.open(d);
  const { tasks } = ops.plan(ws, { feature: 'f', tasks: ['Quota guard'] });
  await ops.record(ws, { id: tasks[0].id, symbols: ['checkQuota'], assumes: ['limit is read once at boot'], chose: 'const', rejected: 'env', why: 'speed' });
  // shrink the budget until something is dropped: the first casualty must be source, never an assumption
  let firstDrop: ReturnType<typeof buildContext> | null = null;
  for (let b = 3000; b > 100; b -= 25) {
    const p = buildContext(ws, { symbols: ['checkQuota'], budget: b, log: false });
    if (p.audit.dropped.length) { firstDrop = p; break; }
  }
  assert.ok(firstDrop);
  assert.ok(firstDrop!.audit.dropped.every((x) => x.section === 'source' || x.section === 'graph'), 'only source or graph edges drop first');
  assert.ok(firstDrop!.text.includes('limit is read once at boot'), 'assumption survives');
  const roomy = buildContext(ws, { symbols: ['checkQuota'], budget: 8000, log: false });
  assert.ok(roomy.text.includes('## Source'));
  assert.ok(roomy.tokens <= 8000);
});

test('meta never applies weights silently', async () => {
  const d = fixture();
  const ws = await Workspace.open(d);
  const r: any = ops.meta(ws);
  assert.equal(r.proposal, null);
  assert.ok(!fs.existsSync(ws.store.p('weights.json')));
});

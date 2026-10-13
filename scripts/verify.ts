/**
 * Phase 6 verification harness. Usage: tsx scripts/verify.ts <repo> "<context task>" [language]
 * Mutates files in the target repo temporarily (appends a comment) and restores them. Use a throwaway clone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Workspace, ops } from '../packages/core/src/index.ts';
import { tokenize } from '../packages/core/src/text.ts';

const repo = path.resolve(process.argv[2]);
const task = process.argv[3] ?? 'add validation';
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
const R: Record<string, unknown> = { repo: path.basename(repo) };

/* ---------- cold / warm ---------- */
const colds: number[] = [];
for (let i = 0; i < 3; i++) {
  fs.rmSync(path.join(repo, '.gatekeeper'), { recursive: true, force: true });
  const c = performance.now();
  await Workspace.open(repo);
  colds.push(Math.round(performance.now() - c));
}
R.cold_full_parse_ms_runs = colds;
R.cold_full_parse_ms_median = [...colds].sort((a, b) => a - b)[1];
let ws = await Workspace.open(repo);
let t = performance.now();
ws = await Workspace.open(repo);
R.warm_open_ms = Math.round(performance.now() - t);

const live = ws.graph.liveNodes();
const byType: Record<string, number> = {};
for (const n of live) byType[n.type] = (byType[n.type] ?? 0) + 1;
const edges = live.reduce((a, n) => a + n.edges.length, 0);
const unresolvedEdges = live.reduce((a, n) => a + n.edges.filter((e) => !e.resolved).length, 0);
const unresolvedNodes = byType.unresolved ?? 0;
const symbolNodes = live.filter((n) => ['function', 'class', 'data'].includes(n.type));
R.files = live.filter((n) => n.type === 'module').length;
R.nodes = live.length;
R.nodes_by_type = byType;
R.edges = edges;
R.unresolved_node_share = +(unresolvedNodes / live.length).toFixed(4);
R.unresolved_edge_share = +(unresolvedEdges / edges).toFixed(4);
R.symbols_with_unresolved_calls_share = +(symbolNodes.filter((n) => (n.props.unresolvedCalls ?? 0) > 0 || n.edges.some((e) => !e.resolved)).length / symbolNodes.length).toFixed(4);

/* ---------- inner loop ---------- */
const files = live.filter((n) => n.type === 'module' && !n.id.includes('test')).map((n) => n.id);
const pick = files.filter((_, i) => i % Math.max(1, Math.floor(files.length / 40)) === 0).slice(0, 40);
const samples: number[] = [];
const orig = new Map<string, string>();
for (const [i, f] of pick.entries()) {
  const abs = path.join(repo, f);
  const src = fs.readFileSync(abs, 'utf8');
  orig.set(f, src);
  fs.writeFileSync(abs, src + (f.endsWith('.py') ? `\n# gk-bench ${i}\n` : `\n// gk-bench ${i}\n`));
  const r = await ws.saveFile(f);
  samples.push(r.ms);
}
for (const [f, src] of orig) fs.writeFileSync(path.join(repo, f), src);
for (const f of pick) await ws.saveFile(f);
R.inner_loop_samples = samples.length;
R.inner_loop_p50_ms = +pct(samples, 50).toFixed(1);
R.inner_loop_p95_ms = +pct(samples, 95).toFixed(1);
R.inner_loop_max_ms = +Math.max(...samples).toFixed(1);
R.inner_loop_ceiling_ok = Math.max(...samples) <= 300;

/* ---------- context pack ---------- */
const pack = ops.context(ws, { task });
R.context_task = task;
R.context_pack_tokens = pack.tokens;
R.context_pack_included = pack.included;
R.context_pack_dropped = pack.dropped_count;
R.context_pack_seeds = pack.seeds.length;

/* ---------- pick fixtures ---------- */
const g = ws.graph;
const isTest = (id: string) => /test|spec|conftest/i.test(id);
const fns = live.filter((n) => n.type === 'function' && !isTest(n.id) && n.props.exported !== false);
const withDeps = fns.map((n) => ({ n, d: g.dependents(n.id).filter((x) => g.get(x)?.type !== 'module').length })).filter((x) => x.d >= 1).sort((a, b) => b.d - a.d);

/* ---------- orphan rate after a deliberate rename refactor ---------- */
await ops.sync(ws);
ops.plan(ws, { feature: 'bench-rename', tasks: Array.from({ length: 10 }, (_, i) => `unit ${i}`) });
const tasks = [...ws.intent().tasks.values()].filter((x) => x.feature === 'bench-rename');
const renameTargets: typeof withDeps = [];
const seenFiles = new Set<string>();
for (const c of withDeps) {
  if (!c.n.props.file || seenFiles.has(c.n.props.file) || c.n.props.parent) continue;
  if (!/^[A-Za-z_][A-Za-z0-9_]{4,}$/.test(c.n.props.name)) continue;
  seenFiles.add(c.n.props.file);
  renameTargets.push(c);
  if (renameTargets.length === 3) break;
}
const recorded = [...renameTargets.map((c) => c.n.id), ...withDeps.slice(10, 17).map((c) => c.n.id)].slice(0, 10);
for (const [i, id] of recorded.entries()) await ops.record(ws, { id: tasks[i].id, symbols: [id], assumes: [`${id.split(':')[1]} inputs are already validated`], by: 'agent' });
const before = ws.report(ws.intent());
const touched = new Map<string, string>();
for (const c of renameTargets) {
  const name = c.n.props.name;
  for (const f of files) {
    const abs = path.join(repo, f);
    const s = touched.get(f) ?? fs.readFileSync(abs, 'utf8');
    const re = new RegExp(`\\b${name}\\b`, 'g');
    if (re.test(s)) {
      if (!touched.has(f)) orig.set(f, s);
      touched.set(f, s.replace(new RegExp(`\\b${name}\\b`, 'g'), `${name}Renamed`));
    }
  }
}
for (const [f, s] of touched) fs.writeFileSync(path.join(repo, f), s);
const rep = await ws.outer();
const withRename = ws.report(ws.intent());
const withoutRename = recorded.filter((id) => !ws.graph.has(id)).length;
R.rename_refactor = {
  symbols_with_intent: before.intentSymbols, renamed_symbols: renameTargets.length, files_rewritten: touched.size,
  rename_edges_recorded: rep.renamed.length, rename_confidence: rep.renamed.map((r) => r.conf),
  orphans_with_rename_edges: withRename.orphanCount, orphan_rate_with_rename_edges: withRename.orphanRate,
  orphans_if_ids_were_not_followed: withoutRename, orphan_rate_if_not_followed: withoutRename / before.intentSymbols,
  outer_loop_ms: Math.round(rep.ms),
};
for (const [f, s] of touched) fs.writeFileSync(path.join(repo, f), orig.get(f)!);
await ws.outer();

/* ---------- THE ranking test ---------- */
fs.rmSync(ws.store.p('intent.jsonl'), { force: true });
fs.rmSync(ws.store.p('outcomes.jsonl'), { force: true });
ws.store.init();
const symptomTail = 'sometimes returns an outdated answer right after a change, and a retry fixes it';
const failing = withDeps.find((c) => !c.n.props.parent && g.blastRadius(c.n.id).size >= 2) ?? withDeps[0];
const failId = failing.n.id;
const symptom = `${failing.n.props.name} ${symptomTail}`;
const near = new Set([...g.neighbors(failId, 2).dist.keys(), ...g.blastRadius(failId).keys()]);
const symptomToks = new Set(tokenize(symptom));
const cacheCand = fns.filter((c) => !near.has(c.id) && !isTest(c.id) && c.props.file !== failing.n.props.file && !tokenize(`${c.props.name} Memoize lookups in memory cache`).some((x) => symptomToks.has(x)));
const cacheSym = cacheCand[Math.floor(cacheCand.length / 3)].id;
const decoyIds = [...g.neighbors(failId, 1).dist.keys()].filter((i) => i !== failId && g.get(i)?.type === 'function').slice(0, 2).concat([...g.blastRadius(failId).keys()].filter((i) => g.get(i)?.type === 'function').slice(0, 2));
const unrelated = fns.filter((c) => !near.has(c.id) && c.id !== cacheSym).slice(0, 3).map((c) => c.id);

ops.plan(ws, { feature: 'seeded', tasks: ['Memoize lookups in memory', ...decoyIds.map((_, i) => `Decoy ${i}`), ...unrelated.map((_, i) => `Unrelated ${i}`)] });
const ts = [...ws.intent().tasks.values()].filter((x) => x.feature === 'seeded');
await ops.record(ws, { id: ts[0].id, symbols: [cacheSym], assumes: ['a 60s stale read is acceptable to every caller'], chose: 'in-process memo', rejected: 'shared cache', why: 'no extra round trip', by: 'agent' });
for (const [i, id] of decoyIds.entries()) await ops.record(ws, { id: ts[1 + i].id, symbols: [id], assumes: [`${g.get(id)!.props.name} receives already normalized input`], by: 'agent' });
for (const [i, id] of unrelated.entries()) await ops.record(ws, { id: ts[1 + decoyIds.length + i].id, symbols: [id], by: 'agent' });

const lexicalOverlap = tokenize(`Memoize lookups in memory ${ws.graph.get(cacheSym)!.props.name} a 60s stale read is acceptable to every caller in-process memo shared cache no extra round trip`).filter((x) => symptomToks.has(x));
const res = ops.suspects(ws, { error: symptom });
const bands = ops.litBands(ws, res);
const cacheTask = ts[0].id;
const where = res.suspects.some((s) => s.id === cacheTask) ? 'suspects' : res.also_considered.some((s) => s.id === cacheTask) ? 'also_considered' : res.cleared.includes(cacheTask) ? 'cleared' : 'missing';
const entry = [...res.suspects, ...res.also_considered].find((s) => s.id === cacheTask);
R.ranking_test = {
  symptom, failing_symbol: failId, caching_symbol: cacheSym, lexical_overlap_with_symptom: lexicalOverlap,
  caching_record_band: where, caching_record_rank: entry?.rank ?? null, caching_record_lit_in_panel: bands.get(cacheSym)?.band ?? null,
  suspects: res.suspects.map((s) => `${s.id}:${s.score}`), also_considered: res.also_considered.map((s) => `${s.id}:${s.score}`), cleared: res.cleared,
  PASS: where !== 'cleared' && where !== 'missing' && !!bands.get(cacheSym) && bands.get(cacheSym)!.band !== 'cleared' && lexicalOverlap.length === 0,
};
ops.check(ws, { id: cacheTask, result: 'confirmed' });
ops.check(ws, { id: res.suspects[0]?.id ?? ts[1].id, result: 'cleared' });
R.meta_after_one_check = (({ hit_at_1, hit_at_3, cause_ranks }) => ({ hit_at_1, hit_at_3, cause_ranks }))(ops.meta(ws) as any);

console.log(JSON.stringify(R, null, 2));

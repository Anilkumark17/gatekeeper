import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from './workspace.js';
import { followRename, now } from './store.js';
import { tokenize, estimateTokens, ago } from './text.js';
import type { Subtask } from './types.js';

export interface PackAudit {
  budget: number;
  used: number;
  included: Record<string, number>;
  dropped: { section: string; ref: string; tokens: number; reason: string }[];
}

export interface ContextPack {
  seeds: string[];
  text: string;
  tokens: number;
  audit: PackAudit;
}

interface Item {
  section: 'graph' | 'assumptions' | 'decisions' | 'outcomes' | 'source';
  ref: string;
  text: string;
  /** graph items only: hop distance of the nearer endpoint */
  hop?: number;
}

const KIND_RANK: Record<string, number> = { calls: 0, extends: 0, dataflow: 1, imports: 2 };
const short = (id: string) => id;

function pickSeeds(ws: Workspace, task: string | undefined, symbols: string[]): string[] {
  const seeds: string[] = [];
  for (const s of symbols) for (const id of ws.graph.find(s).slice(0, 3)) if (!seeds.includes(id)) seeds.push(id);
  if (seeds.length || !task) return seeds;
  const toks = new Set(tokenize(task));
  if (!toks.size) return seeds;
  const state = ws.intent();
  const intentBoost = new Map<string, number>();
  for (const t of state.tasks.values()) {
    const tt = tokenize([t.title, t.feature, ...t.assumes].join(' '));
    const hits = tt.filter((x) => toks.has(x)).length;
    if (hits) for (const s of t.symbols) intentBoost.set(followRename(state.renames, s), (intentBoost.get(followRename(state.renames, s)) ?? 0) + hits);
  }
  const scored: [string, number][] = [];
  for (const n of ws.graph.nodes.values()) {
    if (n.type === 'external' || n.type === 'unresolved' || n.type === 'module') continue;
    const nameToks = tokenize(n.props.name);
    let s = 0;
    for (const t of nameToks) if (toks.has(t)) s += 3;
    const pathToks = tokenize(n.props.file ?? '');
    for (const t of pathToks) if (toks.has(t)) s += 1;
    if (s > 0) s += (intentBoost.get(n.id) ?? 0) * 2 + (n.props.exported ? 0.5 : 0);
    if (s > 0) scored.push([n.id, s]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, 5).map((x) => x[0]);
}

function readSource(ws: Workspace, id: string, maxLines = 70): string | null {
  const n = ws.graph.get(id);
  if (!n?.props.file || n.props.line == null) return null;
  try {
    const lines = fs.readFileSync(path.join(ws.root, n.props.file), 'utf8').split('\n');
    const end = Math.min(n.props.endLine ?? n.props.line, n.props.line + maxLines - 1);
    const body = lines.slice(n.props.line - 1, end).join('\n');
    const trunc = (n.props.endLine ?? 0) > end ? '\n// … truncated' : '';
    return `${n.props.file}:${n.props.line}-${end}\n${body}${trunc}`;
  } catch {
    return null;
  }
}

function taskLines(t: Subtask, state: ReturnType<Workspace['intent']>) {
  const head = `[${t.id}] ${t.title} (${t.status}${t.by ? ', ' + t.by : ''}, ${ago(t.ts)}) -> ${t.symbols.map((s) => followRename(state.renames, s)).join(', ') || 'no symbols'}`;
  const assume = t.assumes.length ? `${head}\n  assumes: ${t.assumes.join(' | ')}` : head;
  const dec = [t.chose && `chose: ${t.chose}`, t.rejected && `rejected: ${t.rejected}`, t.why && `why: ${t.why}`].filter(Boolean).join('; ');
  return { assume, dec: dec ? `[${t.id}] ${dec}` : '' };
}

/**
 * Assemble a budgeted context pack. Priority: graph (2 hops) > intent (assumptions first) > outcomes > source at hop 0.
 * Source is always the first thing dropped; assumptions are the last.
 */
export function buildContext(ws: Workspace, opts: { task?: string; symbols?: string[]; budget?: number; log?: boolean }): ContextPack {
  const budget = opts.budget ?? ws.cfg.tokenBudget;
  const seeds = pickSeeds(ws, opts.task, opts.symbols ?? []);
  const sub = ws.graph.neighbors(seeds, 2);
  const state = ws.intent();
  const items: Item[] = [];

  // 1. graph edges, nearest first, structural kinds before import noise
  const edges = sub.edges
    .map((e) => ({ ...e, hop: Math.min(sub.dist.get(e.from) ?? 9, sub.dist.get(e.to) ?? 9) }))
    .sort((a, b) => a.hop - b.hop || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  for (const e of edges) {
    items.push({ section: 'graph', ref: `${e.from}>${e.to}`, hop: e.hop, text: `${short(e.from)} -${e.kind}${e.resolved ? '' : '?'}-> ${short(e.to)}` });
  }

  // 2/3. intent for symbols in the subgraph
  const inGraph = new Set(sub.dist.keys());
  const rel: { t: Subtask; d: number }[] = [];
  for (const t of state.tasks.values()) {
    if (t.status === 'planned' && !t.assumes.length) continue;
    const ds = t.symbols.map((s) => sub.dist.get(followRename(state.renames, s))).filter((d): d is number => d !== undefined);
    if (ds.length) rel.push({ t, d: Math.min(...ds) });
  }
  rel.sort((a, b) => a.d - b.d);
  for (const { t } of rel) {
    const l = taskLines(t, state);
    items.push({ section: 'assumptions', ref: t.id, text: l.assume });
    if (l.dec) items.push({ section: 'decisions', ref: t.id, text: l.dec });
  }

  // outcomes for the same subtasks
  const relIds = new Set(rel.map((r) => r.t.id));
  const outcomes = ws.store.outcomeEvents().filter((e) => e.k === 'check' && relIds.has(e.id));
  const qs = new Map(ws.store.outcomeEvents().filter((e) => e.k === 'query').map((e) => [(e as any).qid, e as any]));
  for (const o of outcomes) {
    if (o.k !== 'check') continue;
    const q = qs.get(o.qid);
    items.push({ section: 'outcomes', ref: o.id, text: `${o.id} ${o.result.toUpperCase()} for symptom "${(q?.error ?? '').slice(0, 80)}" (${ago(o.ts)})` });
  }

  // 4. source for hop zero only
  for (const s of seeds) {
    const src = readSource(ws, s);
    if (src) items.push({ section: 'source', ref: s, text: src });
  }

  // ---- budgeted selection ----
  const included: Record<string, number> = {};
  const dropped: PackAudit['dropped'] = [];
  const take = new Set<Item>();
  let used = 120; // header allowance
  const tryAdd = (it: Item, cap = budget): boolean => {
    const tk = estimateTokens(it.text);
    if (used + tk > cap) {
      dropped.push({ section: it.section, ref: it.ref, tokens: tk, reason: cap < budget ? 'section cap' : 'over budget' });
      return false;
    }
    used += tk;
    take.add(it);
    included[it.section] = (included[it.section] ?? 0) + 1;
    return true;
  };
  const graphItems = items.filter((i) => i.section === 'graph');
  const graphCap = Math.floor(budget * 0.4);
  let graphUsed = 0;
  // assumptions are the densest context per token: graph edges may never squeeze them out
  let reserve = items.filter((i) => i.section === 'assumptions').reduce((a, i) => a + estimateTokens(i.text), 0);
  const addGraph = (it: Item) => {
    const tk = estimateTokens(it.text);
    if (used + tk + reserve > budget) return void dropped.push({ section: 'graph', ref: it.ref, tokens: tk, reason: 'budget reserved for assumptions' });
    if (graphUsed + tk > graphCap) return void dropped.push({ section: 'graph', ref: it.ref, tokens: tk, reason: 'graph cap (40%)' });
    if (tryAdd(it)) graphUsed += tk;
  };
  graphItems.filter((i) => (i.hop ?? 0) <= 1).slice(0, 400).forEach(addGraph);
  items.filter((i) => i.section === 'assumptions').forEach((i) => {
    reserve -= estimateTokens(i.text);
    tryAdd(i);
  });
  graphItems.filter((i) => (i.hop ?? 0) > 1).forEach(addGraph);
  items.filter((i) => i.section === 'decisions').forEach((i) => tryAdd(i));
  items.filter((i) => i.section === 'outcomes').forEach((i) => tryAdd(i));
  items.filter((i) => i.section === 'source').forEach((i) => tryAdd(i));
  // spare budget: refill graph edges that only missed the 40% cap, nearest first. Never displaces anything above.
  for (const it of graphItems) {
    if (take.has(it)) continue;
    const tk = estimateTokens(it.text);
    if (used + tk > budget) break;
    used += tk;
    take.add(it);
    included.graph = (included.graph ?? 0) + 1;
    const k = dropped.findIndex((d) => d.section === 'graph' && d.ref === it.ref);
    if (k >= 0) dropped.splice(k, 1);
  }

  const sec = (name: string, section: Item['section'], note = '') => {
    const lines = items.filter((i) => i.section === section && take.has(i)).map((i) => i.text);
    return lines.length ? `## ${name}${note}\n${lines.join(section === 'source' ? '\n\n' : '\n')}` : '';
  };
  const unresolved = [...sub.dist.keys()].filter((id) => ws.graph.get(id)?.type === 'unresolved');
  const parts = [
    `# GateKeeper context (${seeds.length} symbols in play: ${seeds.join(', ') || 'none matched'})`,
    sec('Graph (2 hops; "?" = static analysis could not resolve)', 'graph'),
    [sec('Assumptions and intent', 'assumptions'), sec('Decisions', 'decisions')].filter(Boolean).join('\n'),
    sec('Past outcomes', 'outcomes'),
    sec('Source (hop 0)', 'source'),
    unresolved.length ? `## Unresolved\n${unresolved.map((u) => `${u} (${ws.graph.get(u)?.props.reason})`).join('\n')}` : '',
  ].filter(Boolean);
  const text = parts.join('\n\n');
  const audit: PackAudit = { budget, used: estimateTokens(text), included, dropped };
  if (opts.log !== false) {
    try {
      fs.mkdirSync(ws.store.p('cache'), { recursive: true });
      fs.appendFileSync(ws.store.p('cache', 'packs.log.jsonl'), JSON.stringify({ ts: now(), task: opts.task, seeds, audit: { ...audit, dropped: dropped.slice(0, 200) } }) + '\n');
    } catch {
      /* audit log is best effort */
    }
  }
  return { seeds, text, tokens: audit.used, audit };
}

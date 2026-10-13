import type { Workspace } from './workspace.js';
import { followRename, nextTaskId, now } from './store.js';
import { buildContext } from './context.js';
import { rankSuspects } from './suspects.js';
import { metaReport, acceptProposal, rejectProposal } from './meta.js';
import { ago } from './text.js';
import type { Subtask, SubtaskStatus } from './types.js';

/**
 * Operations shared by the CLI, the MCP server and the editor. Each returns plain JSON.
 * Every write goes through the append-only logs; nothing here edits history.
 */

export function init(ws: Workspace) {
  ws.store.init();
  return { ok: true, dir: ws.store.dir };
}

export function plan(ws: Workspace, a: { feature: string; tasks: string[]; replace?: boolean }) {
  ws.store.init();
  const ev = ws.store.intentEvents();
  const state = ws.intent();
  const t = now();
  if (a.replace) {
    for (const s of state.tasks.values()) if (s.feature === a.feature && s.status === 'planned') ws.store.appendIntent({ k: 'remove', id: s.id, ts: t });
  }
  const next = nextTaskId(ev);
  const base = [...state.tasks.values()].filter((s) => s.feature === a.feature).length;
  const created = a.tasks.map((title, i) => {
    const id = next();
    ws.store.appendIntent({ k: 'plan', id, feature: a.feature, title, order: base + i, ts: t });
    return { id, title };
  });
  return { feature: a.feature, tasks: created };
}

export interface RecordArgs {
  id: string;
  status?: SubtaskStatus;
  symbols?: string[];
  assumes?: string[];
  chose?: string;
  rejected?: string;
  why?: string;
  by?: 'agent' | 'developer';
}

export async function record(ws: Workspace, a: RecordArgs) {
  ws.store.init();
  // settle renames from earlier work before resolving this record's symbols
  const delta = await ws.outer();
  const warnings: string[] = [];
  const symbols: string[] = [];
  const sigs: Record<string, string> = {};
  for (const s of a.symbols ?? []) {
    const hits = ws.graph.find(s);
    let id: string | undefined = hits.length === 1 ? hits[0] : hits.find((h) => h.endsWith(':' + s)) ;
    if (!id && hits.length > 1) {
      warnings.push(`symbol "${s}" is ambiguous (${hits.slice(0, 4).join(', ')}); using ${hits[0]}. Pass the full id.`);
      id = hits[0];
    }
    if (!id) {
      warnings.push(`symbol "${s}" not found in the graph; stored as given`);
      id = s;
    }
    symbols.push(id);
    const sig = ws.graph.get(id)?.props.sig;
    if (sig) sigs[id] = sig;
  }
  if (!ws.intent().tasks.has(a.id)) warnings.push(`${a.id} was not planned; created on the fly`);
  ws.store.appendIntent({
    k: 'record', id: a.id, status: a.status ?? 'done', symbols, assumes: a.assumes ?? [],
    chose: a.chose, rejected: a.rejected, why: a.why, by: a.by ?? 'agent', sigs, ts: now(),
  });
  await ws.outer(); // persist the snapshot this record was made against
  return { ok: true, id: a.id, symbols, warnings, renamed: delta.renamed };
}

export function edit(ws: Workspace, a: { id: string; title?: string; feature?: string }) {
  ws.store.appendIntent({ k: 'edit', id: a.id, title: a.title, feature: a.feature, ts: now() });
  return { ok: true };
}

export function remove(ws: Workspace, a: { id?: string; feature?: string }) {
  const state = ws.intent();
  const ids = a.id ? [a.id] : [...state.tasks.values()].filter((t) => t.feature === a.feature).map((t) => t.id);
  const t = now();
  for (const id of ids) if (state.tasks.has(id)) ws.store.appendIntent({ k: 'remove', id, ts: t });
  return { ok: true, removed: ids.filter((i) => state.tasks.has(i)) };
}

export interface TreeSymbol {
  id: string;
  /** exists | missing (orphaned) */
  state: 'ok' | 'missing';
  renamedFrom?: string;
  drifted: boolean;
  file?: string;
  line?: number;
}
export interface TreeTask {
  id: string;
  title: string;
  status: SubtaskStatus;
  by?: string;
  age: string;
  assumes: string[];
  chose?: string;
  rejected?: string;
  why?: string;
  symbols: TreeSymbol[];
}
export interface TreeFeature {
  feature: string;
  tasks: TreeTask[];
}

export function tree(ws: Workspace, a: { feature?: string } = {}): { app: string; features: TreeFeature[] } {
  const state = ws.intent();
  const byFeature = new Map<string, Subtask[]>();
  for (const t of state.tasks.values()) {
    if (a.feature && t.feature !== a.feature) continue;
    byFeature.set(t.feature, [...(byFeature.get(t.feature) ?? []), t]);
  }
  const features: TreeFeature[] = [];
  for (const [feature, ts] of byFeature) {
    ts.sort((x, y) => x.order - y.order || x.createdTs.localeCompare(y.createdTs));
    features.push({
      feature,
      tasks: ts.map((t) => ({
        id: t.id, title: t.title, status: t.status, by: t.by, age: ago(t.ts), assumes: t.assumes, chose: t.chose, rejected: t.rejected, why: t.why,
        symbols: t.symbols.map((s) => {
          const cur = followRename(state.renames, s);
          const n = ws.graph.get(cur);
          const recorded = t.sigs?.[s];
          return {
            id: cur, state: n ? 'ok' : 'missing', renamedFrom: cur !== s ? s : undefined,
            drifted: !!(n && recorded && n.props.sig && n.props.sig !== recorded), file: n?.props.file, line: n?.props.line,
          } as TreeSymbol;
        }),
      })),
    });
  }
  return { app: ws.root.split(/[\\/]/).pop() ?? 'app', features };
}

const ICON: Record<string, string> = { planned: '[ ]', done: '[x]', failed: '[!]', skipped: '[-]' };
export function renderTree(t: ReturnType<typeof tree>): string {
  const out = [t.app];
  for (const f of t.features) {
    out.push(`  ${f.feature}`);
    for (const k of f.tasks) {
      out.push(`    ${ICON[k.status]} ${k.id} ${k.title}${k.by ? ` (${k.by}, ${k.age})` : ''}`);
      for (const a of k.assumes) out.push(`        assumes: ${a}`);
      for (const s of k.symbols) out.push(`        - ${s.id}${s.state === 'missing' ? '  (MISSING)' : ''}${s.drifted ? '  (changed since recorded)' : ''}${s.renamedFrom ? `  (was ${s.renamedFrom})` : ''}`);
    }
  }
  return out.join('\n');
}

export function context(ws: Workspace, a: { task?: string; symbols?: string[]; budget?: number }) {
  const p = buildContext(ws, a);
  return { seeds: p.seeds, tokens: p.tokens, budget: p.audit.budget, included: p.audit.included, dropped_count: p.audit.dropped.length, dropped: p.audit.dropped.slice(0, 25), pack: p.text };
}

export function suspects(ws: Workspace, a: { error?: string; terms?: string[]; symbols?: string[] }) {
  return rankSuspects(ws, a);
}

export function check(ws: Workspace, a: { id: string; result: 'confirmed' | 'cleared'; qid?: string }) {
  const evs = ws.store.outcomeEvents();
  const queries = evs.filter((e) => e.k === 'query') as Extract<(typeof evs)[number], { k: 'query' }>[];
  const q = a.qid ? queries.find((x) => x.qid === a.qid) : [...queries].reverse().find((x) => x.ranking.some((r) => r.id === a.id));
  if (!q) return { ok: false, error: `no suspects query contains ${a.id}; run gk suspects first` };
  const r = q.ranking.find((x) => x.id === a.id);
  if (!r) return { ok: false, error: `${a.id} was not ranked in ${q.qid}` };
  ws.store.appendOutcome({ k: 'check', qid: q.qid, id: a.id, result: a.result, rank: r.rank, band: r.band, signals: r.signals, ts: now() });
  return { ok: true, qid: q.qid, id: a.id, result: a.result, rank: r.rank, band: r.band };
}

export function miss(ws: Workspace, a: { qid?: string; note: string }) {
  const queries = ws.store.outcomeEvents().filter((e) => e.k === 'query') as { qid: string }[];
  const qid = a.qid ?? queries[queries.length - 1]?.qid;
  if (!qid) return { ok: false, error: 'no query to attach the miss to' };
  ws.store.appendOutcome({ k: 'miss', qid, note: a.note, ts: now() });
  return { ok: true, qid };
}

export async function verify(ws: Workspace) {
  const d = await ws.outer();
  const state = ws.intent();
  let drift = 0;
  let checked = 0;
  for (const t of state.tasks.values()) {
    for (const [id, sig] of Object.entries(t.sigs ?? {})) {
      const n = ws.graph.get(followRename(state.renames, id));
      if (!n) continue;
      checked++;
      if (n.props.sig && n.props.sig !== sig) drift++;
    }
  }
  const live = ws.graph.liveNodes();
  const unresolved = live.filter((n) => n.type === 'unresolved').length;
  return {
    orphan_count: d.orphanCount, orphan_rate: d.orphanRate, intent_symbols: d.intentSymbols, orphans: d.orphans.slice(0, 50),
    drift_rate: checked ? drift / checked : 0, drifted_symbols: drift,
    delta: { added: d.added.length, removed: d.removed.length, modified: d.modified.length, renamed: d.renamed, first_run: d.firstRun },
    graph: { nodes: d.nodes, edges: d.edges, unresolved_nodes: unresolved, unresolved_share: d.nodes ? unresolved / (d.nodes + unresolved) : 0 },
    outer_ms: Math.round(d.ms),
  };
}

export function meta(ws: Workspace, a: { accept?: string; reject?: string } = {}) {
  if (a.accept) return { accepted: acceptProposal(ws, a.accept) };
  if (a.reject) return rejectProposal(a.reject), { rejected: a.reject };
  return metaReport(ws);
}

export async function sync(ws: Workspace) {
  const d = await ws.outer();
  return { ok: true, nodes: d.nodes, edges: d.edges, ms: Math.round(d.ms), renamed: d.renamed, orphan_count: d.orphanCount };
}

export type Band = 'likely' | 'possible' | 'cleared';
export interface BandInfo {
  band: Band;
  tasks: string[];
  reasons: string[];
}

/**
 * Which symbols light up in the editor and panel for a ranking. Cleared records stay in the map (dimmed, never hidden).
 * Shared by the extension and the verification harness so "lit" means the same thing in both.
 */
export function litBands(ws: Workspace, result: ReturnType<typeof suspects>): Map<string, BandInfo> {
  const out = new Map<string, BandInfo>();
  const rank = { likely: 3, possible: 2, cleared: 1 } as const;
  const put = (e: { id: string; symbols: string[]; reasons: string[] }, band: Band) => {
    for (const s of e.symbols) {
      const cur = out.get(s);
      if (!cur || rank[band] > rank[cur.band]) out.set(s, { band, tasks: [e.id], reasons: [...e.reasons] });
      else if (rank[band] === rank[cur.band]) {
        cur.tasks.push(e.id);
        cur.reasons.push(...e.reasons);
      }
    }
  };
  result.suspects.forEach((e) => put(e, 'likely'));
  result.also_considered.forEach((e) => put(e, 'possible'));
  const cleared = new Set(result.cleared);
  for (const f of tree(ws).features) {
    for (const t of f.tasks) {
      if (cleared.has(t.id)) put({ id: t.id, symbols: t.symbols.map((s) => s.id), reasons: ['no signal links it to this symptom, and it records no assumption'] }, 'cleared');
    }
  }
  return out;
}

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { Workspace } from './workspace.js';
import { followRename, now, type RankedEntry } from './store.js';
import { tokenize, ageDays, ago } from './text.js';
import { DEFAULT_WEIGHTS, type Subtask, type Weights } from './types.js';

export interface SuspectEntry {
  id: string;
  title: string;
  feature: string;
  score: number;
  rank: number;
  reasons: string[];
  signals: Record<string, number>;
  symbols: string[];
  assumes: string[];
  chose?: string;
  rejected?: string;
  why?: string;
  by?: string;
  age: string;
  /** symbol bodies changed since the record was written, so the assumption may be stale */
  drifted: boolean;
}

export interface SuspectResult {
  qid: string;
  named_symbols: string[];
  terms: string[];
  suspects: SuspectEntry[];
  also_considered: SuspectEntry[];
  cleared: string[];
  not_evaluated: number;
  weights: Weights;
  note: string;
}

export function loadWeights(ws: Workspace): Weights {
  try {
    return { ...DEFAULT_WEIGHTS, ...JSON.parse(fs.readFileSync(ws.store.p('weights.json'), 'utf8')) };
  } catch {
    return { ...DEFAULT_WEIGHTS };
  }
}

const HOP_WORD = ['is', 'one hop from', 'two hops from'];

function gitChurn(root: string): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const txt = execFileSync('git', ['log', '--since=30.days', '--name-only', '--format='], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    for (const l of txt.split('\n')) if (l.trim()) out.set(l.trim(), (out.get(l.trim()) ?? 0) + 1);
  } catch {
    /* not a git repo */
  }
  return out;
}

/** Symbols named in an error: explicit, stack frames (file:line), and identifiers that match graph names. */
export function namedSymbols(ws: Workspace, error: string, explicit: string[]): string[] {
  const out: string[] = [];
  const push = (id: string) => out.includes(id) || out.push(id);
  for (const s of explicit) for (const id of ws.graph.find(s).slice(0, 3)) push(id);
  for (const m of error.matchAll(/([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|py))[:"', ]+(?:line )?(\d+)/g)) {
    const f = m[1].replace(/\\/g, '/');
    const file = ws.linker.allFiles().find((x) => f.endsWith(x));
    if (file) {
      const n = ws.graph.symbolAt(file, +m[2]);
      if (n) push(n.id);
    }
  }
  for (const tok of new Set(error.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? [])) {
    if (!/[A-Z_]|[a-z][A-Z]/.test(tok) && tok.length < 6) continue;
    const hits = ws.graph.find(tok);
    if (hits.length && hits.length <= 2) hits.forEach(push);
  }
  return out.slice(0, 8);
}

function recencyTier(days: number): number {
  return days < 7 ? 3 : days < 30 ? 2 : days < 90 ? 1 : 0;
}

export function rankSuspects(
  ws: Workspace,
  q: { error?: string; terms?: string[]; symbols?: string[]; top?: number },
): SuspectResult {
  const weights = loadWeights(ws);
  const error = q.error ?? '';
  const terms = [...new Set([...tokenize(error), ...(q.terms ?? []).flatMap(tokenize)])];
  const named = namedSymbols(ws, error, q.symbols ?? []);
  const state = ws.intent();
  const top = q.top ?? ws.cfg.suspectsTop;

  // structural context, computed once
  const reachMap = new Map<string, { seed: string; d: number }>();
  for (const seed of named) {
    for (const [id, d] of ws.graph.neighbors(seed, 2).dist) {
      const cur = reachMap.get(id);
      if (!cur || d < cur.d) reachMap.set(id, { seed, d });
    }
  }
  const blastMap = new Map<string, string>();
  for (const seed of named) for (const id of ws.graph.blastRadius(seed).keys()) if (!blastMap.has(id)) blastMap.set(id, seed);
  const churn = gitChurn(ws.root);
  const nameOf = (id: string) => ws.graph.get(id)?.props.name ?? id.slice(id.indexOf(':') + 1);

  const scored: SuspectEntry[] = [];
  let notEvaluated = 0;
  for (const t of state.tasks.values()) {
    if (t.status !== 'done' && t.status !== 'failed') {
      notEvaluated++;
      continue;
    }
    scored.push(scoreOne(t));
  }

  function scoreOne(t: Subtask): SuspectEntry {
    const syms = t.symbols.map((s) => followRename(state.renames, s));
    const reasons: string[] = [];
    const signals: Record<string, number> = { direct: 0, reach: 0, blast: 0, recency: 0, churn: 0 };

    const text = [t.title, t.chose, t.rejected, t.why, ...t.assumes, ...syms.map(nameOf)].filter(Boolean).join(' ');
    const recToks = new Set(tokenize(text));
    const hit = terms.filter((x) => recToks.has(x));
    if (hit.length) {
      signals.direct = weights.direct;
      reasons.push(`its own text shares ${hit.slice(0, 3).map((h) => `"${h}"`).join(', ')} with the error`);
    }
    let bestReach: { seed: string; d: number; sym: string } | null = null;
    for (const s of syms) {
      const r = reachMap.get(s);
      if (r && (!bestReach || r.d < bestReach.d)) bestReach = { ...r, sym: s };
    }
    if (bestReach) {
      signals.reach = weights.reach;
      reasons.push(bestReach.d === 0 ? `${nameOf(bestReach.sym)} is the failing symbol itself` : `${nameOf(bestReach.sym)} is ${HOP_WORD[bestReach.d]} ${nameOf(bestReach.seed)}`);
    }
    const blast = syms.find((s) => blastMap.has(s));
    if (blast) {
      signals.blast = weights.blast;
      reasons.push(`${nameOf(blast)} depends on ${nameOf(blastMap.get(blast)!)}, so a change there reaches it`);
    }
    const days = ageDays(t.ts);
    const tier = recencyTier(days);
    if (tier) {
      signals.recency = tier * weights.recency;
      reasons.push(`written ${ago(t.ts)}`);
    }
    const files = new Set(syms.map((s) => ws.graph.get(s)?.props.file).filter((f): f is string => !!f));
    const commits = Math.min(3, Math.max(0, ...[...files].map((f) => churn.get(f) ?? 0)));
    if (commits) {
      signals.churn = commits * weights.churn;
      reasons.push(`file changed in ${commits >= 3 ? '3+' : commits} commit${commits > 1 ? 's' : ''} in the last 30 days`);
    }
    const drifted = Object.entries(t.sigs ?? {}).some(([id, sig]) => {
      const n = ws.graph.get(followRename(state.renames, id));
      return n && n.props.sig && n.props.sig !== sig;
    });
    if (drifted) reasons.push('code changed since this was recorded, so its assumption may be stale');
    const missing = syms.filter((s) => !ws.graph.has(s));
    if (missing.length) reasons.push(`orphaned: ${missing.map(nameOf).join(', ')} no longer found in code`);
    const score = Object.values(signals).reduce((a, b) => a + b, 0);
    return {
      id: t.id, title: t.title, feature: t.feature, score, rank: 0, reasons, signals, symbols: syms, assumes: t.assumes,
      chose: t.chose, rejected: t.rejected, why: t.why, by: t.by, age: ago(t.ts), drifted: !!drifted,
    };
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const suspects: SuspectEntry[] = [];
  const also: SuspectEntry[] = [];
  const cleared: SuspectEntry[] = [];
  for (const e of scored) {
    const evidence = e.signals.direct + e.signals.reach + e.signals.blast > 0; // recency/churn alone are not evidence
    if (evidence && suspects.length < top) suspects.push(e);
    else if (e.assumes.length) {
      // THE TRAP: score is lexical + structural, so it cannot judge whether an assumption explains the symptom.
      // Anything carrying an assumption stays promotable.
      if (!e.reasons.length) e.reasons.push('no lexical or structural link to the error; kept because it records an assumption');
      also.push(e);
    } else cleared.push(e);
  }
  const ordered = [...suspects, ...also, ...cleared];
  ordered.forEach((e, i) => (e.rank = i + 1));

  const qid = `Q-${Date.now().toString(36)}`;
  const ranking: RankedEntry[] = [
    ...suspects.map((e) => ({ id: e.id, rank: e.rank, band: 'suspect' as const, score: e.score, signals: e.signals })),
    ...also.map((e) => ({ id: e.id, rank: e.rank, band: 'also_considered' as const, score: e.score, signals: e.signals })),
    ...cleared.map((e) => ({ id: e.id, rank: e.rank, band: 'cleared' as const, score: e.score, signals: e.signals })),
  ];
  ws.store.appendOutcome({ k: 'query', qid, ts: now(), error: error.slice(0, 500), terms, symbols: named, ranking, weights: { ...weights } });

  return {
    qid, named_symbols: named, terms, suspects, also_considered: also, cleared: cleared.map((c) => c.id), not_evaluated: notEvaluated, weights,
    note: 'Score is lexical and structural only. Test every also_considered assumption against the symptom; promoting one is expected, not exceptional.',
  };
}

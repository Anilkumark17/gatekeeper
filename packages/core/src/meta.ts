import fs from 'node:fs';
import type { Workspace } from './workspace.js';
import { loadWeights } from './suspects.js';
import { now, type OutcomeEvent } from './store.js';
import type { Weights } from './types.js';

const SIGNALS = ['direct', 'reach', 'blast', 'recency', 'churn'] as const;

export interface MetaReport {
  queries: number;
  resolved_queries: number;
  misses: number;
  hit_at_1: number | null;
  hit_at_3: number | null;
  cause_ranks: { qid: string; cause: string; rank: number; band: string }[];
  signals: Record<string, { confirmed: number; cleared: number }>;
  checks: { confirmed: number; cleared: number };
  proposal: { file: string; current: Weights; proposed: Weights } | null;
  note: string;
}

export function metaReport(ws: Workspace): MetaReport {
  const ev = ws.store.outcomeEvents();
  const queries = ev.filter((e): e is Extract<OutcomeEvent, { k: 'query' }> => e.k === 'query');
  const checks = ev.filter((e): e is Extract<OutcomeEvent, { k: 'check' }> => e.k === 'check');
  const missed = new Set(ev.filter((e) => e.k === 'miss').map((e) => (e as any).qid));
  const confirmedByQ = new Map<string, typeof checks>();
  for (const c of checks) if (c.result === 'confirmed') confirmedByQ.set(c.qid, [...(confirmedByQ.get(c.qid) ?? []), c]);

  const causeRanks: MetaReport['cause_ranks'] = [];
  let h1 = 0;
  let h3 = 0;
  for (const [qid, cs] of confirmedByQ) {
    const best = cs.reduce((a, b) => (a.rank <= b.rank ? a : b));
    causeRanks.push({ qid, cause: best.id, rank: best.rank, band: best.band });
    if (best.rank === 1) h1++;
    if (best.rank <= 3) h3++;
  }
  // a miss with no confirmed cause is a failed query and counts against the hit rate
  const missOnly = [...missed].filter((q) => !confirmedByQ.has(q)).length;
  const denom = confirmedByQ.size + missOnly;

  const signals: MetaReport['signals'] = Object.fromEntries(SIGNALS.map((s) => [s, { confirmed: 0, cleared: 0 }]));
  const nConf = checks.filter((c) => c.result === 'confirmed').length;
  const nClr = checks.filter((c) => c.result === 'cleared').length;
  for (const c of checks) for (const s of SIGNALS) if ((c.signals?.[s] ?? 0) > 0) signals[s][c.result]++;

  const current = loadWeights(ws);
  let proposal: MetaReport['proposal'] = null;
  let note = 'Too little evidence to propose weights (need at least 5 checks including 2 confirmed and 2 cleared).';
  if (nConf >= 2 && nClr >= 2 && nConf + nClr >= 5) {
    const proposed = { ...current };
    for (const s of SIGNALS) {
      const pc = signals[s].confirmed / nConf;
      const px = signals[s].cleared / nClr;
      const lift = (pc + 0.1) / (px + 0.1);
      const next = current[s] * Math.sqrt(lift);
      proposed[s] = Math.round(Math.min(current[s] * 2, Math.max(current[s] * 0.5, next)) * 10) / 10;
    }
    const file = ws.store.p('proposals', `weights-${now().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(ws.store.p('proposals'), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ basedOn: { confirmed: nConf, cleared: nClr, queries: denom }, current, proposed }, null, 2) + '\n');
    proposal = { file, current, proposed };
    note = 'Proposal written. Nothing is applied until you run: gk meta --accept <file>';
  }
  return {
    queries: queries.length, resolved_queries: confirmedByQ.size, misses: missed.size,
    hit_at_1: denom ? h1 / denom : null, hit_at_3: denom ? h3 / denom : null,
    cause_ranks: causeRanks, signals, checks: { confirmed: nConf, cleared: nClr }, proposal, note,
  };
}

export function acceptProposal(ws: Workspace, file: string): Weights {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(ws.store.p('weights.json'), JSON.stringify(p.proposed, null, 2) + '\n');
  fs.renameSync(file, file.replace(/\.json$/, '.accepted.json'));
  return p.proposed;
}

export function rejectProposal(file: string): void {
  fs.renameSync(file, file.replace(/\.json$/, '.rejected.json'));
}

import fs from 'node:fs';
import path from 'node:path';
import { GK_DIR } from './config.js';
import type { PlanNode, Snapshot, Subtask, SubtaskStatus } from './types.js';

/* ---------------- event shapes ---------------- */

export type IntentEvent =
  | { k: 'plan'; id: string; feature: string; title: string; order: number; nodes?: PlanNode[]; ts: string }
  | {
      k: 'record'; id: string; status: SubtaskStatus; symbols: string[]; assumes: string[];
      chose?: string; rejected?: string; why?: string; by?: 'agent' | 'developer'; sigs?: Record<string, string>; ts: string;
    }
  | { k: 'edit'; id: string; title?: string; feature?: string; ts: string }
  | { k: 'remove'; id: string; ts: string }
  | { k: 'rename'; from: string; to: string; conf: 'exact' | 'unique-body' | 'heuristic'; ts: string };

export interface RankedEntry {
  id: string;
  rank: number;
  band: 'suspect' | 'also_considered' | 'cleared';
  score: number;
  signals: Record<string, number>;
}

export type OutcomeEvent =
  | { k: 'query'; qid: string; ts: string; error: string; terms: string[]; symbols: string[]; ranking: RankedEntry[]; weights: Record<string, number> }
  | { k: 'check'; qid: string; id: string; result: 'confirmed' | 'cleared'; rank: number; band: string; signals: Record<string, number>; ts: string }
  | { k: 'miss'; qid: string; note: string; ts: string };

/** Ephemeral per-prompt gate. Not history: the hook, the panel and the plan op overwrite it freely. */
export interface Gate {
  /** a prompt arrived and no plan has been written for it yet */
  pending: boolean;
  /** the one subtask the developer let the agent implement */
  allowed: string | null;
  ts: string;
}

export const now = () => new Date().toISOString();

export class Store {
  readonly dir: string;
  constructor(readonly root: string) {
    this.dir = path.join(root, GK_DIR);
  }
  p(...parts: string[]) {
    return path.join(this.dir, ...parts);
  }

  exists() {
    return fs.existsSync(this.dir);
  }

  init() {
    fs.mkdirSync(this.p('cache'), { recursive: true });
    fs.mkdirSync(this.p('proposals'), { recursive: true });
    for (const f of ['intent.jsonl', 'outcomes.jsonl']) if (!fs.existsSync(this.p(f))) fs.writeFileSync(this.p(f), '');
    if (!fs.existsSync(this.p('config.json'))) fs.writeFileSync(this.p('config.json'), JSON.stringify({ include: undefined, exclude: [] }, null, 2) + '\n');
    const gi = this.p('.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'cache/\ngate.json\n');
  }

  /* ---------- jsonl ---------- */

  private readJsonl<T>(file: string): T[] {
    let text: string;
    try {
      text = fs.readFileSync(this.p(file), 'utf8');
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a torn line must never take the store down */
      }
    }
    return out;
  }

  private append(file: string, ev: unknown) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.p(file), JSON.stringify(ev) + '\n');
  }

  intentEvents(): IntentEvent[] {
    return this.readJsonl<IntentEvent>('intent.jsonl');
  }
  appendIntent(ev: IntentEvent) {
    this.append('intent.jsonl', ev);
  }
  outcomeEvents(): OutcomeEvent[] {
    return this.readJsonl<OutcomeEvent>('outcomes.jsonl');
  }
  appendOutcome(ev: OutcomeEvent) {
    this.append('outcomes.jsonl', ev);
  }

  /* ---------- gate ---------- */

  readGate(): Gate {
    try {
      return JSON.parse(fs.readFileSync(this.p('gate.json'), 'utf8'));
    } catch {
      return { pending: false, allowed: null, ts: '' };
    }
  }
  writeGate(g: Omit<Gate, 'ts'>) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.p('gate.json'), JSON.stringify({ ...g, ts: now() }));
  }

  /* ---------- structure snapshot ---------- */

  readSnapshot(): Snapshot | null {
    try {
      return JSON.parse(fs.readFileSync(this.p('structure.json'), 'utf8'));
    } catch {
      return null;
    }
  }
  writeSnapshot(s: Snapshot) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.p('structure.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, this.p('structure.json'));
  }
}

/* ---------------- folding the event log into current state ---------------- */

export interface IntentState {
  tasks: Map<string, Subtask>;
  /** old symbol id -> new symbol id */
  renames: Map<string, string>;
  removed: Set<string>;
}

export function foldIntent(events: IntentEvent[]): IntentState {
  const tasks = new Map<string, Subtask>();
  const renames = new Map<string, string>();
  const removed = new Set<string>();
  for (const ev of events) {
    switch (ev.k) {
      case 'plan': {
        removed.delete(ev.id);
        tasks.set(ev.id, { id: ev.id, feature: ev.feature, title: ev.title, status: 'planned', symbols: [], assumes: [], ts: ev.ts, createdTs: ev.ts, order: ev.order, nodes: ev.nodes });
        break;
      }
      case 'record': {
        const t = tasks.get(ev.id) ?? { id: ev.id, feature: 'unplanned', title: ev.id, status: 'planned' as SubtaskStatus, symbols: [], assumes: [], ts: ev.ts, createdTs: ev.ts, order: 1e6 };
        removed.delete(ev.id);
        Object.assign(t, {
          status: ev.status,
          symbols: ev.symbols.length ? ev.symbols : t.symbols,
          assumes: ev.assumes.length ? ev.assumes : t.assumes,
          chose: ev.chose ?? t.chose,
          rejected: ev.rejected ?? t.rejected,
          why: ev.why ?? t.why,
          by: ev.by ?? t.by,
          sigs: ev.sigs ? { ...t.sigs, ...ev.sigs } : t.sigs,
          ts: ev.ts,
        });
        tasks.set(ev.id, t);
        break;
      }
      case 'edit': {
        const t = tasks.get(ev.id);
        if (t) {
          if (ev.title) t.title = ev.title;
          if (ev.feature) t.feature = ev.feature;
          t.ts = ev.ts;
        }
        break;
      }
      case 'remove':
        tasks.delete(ev.id);
        removed.add(ev.id);
        break;
      case 'rename':
        if (ev.from !== ev.to) renames.set(ev.from, ev.to);
        break;
    }
  }
  return { tasks, renames, removed };
}

/** Follow the rename chain so intent survives refactors. Cycle-safe. */
export function followRename(renames: Map<string, string>, id: string): string {
  const seen = new Set<string>();
  while (renames.has(id) && !seen.has(id)) {
    seen.add(id);
    id = renames.get(id)!;
  }
  return id;
}

export function nextTaskId(events: IntentEvent[]): () => string {
  let max = 0;
  for (const e of events) {
    if ('id' in e) {
      const m = /^ST-(\d+)$/.exec(e.id);
      if (m) max = Math.max(max, +m[1]);
    }
  }
  return () => `ST-${String(++max).padStart(3, '0')}`;
}

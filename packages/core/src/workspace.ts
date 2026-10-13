import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Graph } from './graph.js';
import { Linker } from './linker.js';
import { crawl, loadConfig, loadIgnore, isTracked, GK_DIR, type Config } from './config.js';
import { parseFile, parserFor, PARSER_VERSION } from './parsers/index.js';
import { Store, foldIntent, followRename, now, type IntentState } from './store.js';
import type { FileParse, GNode } from './types.js';

interface ManifestEntry {
  hash: string;
  mtime: number;
  size: number;
}

export interface GraphDelta {
  upsert: GNode[];
  remove: string[];
}

export interface InnerResult {
  file: string;
  ms: number;
  status: 'updated' | 'unchanged' | 'stale' | 'removed' | 'skipped';
  /** over the latency ceiling even after degrading */
  overBudget: boolean;
  added: string[];
  removed: string[];
  modified: string[];
  /** blast radius of the changed symbols (ids), capped */
  blast: string[];
  delta: GraphDelta;
}

export interface Orphan {
  task: string;
  symbol: string;
}

export interface DeltaReport {
  ms: number;
  firstRun: boolean;
  added: string[];
  removed: string[];
  modified: string[];
  renamed: { from: string; to: string; conf: string }[];
  orphans: Orphan[];
  orphanCount: number;
  intentSymbols: number;
  orphanRate: number;
  nodes: number;
  edges: number;
}

const sha = (s: string | Buffer) => createHash('sha1').update(s).digest('hex').slice(0, 20);

export class Workspace {
  readonly store: Store;
  readonly graph = new Graph();
  readonly linker: Linker;
  cfg: Config;
  private ig: ReturnType<typeof loadIgnore>;
  private manifest = new Map<string, ManifestEntry>();
  private parseMs = new Map<string, number>();
  readonly stale = new Set<string>();
  /** ids of nodes with their sig at the moment the snapshot was last written */
  lastSyncMs = 0;

  private constructor(readonly root: string) {
    this.store = new Store(root);
    this.cfg = loadConfig(root);
    this.ig = loadIgnore(root);
    this.linker = new Linker(root, this.graph);
  }

  static async open(root: string): Promise<Workspace> {
    const ws = new Workspace(path.resolve(root));
    try {
      ws.manifest = new Map(Object.entries(JSON.parse(fs.readFileSync(ws.store.p('cache', 'manifest.json'), 'utf8'))));
    } catch {
      /* cold */
    }
    await ws.sync();
    return ws;
  }

  /* ---------------- cache ---------------- */

  private cachePath(hash: string) {
    return this.store.p('cache', `${PARSER_VERSION}-${hash}.json`);
  }

  private async parseCached(rel: string, hash: string, source: () => string): Promise<FileParse | null> {
    try {
      return JSON.parse(fs.readFileSync(this.cachePath(hash), 'utf8'));
    } catch {
      /* miss */
    }
    const t = performance.now();
    const p = await parseFile(rel, source());
    this.parseMs.set(rel, performance.now() - t);
    if (p) {
      try {
        fs.mkdirSync(this.store.p('cache'), { recursive: true });
        fs.writeFileSync(this.cachePath(hash), JSON.stringify(p));
      } catch {
        /* cache is best-effort */
      }
    }
    return p;
  }

  private saveManifest() {
    try {
      fs.mkdirSync(this.store.p('cache'), { recursive: true });
      fs.writeFileSync(this.store.p('cache', 'manifest.json'), JSON.stringify(Object.fromEntries(this.manifest)));
    } catch {
      /* best effort */
    }
  }

  /* ---------------- full / incremental sync (outer-loop engine) ---------------- */

  /** Bring the in-memory graph in line with disk. Parses only files whose content hash changed. */
  async sync(): Promise<{ changed: string[]; removedFiles: string[]; ms: number }> {
    const t0 = performance.now();
    this.cfg = loadConfig(this.root);
    this.ig = loadIgnore(this.root);
    const entries = await crawl(this.root, this.cfg);
    const seen = new Set<string>();
    const changed: string[] = [];
    const fresh = new Map<string, FileParse>();

    for (const e of entries) {
      seen.add(e.rel);
      const m = this.manifest.get(e.rel);
      let hash: string;
      let text: string | undefined;
      if (m && m.mtime === e.mtimeMs && m.size === e.size && this.linker.hasFile(e.rel)) continue;
      if (m && m.mtime === e.mtimeMs && m.size === e.size) hash = m.hash;
      else {
        text = fs.readFileSync(path.join(this.root, e.rel), 'utf8');
        hash = sha(text);
      }
      const had = this.linker.hasFile(e.rel);
      if (m && m.hash === hash && had) {
        this.manifest.set(e.rel, { hash, mtime: e.mtimeMs, size: e.size });
        continue;
      }
      const p = await this.parseCached(e.rel, hash, () => text ?? fs.readFileSync(path.join(this.root, e.rel), 'utf8'));
      this.manifest.set(e.rel, { hash, mtime: e.mtimeMs, size: e.size });
      if (!p) continue;
      fresh.set(e.rel, p);
      changed.push(e.rel);
    }

    const removedFiles: string[] = [];
    for (const f of this.linker.allFiles()) if (!seen.has(f)) removedFiles.push(f);
    for (const f of [...this.manifest.keys()]) if (!seen.has(f)) this.manifest.delete(f);

    const affected = new Set<string>(changed);
    for (const f of removedFiles) for (const i of this.linker.importersOf(f)) affected.add(i);
    for (const [rel, p] of fresh) {
      const { structural } = this.linker.setParse(rel, p);
      if (structural) for (const f of this.linker.allFiles()) affected.add(f); // new file may satisfy imports anywhere
    }
    for (const f of removedFiles) {
      this.linker.removeFile(f);
    }
    for (const f of changed) for (const i of this.linker.importersOf(f)) affected.add(i);
    for (const f of affected) {
      if (!this.linker.hasFile(f)) continue;
      this.graph.setFileNodes(f, this.linker.linkFile(f));
    }
    this.saveManifest();
    this.lastSyncMs = performance.now() - t0;
    return { changed, removedFiles, ms: this.lastSyncMs };
  }

  /* ---------------- inner loop ---------------- */

  /**
   * File-save path. Reparses one file from cache, relinks it and its importers, and returns the blast radius.
   * Never writes intent. If the file is too heavy to finish inside the ceiling it is marked stale; call
   * finishStale() on idle.
   */
  async saveFile(rel: string, budgetMs = 300): Promise<InnerResult> {
    const t0 = performance.now();
    rel = rel.replace(/\\/g, '/');
    const empty: InnerResult = { file: rel, ms: 0, status: 'skipped', overBudget: false, added: [], removed: [], modified: [], blast: [], delta: { upsert: [], remove: [] } };
    const abs = path.join(this.root, rel);
    if (!parserFor(rel) || rel.startsWith(GK_DIR + '/')) return empty;
    if (!isTracked(this.cfg, this.ig, rel) && !this.linker.hasFile(rel)) return empty;
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(abs);
    } catch {
      /* deleted */
    }
    if (!st) return this.applyChange(rel, null, t0, budgetMs);
    if (st.size > this.cfg.maxFileBytes) return empty;
    const heavy = st.size > 400_000 || (this.parseMs.get(rel) ?? 0) > budgetMs * 0.7;
    if (heavy && !this.stale.has(rel)) {
      this.stale.add(rel);
      return { ...empty, ms: performance.now() - t0, status: 'stale' };
    }
    const text = fs.readFileSync(abs, 'utf8');
    const hash = sha(text);
    if (this.manifest.get(rel)?.hash === hash && this.linker.hasFile(rel)) return { ...empty, status: 'unchanged', ms: performance.now() - t0 };
    const p = await this.parseCached(rel, hash, () => text);
    this.manifest.set(rel, { hash, mtime: st.mtimeMs, size: st.size });
    this.stale.delete(rel);
    return this.applyChange(rel, p, t0, budgetMs);
  }

  /** Run on idle after saveFile returned 'stale'. */
  async finishStale(): Promise<InnerResult[]> {
    const out: InnerResult[] = [];
    for (const f of [...this.stale]) {
      this.stale.delete(f);
      out.push(await this.saveFile(f, Infinity));
    }
    return out;
  }

  private applyChange(rel: string, parse: FileParse | null, t0: number, budgetMs: number): InnerResult {
    const before = new Map<string, GNode>();
    const impacted = new Set<string>([rel, ...this.linker.importersOf(rel)]);
    for (const f of impacted) for (const n of this.graph.filesNodes(f)) before.set(n.id, n);
    const oldSigs = new Map<string, string | undefined>();
    for (const n of this.graph.filesNodes(rel)) oldSigs.set(n.id, n.props.sig);

    if (parse) {
      const { structural } = this.linker.setParse(rel, parse);
      if (structural) for (const f of this.linker.allFiles()) impacted.add(f);
    } else this.linker.removeFile(rel);
    const after = new Map<string, GNode>();
    for (const f of impacted) {
      if (!this.linker.hasFile(f)) continue;
      const nodes = this.linker.linkFile(f);
      this.graph.setFileNodes(f, nodes);
      for (const n of nodes) after.set(n.id, n);
    }
    // importers of the new import set may differ
    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    for (const [id, n] of after) {
      if (!oldSigs.has(id) && n.props.file === rel) added.push(id);
      else if (n.props.file === rel && oldSigs.get(id) !== n.props.sig && n.type !== 'module') modified.push(id);
    }
    for (const id of oldSigs) if (!after.has(id[0])) removed.push(id[0]);
    const upsert: GNode[] = [];
    for (const [id, n] of after) {
      const b = before.get(id);
      if (!b || JSON.stringify(b.edges) !== JSON.stringify(n.edges) || b.props.sig !== n.props.sig || b.props.line !== n.props.line) upsert.push(n);
    }
    const remove = [...before.keys()].filter((id) => !after.has(id));
    const blast = new Set<string>();
    for (const id of [...added, ...modified]) {
      for (const b of this.graph.blastRadius(id).keys()) {
        blast.add(b);
        if (blast.size > 500) break;
      }
    }
    const ms = performance.now() - t0;
    return { file: rel, ms, status: parse ? 'updated' : 'removed', overBudget: ms > budgetMs, added, removed, modified, blast: [...blast], delta: { upsert, remove } };
  }

  /* ---------------- intent helpers ---------------- */

  intent(): IntentState {
    return foldIntent(this.store.intentEvents());
  }

  /** Current id for a recorded symbol, following renames. */
  resolveSymbol(state: IntentState, id: string): string {
    return followRename(state.renames, id);
  }

  /* ---------------- outer loop ---------------- */

  /** Commit-time / on-demand rebuild: sync, diff against last snapshot, repair renames, persist. */
  async outer(): Promise<DeltaReport> {
    const t0 = performance.now();
    const prev = this.store.readSnapshot();
    await this.sync();
    const live = this.graph.liveNodes();
    const cur = new Map(live.filter((n) => n.type !== 'external' && n.type !== 'unresolved').map((n) => [n.id, n]));
    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    const prevMap = new Map((prev?.nodes ?? []).filter((n) => n.type !== 'external' && n.type !== 'unresolved').map((n) => [n.id, n]));
    if (prev) {
      for (const [id, n] of cur) {
        const o = prevMap.get(id);
        if (!o) added.push(id);
        else if (n.type !== 'module' && o.props.sig !== n.props.sig) modified.push(id);
      }
      for (const id of prevMap.keys()) if (!cur.has(id)) removed.push(id);
    } else {
      for (const id of cur.keys()) added.push(id);
    }

    // rename repair: only for symbols that carry intent, and never silently overwrite.
    const state = this.intent();
    const attached = new Set<string>();
    for (const t of state.tasks.values()) for (const s of t.symbols) attached.add(followRename(state.renames, s));
    const renamed = prev ? this.detectRenames(removed.filter((id) => attached.has(id)), added, prevMap, cur) : [];
    for (const r of renamed) this.store.appendIntent({ k: 'rename', from: r.from, to: r.to, conf: r.conf as 'exact', ts: now() });

    this.store.writeSnapshot({ version: 1, builtAt: now(), nodes: live });
    this.pruneCache();
    const rep = this.report(this.intent());
    return {
      ms: performance.now() - t0, firstRun: !prev, added, removed, modified, renamed, ...rep,
      nodes: cur.size, edges: live.reduce((a, n) => a + n.edges.length, 0),
    };
  }

  private detectRenames(gone: string[], added: string[], prevMap: Map<string, GNode>, cur: Map<string, GNode>) {
    const out: { from: string; to: string; conf: string }[] = [];
    const taken = new Set<string>();
    const qn = (id: string) => id.slice(id.indexOf(':') + 1);
    const bySig = new Map<string, string[]>();
    for (const a of added) {
      const sig = cur.get(a)?.props.sig;
      if (sig) bySig.set(sig, [...(bySig.get(sig) ?? []), a]);
    }
    const remaining: string[] = [];
    for (const g of gone) {
      const old = prevMap.get(g);
      if (!old) continue;
      if (old.type === 'module') {
        remaining.push(g);
        continue;
      }
      const same = (bySig.get(old.props.sig ?? '') ?? []).filter((a) => !taken.has(a));
      // 1. file moved: same qualified name and same body
      const moved = same.find((a) => qn(a) === qn(g));
      if (moved) { taken.add(moved); out.push({ from: g, to: moved, conf: 'exact' }); continue; }
      // 2. unique body hash
      if (same.length === 1) { taken.add(same[0]); out.push({ from: g, to: same[0], conf: 'unique-body' }); continue; }
      remaining.push(g);
    }
    // 3. exactly one removed and one added symbol of the same kind in the same file
    for (const g of remaining) {
      const old = prevMap.get(g)!;
      const sameKind = (id: string) => cur.get(id)?.type === old.type && cur.get(id)?.props.file === old.props.file && cur.get(id)?.props.parent === old.props.parent;
      const goneSame = gone.filter((x) => prevMap.get(x)?.type === old.type && prevMap.get(x)?.props.file === old.props.file && prevMap.get(x)?.props.parent === old.props.parent);
      const addSame = added.filter((a) => !taken.has(a) && sameKind(a));
      if (old.type !== 'module' && goneSame.length === 1 && addSame.length === 1) {
        taken.add(addSame[0]);
        out.push({ from: g, to: addSame[0], conf: 'heuristic' });
      }
      if (old.type === 'module') {
        // whole-file rename: all symbols matched by qualified name were handled above; map the module itself if any child moved
        const child = out.find((r) => prevMap.get(r.from)?.props.file === old.id);
        if (child) {
          const nf = cur.get(child.to)?.props.file;
          if (nf) out.push({ from: g, to: nf, conf: 'exact' });
        }
      }
    }
    return out;
  }

  private pruneCache() {
    try {
      const keep = new Set([...this.manifest.values()].map((m) => `${PARSER_VERSION}-${m.hash}.json`));
      for (const f of fs.readdirSync(this.store.p('cache'))) {
        if (f === 'manifest.json' || f.endsWith('.log.jsonl')) continue;
        if (!keep.has(f)) fs.unlinkSync(this.store.p('cache', f));
      }
    } catch {
      /* best effort */
    }
  }

  /** Orphan accounting: intent attached to symbols that no longer exist. */
  report(state: IntentState): { orphans: Orphan[]; orphanCount: number; intentSymbols: number; orphanRate: number } {
    const orphans: Orphan[] = [];
    let total = 0;
    for (const t of state.tasks.values()) {
      for (const s of t.symbols) {
        total++;
        if (!this.graph.has(followRename(state.renames, s))) orphans.push({ task: t.id, symbol: s });
      }
    }
    return { orphans, orphanCount: orphans.length, intentSymbols: total, orphanRate: total ? orphans.length / total : 0 };
  }
}

import type { Edge, GNode, EdgeKind } from './types.js';

export interface SubGraph {
  /** id -> hop distance from the seed set */
  dist: Map<string, number>;
  edges: { from: string; to: string; kind: EdgeKind; resolved: boolean }[];
}

export interface PathStep {
  id: string;
  /** how we arrived here: 'out' follows an edge forwards, 'in' backwards */
  via?: { kind: EdgeKind; dir: 'out' | 'in' };
}

/**
 * In-memory graph with a maintained reverse index. Nodes are owned by files, so a file
 * save swaps one file's nodes without touching the rest.
 */
export class Graph {
  nodes = new Map<string, GNode>();
  private rev = new Map<string, Set<string>>(); // target -> sources
  private byFile = new Map<string, string[]>();
  private children = new Map<string, Set<string>>();

  /** Replace every node owned by `file`. Ghost nodes (ext:, ?) are shared and handled lazily. */
  setFileNodes(file: string, nodes: GNode[]): void {
    this.removeFile(file);
    const ids: string[] = [];
    for (const n of nodes) {
      this.nodes.set(n.id, n);
      ids.push(n.id);
      for (const e of n.edges) this.addRev(e.to, n.id);
      const parent = n.props.parent;
      if (parent && n.props.file) {
        const pid = `${n.props.file}:${parent}`;
        let s = this.children.get(pid);
        if (!s) this.children.set(pid, (s = new Set()));
        s.add(n.id);
      }
    }
    this.byFile.set(file, ids);
  }

  removeFile(file: string): void {
    const ids = this.byFile.get(file);
    if (!ids) return;
    for (const id of ids) {
      const n = this.nodes.get(id);
      if (n) {
        for (const e of n.edges) this.rev.get(e.to)?.delete(id);
        if (n.props.parent && n.props.file) this.children.get(`${n.props.file}:${n.props.parent}`)?.delete(id);
      }
      this.nodes.delete(id);
      this.children.delete(id);
    }
    this.byFile.delete(file);
  }

  ensureGhost(id: string, type: 'external' | 'unresolved', name: string, reason?: string): void {
    if (this.nodes.has(id)) return;
    this.nodes.set(id, { id, type, props: { name, resolved: type === 'external', reason }, edges: [] });
  }

  private addRev(to: string, from: string) {
    let s = this.rev.get(to);
    if (!s) this.rev.set(to, (s = new Set()));
    s.add(from);
  }

  filesNodes(file: string): GNode[] {
    return (this.byFile.get(file) ?? []).map((i) => this.nodes.get(i)!).filter(Boolean);
  }

  get(id: string): GNode | undefined {
    return this.nodes.get(id);
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  dependents(id: string): string[] {
    return [...(this.rev.get(id) ?? [])];
  }

  /** Real (non-ghost) nodes still referenced */
  liveNodes(): GNode[] {
    const out: GNode[] = [];
    for (const n of this.nodes.values()) {
      if ((n.type === 'external' || n.type === 'unresolved') && !(this.rev.get(n.id)?.size)) continue;
      out.push(n);
    }
    return out;
  }

  private outEdges(id: string): Edge[] {
    return this.nodes.get(id)?.edges ?? [];
  }

  /** Nodes within `hops` of any seed, following edges in both directions. */
  neighbors(seeds: string | string[], hops: number): SubGraph {
    const start = Array.isArray(seeds) ? seeds : [seeds];
    const dist = new Map<string, number>();
    let frontier: string[] = [];
    for (const s of start) if (this.nodes.has(s)) { dist.set(s, 0); frontier.push(s); }
    for (let h = 1; h <= hops; h++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of this.outEdges(id)) if (!dist.has(e.to) && this.nodes.has(e.to)) { dist.set(e.to, h); next.push(e.to); }
        for (const src of this.rev.get(id) ?? []) if (!dist.has(src)) { dist.set(src, h); next.push(src); }
      }
      frontier = next;
    }
    const edges: SubGraph['edges'] = [];
    for (const id of dist.keys()) {
      for (const e of this.outEdges(id)) if (dist.has(e.to)) edges.push({ from: id, to: e.to, kind: e.kind, resolved: e.resolved });
    }
    return { dist, edges };
  }

  /** Reverse reachability: everything that breaks if `id` changes. Children of a class count as the class. */
  blastRadius(id: string): Map<string, number> {
    const dist = new Map<string, number>();
    const seeds = [id, ...this.descendants(id)];
    let frontier: string[] = [];
    for (const s of seeds) { dist.set(s, 0); frontier.push(s); }
    let h = 0;
    while (frontier.length) {
      h++;
      const next: string[] = [];
      for (const cur of frontier) {
        for (const src of this.rev.get(cur) ?? []) {
          if (!dist.has(src)) { dist.set(src, h); next.push(src); }
        }
      }
      frontier = next;
    }
    for (const s of seeds) dist.delete(s);
    return dist;
  }

  private descendants(id: string): string[] {
    const out: string[] = [];
    const stack = [id];
    while (stack.length) {
      for (const c of this.children.get(stack.pop()!) ?? []) { out.push(c); stack.push(c); }
    }
    return out;
  }

  /** Shortest path ignoring edge direction; each step records the direction taken. */
  pathBetween(a: string, b: string): PathStep[] | null {
    if (!this.nodes.has(a) || !this.nodes.has(b)) return null;
    const prev = new Map<string, { from: string; kind: EdgeKind; dir: 'out' | 'in' } | null>([[a, null]]);
    let frontier = [a];
    while (frontier.length && !prev.has(b)) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of this.outEdges(id)) if (!prev.has(e.to) && this.nodes.has(e.to)) { prev.set(e.to, { from: id, kind: e.kind, dir: 'out' }); next.push(e.to); }
        for (const src of this.rev.get(id) ?? []) {
          if (prev.has(src)) continue;
          const e = this.outEdges(src).find((x) => x.to === id)!;
          prev.set(src, { from: id, kind: e.kind, dir: 'in' });
          next.push(src);
        }
      }
      frontier = next;
    }
    if (!prev.has(b)) return null;
    const steps: PathStep[] = [];
    let cur: string | undefined = b;
    while (cur) {
      const p: { from: string; kind: EdgeKind; dir: 'out' | 'in' } | null | undefined = prev.get(cur);
      steps.push({ id: cur, via: p ? { kind: p.kind, dir: p.dir === 'out' ? 'out' : 'in' } : undefined });
      cur = p?.from;
    }
    return steps.reverse();
  }

  /** Resolve a user string (full id, qualified name, bare name, or path) to candidate ids. */
  find(q: string): string[] {
    if (this.nodes.has(q)) return [q];
    const out: string[] = [];
    const lower = q.toLowerCase();
    for (const n of this.nodes.values()) {
      if (n.type === 'external' || n.type === 'unresolved') continue;
      if (n.type === 'module') {
        if (n.id.toLowerCase().endsWith(lower)) out.push(n.id);
        continue;
      }
      const qn = n.id.slice(n.id.indexOf(':') + 1);
      if (qn === q || n.props.name === q || qn.endsWith('.' + q)) out.push(n.id);
    }
    return out;
  }

  /** Innermost symbol containing a file line, for editor and stack-trace mapping. */
  symbolAt(file: string, line: number): GNode | undefined {
    let best: GNode | undefined;
    for (const n of this.filesNodes(file)) {
      if (n.type === 'module' || n.props.line == null) continue;
      if (line >= n.props.line && line <= (n.props.endLine ?? n.props.line)) {
        if (!best || (n.props.endLine! - n.props.line!) < (best.props.endLine! - best.props.line!)) best = n;
      }
    }
    return best;
  }
}

import fs from 'node:fs';
import path from 'node:path';
import type { CallRef, Edge, FileParse, GNode, SymbolDef } from './types.js';
import type { Graph } from './graph.js';

const TS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const JS_TO_TS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

type Binding =
  | { kind: 'file'; rel: string; imported: string }
  | { kind: 'external'; spec: string; imported: string }
  | { kind: 'missing'; spec: string; imported: string };

interface FileInfo {
  parse: FileParse;
  sym: Map<string, SymbolDef>;
  bindings: Map<string, Binding>;
  starImports: string[];
  deps: Set<string>;
}

const stripJsonComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1');

/**
 * Turns per-file parses into graph nodes. Owns all cross-file resolution so parsers stay pure and cacheable.
 */
export class Linker {
  private files = new Map<string, FileInfo>();
  private parses = new Map<string, FileParse>();
  private fileSet = new Set<string>();
  private methodIndex = new Map<string, Set<string>>();
  private pyIndex = new Map<string, string>();
  private importers = new Map<string, Set<string>>();
  private memo = new Map<string, Binding | null>();
  private paths: { pattern: string; targets: string[] }[] = [];
  private baseUrl = '';

  constructor(private root: string, private graph: Graph) {
    this.loadTsconfig();
  }

  private loadTsconfig() {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      try {
        const cfg = JSON.parse(stripJsonComments(fs.readFileSync(path.join(this.root, name), 'utf8')));
        const co = cfg.compilerOptions ?? {};
        this.baseUrl = co.baseUrl ? path.posix.normalize(co.baseUrl) : '';
        for (const [pattern, targets] of Object.entries<string[]>(co.paths ?? {})) this.paths.push({ pattern, targets });
        return;
      } catch {
        /* try next */
      }
    }
  }

  hasFile(rel: string) {
    return this.fileSet.has(rel);
  }

  allFiles(): string[] {
    return [...this.fileSet];
  }

  /** Files that import `rel` (used to relink dependents after a change). */
  importersOf(rel: string): string[] {
    return [...(this.importers.get(rel) ?? [])];
  }

  setParse(rel: string, parse: FileParse): { structural: boolean } {
    const isNew = !this.fileSet.has(rel);
    this.removeIndexes(rel);
    this.parses.set(rel, parse);
    this.fileSet.add(rel);
    this.addIndexes(rel, parse);
    if (isNew) this.onFileSetChanged();
    this.files.delete(rel);
    for (const i of this.importersOf(rel)) this.files.delete(i);
    return { structural: isNew };
  }

  removeFile(rel: string): void {
    if (!this.fileSet.has(rel)) return;
    this.removeIndexes(rel);
    this.parses.delete(rel);
    this.fileSet.delete(rel);
    this.files.delete(rel);
    for (const s of this.importers.values()) s.delete(rel);
    this.onFileSetChanged();
    this.graph.removeFile(rel);
  }

  private onFileSetChanged() {
    this.memo.clear();
    this.pyIndex.clear();
    const pass2: [string, string][] = [];
    for (const f of this.fileSet) {
      if (!f.endsWith('.py')) continue;
      const parts = f.slice(0, -3).split('/');
      if (parts[parts.length - 1] === '__init__') parts.pop();
      if (!parts.length) continue;
      this.pyIndex.set(parts.join('.'), f);
      for (let i = 1; i < parts.length; i++) pass2.push([parts.slice(i).join('.'), f]);
    }
    for (const [k, f] of pass2) if (!this.pyIndex.has(k)) this.pyIndex.set(k, f);
    // dependents' bindings may now resolve differently
    this.files.clear();
  }

  private removeIndexes(rel: string) {
    const old = this.parses.get(rel);
    if (!old) return;
    for (const s of old.symbols) {
      if (s.parent && s.type === 'function') this.methodIndex.get(s.name)?.delete(`${rel}:${s.qname}`);
    }
  }

  private addIndexes(rel: string, p: FileParse) {
    for (const s of p.symbols) {
      if (s.parent && s.type === 'function') {
        let set = this.methodIndex.get(s.name);
        if (!set) this.methodIndex.set(s.name, (set = new Set()));
        set.add(`${rel}:${s.qname}`);
      }
    }
  }

  /* ---------------- module resolution ---------------- */

  private tryFile(cands: string[]): string | null {
    for (const c of cands) if (this.fileSet.has(c)) return c;
    return null;
  }

  private tsCandidates(base: string): string[] {
    const ext = path.posix.extname(base);
    const out = [base];
    if (JS_TO_TS[ext]) for (const e of JS_TO_TS[ext]) out.push(base.slice(0, -ext.length) + e);
    for (const e of TS_EXTS) out.push(base + e);
    for (const e of TS_EXTS) out.push(`${base}/index${e}`);
    return out;
  }

  private resolveSpec(from: string, spec: string, level = 0): { rel?: string; external?: string } {
    const key = `${from}\0${spec}\0${level}`;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit ? (hit.kind === 'file' ? { rel: hit.rel } : { external: (hit as any).spec }) : {};
    const res = this.resolveSpecUncached(from, spec, level);
    this.memo.set(key, res.rel ? { kind: 'file', rel: res.rel, imported: '' } : res.external ? { kind: 'external', spec: res.external, imported: '' } : null);
    return res;
  }

  private resolveSpecUncached(from: string, spec: string, level: number): { rel?: string; external?: string } {
    const dir = path.posix.dirname(from);
    if (from.endsWith('.py')) {
      if (level > 0) {
        let base = dir;
        for (let i = 1; i < level; i++) base = path.posix.dirname(base);
        if (base === '.') base = '';
        const sub = spec ? spec.split('.').join('/') : '';
        const joined = [base, sub].filter(Boolean).join('/');
        const r = this.tryFile([`${joined}.py`, `${joined}/__init__.py`, ...(spec ? [] : [`${base ? base + '/' : ''}__init__.py`])]);
        return r ? { rel: r } : {};
      }
      const r = this.pyIndex.get(spec);
      return r ? { rel: r } : { external: spec.split('.')[0] };
    }
    if (spec.startsWith('.')) {
      const r = this.tryFile(this.tsCandidates(path.posix.normalize(path.posix.join(dir, spec))));
      return r ? { rel: r } : {};
    }
    for (const { pattern, targets } of this.paths) {
      const star = pattern.indexOf('*');
      const ok = star < 0 ? spec === pattern : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1));
      if (!ok) continue;
      const mid = star < 0 ? '' : spec.slice(star, spec.length - (pattern.length - star - 1));
      for (const t of targets) {
        const sub = path.posix.normalize(path.posix.join(this.baseUrl, t.replace('*', mid)));
        const r = this.tryFile(this.tsCandidates(sub));
        if (r) return { rel: r };
      }
    }
    if (this.baseUrl !== '') {
      const r = this.tryFile(this.tsCandidates(path.posix.normalize(path.posix.join(this.baseUrl, spec))));
      if (r) return { rel: r };
    }
    const parts = spec.split('/');
    return { external: spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0].replace(/^node:/, '') };
  }

  /* ---------------- per-file info ---------------- */

  private info(rel: string): FileInfo | undefined {
    let fi = this.files.get(rel);
    if (fi) return fi;
    const parse = this.parses.get(rel);
    if (!parse) return undefined;
    const sym = new Map(parse.symbols.map((s) => [s.qname, s]));
    const bindings = new Map<string, Binding>();
    const starImports: string[] = [];
    const deps = new Set<string>();
    for (const imp of parse.imports) {
      const r = this.resolveSpec(rel, imp.spec, imp.level ?? 0);
      if (r.rel) deps.add(r.rel);
      for (const b of imp.bindings) {
        if (imp.reexport) continue;
        if (b.local === '*') {
          if (r.rel) starImports.push(r.rel);
          continue;
        }
        if (r.rel) {
          // python: `from pkg import submodule`
          let target = r.rel;
          let imported = b.imported;
          if (rel.endsWith('.py') && b.imported !== '*') {
            const sub = this.resolveSpec(rel, (imp.spec ? imp.spec + '.' : '') + b.imported, imp.level ?? 0);
            if (sub.rel && !this.exportOf(r.rel, b.imported)) { target = sub.rel; imported = '*'; }
          }
          bindings.set(b.local, { kind: 'file', rel: target, imported });
        } else if (r.external) bindings.set(b.local, { kind: 'external', spec: r.external, imported: b.imported });
        else bindings.set(b.local, { kind: 'missing', spec: imp.spec, imported: b.imported });
      }
    }
    fi = { parse, sym, bindings, starImports, deps };
    this.files.set(rel, fi);
    return fi;
  }

  private exportOf(rel: string, name: string): SymbolDef | undefined {
    return this.parses.get(rel)?.symbols.find((s) => s.qname === name);
  }

  /** Resolve an exported name through re-exports to a symbol id (or module id as last resort). */
  private resolveExport(rel: string, name: string, depth = 0): string | null {
    const p = this.parses.get(rel);
    if (!p || depth > 5) return null;
    if (name === 'default' || name === '*') {
      if (name === '*') return rel;
      const ex = p.symbols.filter((s) => !s.parent && s.exported && s.type !== 'data');
      return ex.length === 1 ? `${rel}:${ex[0].qname}` : rel;
    }
    if (p.symbols.some((s) => s.qname === name)) return `${rel}:${name}`;
    for (const imp of p.imports) {
      if (!imp.reexport) continue;
      const r = this.resolveSpec(rel, imp.spec, imp.level ?? 0);
      if (!r.rel) continue;
      for (const b of imp.bindings) {
        if (b.local === name) return this.resolveExport(r.rel, b.imported, depth + 1);
        if (b.local === '*') {
          const got = this.resolveExport(r.rel, name, depth + 1);
          if (got && got !== r.rel) return got;
        }
      }
    }
    return null;
  }

  private lookupMethod(file: string, cls: string, name: string, depth = 0): string | null {
    const fi = this.info(file);
    if (!fi || depth > 4) return null;
    if (fi.sym.has(`${cls}.${name}`)) return `${file}:${cls}.${name}`;
    for (const ex of fi.parse.extends) {
      if (ex.from !== cls) continue;
      const base = this.resolveTypeName(file, ex.name);
      if (base) {
        const [bf, bq] = splitId(base);
        const got = this.lookupMethod(bf, bq, name, depth + 1);
        if (got) return got;
      }
    }
    return null;
  }

  /** Resolve a possibly dotted class name used in extends/new. */
  private resolveTypeName(file: string, name: string): string | null {
    const fi = this.info(file);
    if (!fi) return null;
    const parts = name.split('.');
    const head = parts[0];
    if (parts.length === 1) {
      if (fi.sym.has(head)) return `${file}:${head}`;
      const b = fi.bindings.get(head);
      if (b?.kind === 'file' && b.imported !== '*') return this.resolveExport(b.rel, b.imported);
      return null;
    }
    const b = fi.bindings.get(head);
    if (b?.kind === 'file') return this.resolveExport(b.rel, parts[parts.length - 1]);
    return null;
  }

  /* ---------------- linking ---------------- */

  linkFile(rel: string): GNode[] {
    const fi = this.info(rel);
    if (!fi) return [];
    const { parse } = fi;
    const nodes: GNode[] = [];
    const lang = parse.language;
    const g = this.graph;

    // importers index
    for (const s of this.importers.values()) s.delete(rel);
    for (const d of fi.deps) {
      let s = this.importers.get(d);
      if (!s) this.importers.set(d, (s = new Set()));
      s.add(rel);
    }

    const mod: GNode = { id: rel, type: 'module', props: { name: path.posix.basename(rel), file: rel, language: lang, resolved: true, line: 1, endLine: parse.lines }, edges: [] };
    const modEdges = new Map<string, Edge>();
    const addMod = (e: Edge) => modEdges.set(`${e.kind}|${e.to}`, e);
    for (const imp of parse.imports) {
      const r = this.resolveSpec(rel, imp.spec, imp.level ?? 0);
      if (r.rel) {
        addMod({ kind: 'imports', to: r.rel, resolved: true });
        for (const b of imp.bindings) {
          if (b.local === '*' || b.imported === '*') continue;
          let id = this.resolveExport(r.rel, b.imported);
          if (!id && rel.endsWith('.py')) id = this.resolveSpec(rel, (imp.spec ? imp.spec + '.' : '') + b.imported, imp.level ?? 0).rel ?? null;
          if (id && id !== r.rel && g.has(id) || (id && id !== r.rel && this.symbolExists(id))) addMod({ kind: 'imports', to: id, resolved: true });
        }
      } else if (r.external) {
        const id = `ext:${r.external}`;
        g.ensureGhost(id, 'external', r.external);
        addMod({ kind: 'imports', to: id, resolved: true });
      } else {
        const id = `?import:${imp.spec}`;
        g.ensureGhost(id, 'unresolved', imp.spec, 'unresolved-import');
        addMod({ kind: 'imports', to: id, resolved: false });
      }
    }

    const symNodes = new Map<string, GNode>();
    for (const s of parse.symbols) {
      symNodes.set(s.qname, {
        id: `${rel}:${s.qname}`,
        type: s.type,
        props: {
          name: s.name, file: rel, line: s.line, endLine: s.endLine, col: s.col, language: lang, parent: s.parent,
          exported: s.exported, sig: s.sig, signature: s.signature, resolved: true,
        },
        edges: [],
      });
    }
    const edgeSets = new Map<string, Map<string, Edge>>();
    const add = (from: string, e: Edge) => {
      if (from === '') return addMod(e);
      let m = edgeSets.get(from);
      if (!m) edgeSets.set(from, (m = new Map()));
      const k = `${e.kind}|${e.to}`;
      const prev = m.get(k);
      if (!prev || (!prev.resolved && e.resolved)) m.set(k, e);
    };

    for (const c of parse.calls) this.linkCall(rel, fi, c, add, symNodes);
    for (const ex of parse.extends) {
      const t = this.resolveTypeName(rel, ex.name);
      if (t) add(ex.from, { kind: 'extends', to: t, resolved: true });
      else {
        const b = fi.bindings.get(ex.name.split('.')[0]);
        if (b?.kind === 'external') {
          g.ensureGhost(`ext:${b.spec}`, 'external', b.spec);
          add(ex.from, { kind: 'extends', to: `ext:${b.spec}`, resolved: true });
        } else {
          const gid = `?inherit:${ex.name}`;
          g.ensureGhost(gid, 'unresolved', ex.name, 'dynamic-dispatch');
          add(ex.from, { kind: 'extends', to: gid, resolved: false });
        }
      }
    }
    for (const d of parse.dynamic) {
      const gid = `?${d.reason}:${d.name}`;
      g.ensureGhost(gid, 'unresolved', d.name, d.reason);
      add(d.from, { kind: 'calls', to: gid, resolved: false });
    }
    // dataflow: references to module-level data
    for (const s of parse.symbols) {
      for (const r of s.refs) {
        if (r === s.name) continue;
        const local = fi.sym.get(r);
        if (local && local.type === 'data') {
          add(s.qname, { kind: 'dataflow', to: `${rel}:${r}`, resolved: true });
          continue;
        }
        const b = fi.bindings.get(r);
        if (b?.kind === 'file' && b.imported !== '*') {
          const id = this.resolveExport(b.rel, b.imported);
          if (id && this.isData(id)) add(s.qname, { kind: 'dataflow', to: id, resolved: true });
        }
      }
    }

    for (const [q, n] of symNodes) {
      n.edges = [...(edgeSets.get(q)?.values() ?? [])];
      nodes.push(n);
    }
    mod.edges = [...modEdges.values()];
    nodes.unshift(mod);
    return nodes;
  }

  private symbolExists(id: string): boolean {
    const [f, q] = splitId(id);
    return !!this.parses.get(f)?.symbols.some((s) => s.qname === q);
  }

  private isData(id: string): boolean {
    const [f, q] = splitId(id);
    return this.parses.get(f)?.symbols.find((s) => s.qname === q)?.type === 'data';
  }

  private linkCall(rel: string, fi: FileInfo, c: CallRef, add: (from: string, e: Edge) => void, symNodes: Map<string, GNode>) {
    const g = this.graph;
    const from = c.from;
    const bump = () => {
      const n = symNodes.get(from);
      if (n) n.props.unresolvedCalls = (n.props.unresolvedCalls ?? 0) + 1;
    };
    const ext = (spec: string) => {
      g.ensureGhost(`ext:${spec}`, 'external', spec);
      add(from, { kind: 'calls', to: `ext:${spec}`, resolved: true });
    };
    const hit = (id: string | null, resolved = true) => {
      if (id && id !== `${rel}:${from}`) add(from, { kind: 'calls', to: id, resolved });
      return !!id;
    };
    const heuristic = () => {
      const cands = [...(this.methodIndex.get(c.name) ?? [])].filter((id) => id !== `${rel}:${from}`);
      if (cands.length >= 1 && cands.length <= 3) {
        for (const id of cands) add(from, { kind: 'calls', to: id, resolved: false });
        if (cands.length > 1) bump();
      } else bump();
    };
    // `self.x` / `this.x` and `cls.x`
    if (c.receiver === 'this' || c.receiver === 'self' || c.receiver === 'cls' || c.receiver === 'super()' || c.receiver === 'super') {
      const owner = from ? (symNodes.get(from)?.props.parent ?? '') : '';
      if (owner) {
        const id = this.lookupMethod(rel, owner, c.name);
        if (id) return void hit(id);
      }
      return heuristic();
    }
    if (!c.receiver) {
      const local = fi.sym.get(c.name);
      if (local && !local.parent) return void hit(`${rel}:${c.name}`);
      const b = fi.bindings.get(c.name);
      if (b) {
        if (b.kind === 'external') return ext(b.spec);
        if (b.kind === 'file') {
          const id = b.imported === '*' ? null : this.resolveExport(b.rel, b.imported);
          if (id && id !== b.rel) return void hit(id);
          if (id) return void hit(id);
        }
        return bump();
      }
      for (const star of fi.starImports) {
        const id = this.resolveExport(star, c.name);
        if (id && id !== star) return void hit(id);
      }
      return; // builtin / global: not tracked, not counted
    }
    const parts = c.receiver.split('.');
    const head = parts[0];
    const b = fi.bindings.get(head);
    if (b) {
      if (b.kind === 'external') return ext(b.spec);
      if (b.kind === 'file') {
        if (b.imported === '*') {
          // namespace / module alias
          if (parts.length === 1) {
            const id = this.resolveExport(b.rel, c.name);
            if (id && id !== b.rel) return void hit(id);
          } else {
            const clsId = this.resolveExport(b.rel, parts[1]);
            if (clsId && this.symbolExists(clsId)) {
              const [cf, cq] = splitId(clsId);
              const m = this.lookupMethod(cf, cq, c.name);
              if (m) return void hit(m);
            }
          }
          return bump();
        }
        const clsId = this.resolveExport(b.rel, b.imported);
        if (clsId && this.symbolExists(clsId)) {
          const [cf, cq] = splitId(clsId);
          const m = this.lookupMethod(cf, cq, c.name);
          if (m) return void hit(m);
        }
      }
      return heuristic();
    }
    const localCls = fi.sym.get(head);
    if (localCls && localCls.type === 'class' && parts.length === 1) {
      const m = this.lookupMethod(rel, head, c.name);
      if (m) return void hit(m);
    }
    heuristic();
  }
}

export function splitId(id: string): [string, string] {
  const i = id.indexOf(':');
  return i < 0 ? [id, ''] : [id.slice(0, i), id.slice(i + 1)];
}

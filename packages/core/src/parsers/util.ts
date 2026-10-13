import { createHash } from 'node:crypto';
import type { Node } from './runtime.js';
import type { FileParse, SymbolDef } from '../types.js';

export function emptyParse(language: string, lines: number): FileParse {
  return { language, symbols: [], imports: [], calls: [], extends: [], dynamic: [], lines };
}

export function hash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

/** Name-independent body hash: lets a rename keep its identity. */
export function bodySig(text: string, name: string): string {
  return hash(text.replace(name, '_').replace(/\s+/g, ' '));
}

export function firstLine(text: string, max = 140): string {
  const l = text.split('\n', 1)[0].trim();
  return l.length > max ? l.slice(0, max) + '…' : l;
}

export class SymbolCollector {
  readonly out: FileParse;
  private refs = new Map<string, Set<string>>();
  constructor(language: string, lines: number) {
    this.out = emptyParse(language, lines);
  }
  add(def: Omit<SymbolDef, 'refs'>): void {
    this.out.symbols.push({ ...def, refs: [] });
    this.refs.set(def.qname, new Set());
  }
  ref(qname: string, name: string): void {
    this.refs.get(qname)?.add(name);
  }
  finish(): FileParse {
    for (const s of this.out.symbols) s.refs = [...(this.refs.get(s.qname) ?? [])];
    return this.out;
  }
}

export function pos(n: Node) {
  return { line: n.startPosition.row + 1, endLine: n.endPosition.row + 1, col: n.startPosition.column };
}

export const EVENT_METHODS = new Set(['emit', 'on', 'once', 'addEventListener', 'dispatchEvent', 'publish', 'subscribe', 'dispatch']);
export const ORM_METHODS = new Set(['findOne', 'findMany', 'findAll', 'findUnique', 'findFirst', 'createQueryBuilder', 'getRepository', 'query', 'execute', 'filter_by']);
export const SERVICE_FUNCS = new Set(['fetch', 'axios', 'urlopen', 'requests']);
export const nn = <T>(x: T | null): x is T => x !== null;

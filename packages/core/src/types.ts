export type NodeType = 'module' | 'class' | 'function' | 'data' | 'external' | 'unresolved';
export type EdgeKind = 'imports' | 'calls' | 'extends' | 'dataflow';

export interface Edge {
  kind: EdgeKind;
  to: string;
  /** false when static parsing could only guess the target */
  resolved: boolean;
}

export interface NodeProps {
  name: string;
  file?: string;
  line?: number;
  endLine?: number;
  col?: number;
  language?: string;
  parent?: string;
  exported?: boolean;
  /** hash of normalized body, used for rename detection and drift */
  sig?: string;
  resolved: boolean;
  /** why the node could not be resolved: dynamic-dispatch, di, event-bus, orm, cross-service */
  reason?: string;
  unresolvedCalls?: number;
  signature?: string;
}

/** Normalized graph node. Id is `<module path>:<qualified symbol name>`; modules use the bare path. */
export interface GNode {
  id: string;
  type: NodeType;
  props: NodeProps;
  edges: Edge[];
}

/* ---------- per-file parse output (pure function of file content, safe to cache) ---------- */

export interface SymbolDef {
  qname: string;
  type: 'class' | 'function' | 'data';
  name: string;
  line: number;
  endLine: number;
  col: number;
  parent?: string;
  exported: boolean;
  sig: string;
  signature?: string;
  /** names referenced in the body, for dataflow */
  refs: string[];
}

export interface ImportRef {
  spec: string;
  /** local binding -> imported name ('*' = namespace, 'default' = default) */
  bindings: { local: string; imported: string }[];
  line: number;
  /** relative level for python (number of leading dots) */
  level?: number;
  reexport?: boolean;
}

export interface CallRef {
  from: string; // qname of enclosing symbol, '' for module scope
  name: string;
  receiver?: string; // 'this', 'self', identifier, or undefined
  isNew?: boolean;
}

export interface ExtendsRef {
  from: string;
  name: string;
}

export interface FileParse {
  language: string;
  symbols: SymbolDef[];
  imports: ImportRef[];
  calls: CallRef[];
  extends: ExtendsRef[];
  /** dynamic constructs spotted: DI decorators, event buses, ORM calls */
  dynamic: { from: string; name: string; reason: string }[];
  lines: number;
}

export interface Snapshot {
  version: 1;
  builtAt: string;
  nodes: GNode[];
}

/* ---------- intent ---------- */

export type SubtaskStatus = 'planned' | 'done' | 'failed' | 'skipped';

export interface Subtask {
  id: string;
  feature: string;
  title: string;
  status: SubtaskStatus;
  symbols: string[];
  assumes: string[];
  chose?: string;
  rejected?: string;
  why?: string;
  by?: 'agent' | 'developer';
  sigs?: Record<string, string>;
  ts: string; // last update
  createdTs: string;
  order: number;
}

export interface Rank {
  id: string;
  score: number;
  reasons: string[];
  signals: Record<string, number>;
}

export interface Weights {
  direct: number;
  reach: number;
  blast: number;
  recency: number;
  churn: number;
}

export const DEFAULT_WEIGHTS: Weights = { direct: 2, reach: 3, blast: 3, recency: 1, churn: 1 };

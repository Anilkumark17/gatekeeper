import path from 'node:path';
import type { FileParse } from '../types.js';
import { loadLanguage, parseSource, type LanguageParser } from './runtime.js';
import { ecmascript } from './ecmascript.js';
import { python } from './python.js';

/** Register a new language here. Nothing else in the codebase knows languages exist. */
export const PARSERS: LanguageParser[] = [ecmascript, python];

/** Bump when extractor output changes so stale caches are ignored. */
export const PARSER_VERSION = 'p3';

const byExt = new Map<string, LanguageParser>();
for (const p of PARSERS) for (const e of p.extensions) byExt.set(e, p);

export function parserFor(file: string): LanguageParser | undefined {
  return byExt.get(path.extname(file).toLowerCase());
}

export function supportedExtensions(): string[] {
  return [...byExt.keys()];
}

export async function parseFile(relPath: string, source: string): Promise<FileParse | null> {
  const p = parserFor(relPath);
  if (!p) return null;
  const ext = path.extname(relPath).toLowerCase();
  const lang = await loadLanguage(p.grammarFor(ext));
  const tree = parseSource(lang, source);
  if (!tree) return null;
  try {
    const res = p.extract(tree.rootNode, source, relPath);
    if (p.id === 'ecmascript') res.language = ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs' ? 'javascript' : 'typescript';
    return res;
  } finally {
    tree.delete();
  }
}

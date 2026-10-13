import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { Parser, Language } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';
import type { FileParse } from '../types.js';

export type { Node };

/**
 * Language plug-in contract. A fourth language is one new file that exports a
 * LanguageParser plus one line in parsers/index.ts.
 */
export interface LanguageParser {
  id: string;
  extensions: string[];
  /** wasm grammar basename (tree-sitter-<grammar>.wasm) for an extension */
  grammarFor(ext: string): string;
  extract(root: Node, source: string, relPath: string): FileParse;
}

let initPromise: Promise<void> | null = null;
const languages = new Map<string, Language>();
let parser: Parser | null = null;

function grammarDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.GK_GRAMMARS) dirs.push(process.env.GK_GRAMMARS);
  if (typeof __dirname !== 'undefined') dirs.push(path.join(__dirname, 'grammars'));
  try {
    const req = createRequire(path.join(process.cwd(), 'noop.js'));
    dirs.push(path.join(path.dirname(req.resolve('tree-sitter-wasms/package.json')), 'out'));
  } catch {
    /* not installed */
  }
  try {
    const req = createRequire(import.meta.url);
    dirs.push(path.join(path.dirname(req.resolve('tree-sitter-wasms/package.json')), 'out'));
  } catch {
    /* not installed */
  }
  return dirs;
}

function findFile(name: string): string {
  for (const d of grammarDirs()) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`grammar ${name} not found; set GK_GRAMMARS`);
}

export async function initRuntime(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      let wasmBinary: Uint8Array | undefined;
      try {
        wasmBinary = fs.readFileSync(findFile('tree-sitter.wasm'));
      } catch {
        wasmBinary = undefined;
      }
      await Parser.init(wasmBinary ? { wasmBinary } : undefined);
      parser = new Parser();
    })();
  }
  return initPromise;
}

export async function loadLanguage(grammar: string): Promise<Language> {
  await initRuntime();
  let l = languages.get(grammar);
  if (!l) {
    l = await Language.load(fs.readFileSync(findFile(`tree-sitter-${grammar}.wasm`)));
    languages.set(grammar, l);
  }
  return l;
}

export function parseSource(lang: Language, source: string) {
  parser!.setLanguage(lang);
  return parser!.parse(source);
}

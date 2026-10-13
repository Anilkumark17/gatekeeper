import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import ignore from 'ignore';
import micromatch from 'micromatch';
import { supportedExtensions } from './parsers/index.js';

export interface Config {
  include: string[];
  exclude: string[];
  maxFileBytes: number;
  tokenBudget: number;
  suspectsTop: number;
}

export const GK_DIR = '.gatekeeper';

export function defaultConfig(): Config {
  const exts = supportedExtensions().map((e) => e.slice(1)).join(',');
  return {
    include: [`**/*.{${exts}}`],
    exclude: [
      '**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/.git/**', '**/vendor/**', '**/venv/**', '**/.venv/**',
      '**/__pycache__/**', '**/.next/**', '**/coverage/**', '**/*.min.js', '**/*.d.ts', '**/*.bundle.js', '**/site-packages/**',
      `${GK_DIR}/**`,
    ],
    maxFileBytes: 1_500_000,
    tokenBudget: 8000,
    suspectsTop: 3,
  };
}

export function loadConfig(root: string): Config {
  const base = defaultConfig();
  try {
    const user = JSON.parse(fs.readFileSync(path.join(root, GK_DIR, 'config.json'), 'utf8'));
    return {
      ...base,
      ...user,
      include: user.include ?? base.include,
      // user excludes extend, never replace, the safety defaults
      exclude: [...base.exclude, ...(user.exclude ?? [])],
    };
  } catch {
    return base;
  }
}

export interface CrawlEntry {
  rel: string;
  size: number;
  mtimeMs: number;
}

export function loadIgnore(root: string) {
  const ig = ignore();
  for (const f of [path.join(root, '.gitignore'), path.join(root, '.git', 'info', 'exclude')]) {
    try {
      ig.add(fs.readFileSync(f, 'utf8'));
    } catch {
      /* optional */
    }
  }
  return ig;
}

/** Same rules as crawl(), for a single path (used by the save and file-watch path). */
export function isTracked(cfg: Config, ig: ReturnType<typeof ignore>, rel: string): boolean {
  return micromatch.isMatch(rel, cfg.include, { ignore: cfg.exclude, dot: false }) && !ig.ignores(rel);
}

/** Respects root .gitignore, .git/info/exclude and config globs. Skips oversize files. */
export async function crawl(root: string, cfg: Config): Promise<CrawlEntry[]> {
  const ig = loadIgnore(root);
  const entries = await fg(cfg.include, { cwd: root, ignore: cfg.exclude, dot: false, onlyFiles: true, stats: true, followSymbolicLinks: false });
  const out: CrawlEntry[] = [];
  for (const e of entries) {
    const rel = e.path.replace(/\\/g, '/');
    if (ig.ignores(rel)) continue;
    const size = e.stats?.size ?? 0;
    if (size > cfg.maxFileBytes) continue;
    out.push({ rel, size, mtimeMs: e.stats?.mtimeMs ?? 0 });
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

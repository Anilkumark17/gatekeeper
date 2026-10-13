import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Workspace, ops, GK_DIR } from '@gatekeeper/core';

const HELP = `gk - GateKeeper CLI (JSON on stdout)

  gk init [--mcp]        create .gatekeeper/, install the skill into .claude/skills/, optionally register the MCP server in .mcp.json
  gk plan --feature X --task A --task B [--replace]
  gk record --id ST-001 --status done --symbol S --assumes A --chose C --rejected R --why W --by agent|developer
  gk tree [--feature X] [--human]
  gk remove --id ST-001 | --feature X
  gk edit --id ST-001 [--title T] [--feature F]
  gk context --task "..." | --symbol S [--budget N]
  gk suspects --error "..." [--term T] [--symbol S] [--top N]
  gk check --id ST-001 --result confirmed|cleared [--query Q-..]
  gk miss --note "true cause was outside the record" [--query Q-..]
  gk verify [--max-orphan-rate 0.1]
  gk meta [--accept FILE | --reject FILE]
  gk sync
  global: --root DIR`;

function findRoot(start: string): string {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, GK_DIR)) || fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return path.resolve(start);
    d = up;
  }
}

/** Wire GateKeeper into a project: the skill for the agent, optionally the MCP server. Never overwrites a skill the user edited. */
function install(root: string, mcp: boolean) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const res: Record<string, string> = {};
  const skillSrc = [path.join(here, 'skill', 'SKILL.md'), path.resolve(here, '../../../.claude/skills/gatekeeper/SKILL.md')].find((p) => fs.existsSync(p));
  const skillDst = path.join(root, '.claude', 'skills', 'gatekeeper', 'SKILL.md');
  if (skillSrc && !fs.existsSync(skillDst)) {
    fs.mkdirSync(path.dirname(skillDst), { recursive: true });
    fs.copyFileSync(skillSrc, skillDst);
    res.skill = skillDst;
  } else res.skill = fs.existsSync(skillDst) ? 'already installed (left untouched)' : 'skill source not found';
  if (mcp) {
    const mcpJs = path.resolve(here, '../../mcp/dist/mcp.mjs');
    const entry = fs.existsSync(mcpJs) ? { command: 'node', args: [mcpJs, '--root', root] } : { command: 'gatekeeper-mcp', args: ['--root', root] };
    const file = path.join(root, '.mcp.json');
    let cfg: any = {};
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* new file */
    }
    cfg.mcpServers = { ...(cfg.mcpServers ?? {}), gatekeeper: entry };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    res.mcp = file;
  }
  return res;
}

const out = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') return void console.log(HELP);
  const { values: v } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      root: { type: 'string' }, feature: { type: 'string' }, task: { type: 'string', multiple: true }, id: { type: 'string' },
      status: { type: 'string' }, symbol: { type: 'string', multiple: true }, assumes: { type: 'string', multiple: true },
      assume: { type: 'string', multiple: true }, chose: { type: 'string' }, rejected: { type: 'string' }, why: { type: 'string' },
      by: { type: 'string' }, human: { type: 'boolean' }, error: { type: 'string' }, term: { type: 'string', multiple: true },
      result: { type: 'string' }, query: { type: 'string' }, note: { type: 'string' }, title: { type: 'string' }, replace: { type: 'boolean' },
      budget: { type: 'string' }, mcp: { type: 'boolean' }, top: { type: 'string' }, accept: { type: 'string' }, reject: { type: 'string' }, 'max-orphan-rate': { type: 'string' },
    },
  });
  // init always targets the directory you are in; every other command finds the nearest initialized project
  const root = v.root ? path.resolve(v.root) : cmd === 'init' ? process.cwd() : findRoot(process.cwd());
  const need = (k: string, val: unknown) => {
    if (!val) throw new Error(`missing --${k}`);
    return val as string;
  };

  if (cmd === 'init') {
    const ws = await Workspace.open(root);
    ops.init(ws);
    const r = await ops.sync(ws);
    return out({ root, ...r, ...install(root, !!v.mcp) });
  }
  const ws = await Workspace.open(root);
  switch (cmd) {
    case 'plan':
      return out(ops.plan(ws, { feature: need('feature', v.feature), tasks: need('task', v.task?.length ? v.task : undefined) as unknown as string[], replace: v.replace }));
    case 'record':
      return out(await ops.record(ws, {
        id: need('id', v.id), status: (v.status as 'done') ?? 'done', symbols: v.symbol, assumes: [...(v.assumes ?? []), ...(v.assume ?? [])],
        chose: v.chose, rejected: v.rejected, why: v.why, by: v.by as 'agent' | 'developer' | undefined,
      }));
    case 'next':
      return out(ops.next(ws));
    case 'tree': {
      const t = ops.tree(ws, { feature: v.feature });
      if (v.human) return void console.log(ops.renderTree(t));
      return out(t);
    }
    case 'remove':
      return out(ops.remove(ws, { id: v.id, feature: v.feature }));
    case 'edit':
      return out(ops.edit(ws, { id: need('id', v.id), title: v.title, feature: v.feature }));
    case 'context':
      return out(ops.context(ws, { task: v.task?.[0], symbols: v.symbol, budget: v.budget ? +v.budget : undefined }));
    case 'suspects':
      return out(ops.suspects(ws, { error: v.error, terms: v.term, symbols: v.symbol }));
    case 'check': {
      const r = ops.check(ws, { id: need('id', v.id), result: need('result', v.result) as 'confirmed', qid: v.query });
      if (!r.ok) process.exitCode = 1;
      return out(r);
    }
    case 'miss':
      return out(ops.miss(ws, { note: need('note', v.note), qid: v.query }));
    case 'verify': {
      const r = await ops.verify(ws);
      out(r);
      if (v['max-orphan-rate'] && r.orphan_rate > +v['max-orphan-rate']) process.exitCode = 2;
      return;
    }
    case 'meta':
      return out(ops.meta(ws, { accept: v.accept, reject: v.reject }));
    case 'sync':
      return out(await ops.sync(ws));
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message ?? e) }) + '\n');
  process.exitCode = 1;
});

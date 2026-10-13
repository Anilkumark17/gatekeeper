// Builds ./plugin: a self-contained Claude Code plugin (skill + bundled MCP server).
// Committed to git so `claude plugin install` works straight from the repo.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const P = 'plugin';
const banner = `import {createRequire as __cr} from 'node:module';import {fileURLToPath as __fu} from 'node:url';import __p from 'node:path';const require=__cr(import.meta.url);const __filename=__fu(import.meta.url);const __dirname=__p.dirname(__filename);`;

fs.rmSync(P, { recursive: true, force: true });
await build({ bundle: true, platform: 'node', format: 'esm', target: 'node20', banner: { js: banner }, entryPoints: ['packages/mcp/src/main.ts'], outfile: `${P}/dist/mcp.mjs`, logLevel: 'warning' });

const g = `${P}/dist/grammars`;
fs.mkdirSync(g, { recursive: true });
for (const n of ['typescript', 'tsx', 'javascript', 'python']) fs.copyFileSync(`node_modules/tree-sitter-wasms/out/tree-sitter-${n}.wasm`, path.join(g, `tree-sitter-${n}.wasm`));
fs.copyFileSync('node_modules/web-tree-sitter/tree-sitter.wasm', path.join(g, 'tree-sitter.wasm'));

fs.mkdirSync(`${P}/skills/gatekeeper`, { recursive: true });
fs.copyFileSync('.claude/skills/gatekeeper/SKILL.md', `${P}/skills/gatekeeper/SKILL.md`);

fs.mkdirSync(`${P}/.claude-plugin`, { recursive: true });
fs.writeFileSync(`${P}/.claude-plugin/plugin.json`, JSON.stringify({
  name: 'gatekeeper', version: '0.2.0', license: 'MIT',
  description: 'Reasoning harness for coding agents: live code graph joined to recorded intent (assumptions, decisions), with suspect ranking for debugging.',
}, null, 2) + '\n');

fs.writeFileSync(`${P}/.mcp.json`, JSON.stringify({ mcpServers: { gatekeeper: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/mcp.mjs'] } } }, null, 2) + '\n');

fs.mkdirSync(`${P}/hooks`, { recursive: true });
fs.copyFileSync('scripts/gate-hook.mjs', `${P}/hooks/gate.mjs`);
const hook = (arg) => [{ type: 'command', command: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/gate.mjs" ${arg}` }];
fs.writeFileSync(`${P}/hooks/hooks.json`, JSON.stringify({
  hooks: {
    UserPromptSubmit: [{ hooks: hook('prompt') }],
    PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: hook('edit') }],
  },
}, null, 2) + '\n');

fs.mkdirSync(`${P}/commands`, { recursive: true });
fs.writeFileSync(`${P}/commands/init.md`, `---
description: Set up GateKeeper in this project
---
Call the gk_init tool, then gk_tree. Tell me in one line what was created. Remind me to commit .gatekeeper/ and to install the VS Code extension for the panel.
`);
console.log('plugin built');

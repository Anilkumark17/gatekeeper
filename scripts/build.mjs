import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const banner = `import {createRequire as __cr} from 'node:module';import {fileURLToPath as __fu} from 'node:url';import __p from 'node:path';const require=__cr(import.meta.url);const __filename=__fu(import.meta.url);const __dirname=__p.dirname(__filename);`;
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node20', banner: { js: banner }, logLevel: 'info' };
const which = process.argv[2] ?? 'all';

function copyGrammars(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const g of ['typescript', 'tsx', 'javascript', 'python'])
    fs.copyFileSync(`node_modules/tree-sitter-wasms/out/tree-sitter-${g}.wasm`, path.join(dest, `tree-sitter-${g}.wasm`));
  fs.copyFileSync('node_modules/web-tree-sitter/tree-sitter.wasm', path.join(dest, 'tree-sitter.wasm'));
}

if (which === 'all' || which === 'cli') {
  await build({ ...common, entryPoints: ['packages/cli/src/main.ts'], outfile: 'packages/cli/dist/gk.mjs' });
  copyGrammars('packages/cli/dist/grammars');
  fs.mkdirSync('packages/cli/dist/skill', { recursive: true });
  fs.copyFileSync('.claude/skills/gatekeeper/SKILL.md', 'packages/cli/dist/skill/SKILL.md');
}
if (which === 'all' || which === 'mcp') {
  await build({ ...common, entryPoints: ['packages/mcp/src/main.ts'], outfile: 'packages/mcp/dist/mcp.mjs' });
  copyGrammars('packages/mcp/dist/grammars');
}
if (which === 'all' || which === 'vscode') {
  await build({
    ...common, format: 'cjs', banner: {}, entryPoints: ['packages/vscode/src/extension.ts'], outfile: 'packages/vscode/dist/extension.cjs',
    external: ['vscode'], define: { 'import.meta.url': '__importMetaUrl' }, inject: ['scripts/importMetaShim.js'],
  });
  copyGrammars('packages/vscode/dist/grammars');
  fs.copyFileSync('packages/vscode/src/webview/panel.js', 'packages/vscode/dist/panel.js');
  fs.copyFileSync('packages/vscode/src/webview/panel.css', 'packages/vscode/dist/panel.css');
}


if (which === 'all' || which === 'plugin') await import('./plugin.mjs');

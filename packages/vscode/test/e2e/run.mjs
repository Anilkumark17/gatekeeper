// Usage: node run.mjs <repo>   (needs: npm run build, VS Code installed, python + pytest for the fixture repo)
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const repo = path.resolve(process.argv[2]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-e2e-'));
const fixture = path.join(tmp, 'fixture.json');
const result = path.join(tmp, 'result.json');

const prep = cp.spawnSync('npx', ['tsx', path.join(here, 'prepare.mts'), repo, fixture], { cwd: root, encoding: 'utf8', shell: true });
process.stdout.write(prep.stdout + prep.stderr);
if (prep.status) process.exit(prep.status);

const exe = process.env.CODE_EXE ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
const args = [
  repo, `--extensionDevelopmentPath=${path.join(root, 'packages/vscode')}`, `--extensionTestsPath=${path.join(here, 'suite.cjs')}`,
  `--user-data-dir=${path.join(tmp, 'ud')}`, `--extensions-dir=${path.join(tmp, 'ext')}`, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-telemetry',
];
const r = cp.spawnSync(exe, args, { env: { ...process.env, GK_E2E_FIXTURE: fixture, GK_E2E_RESULT: result }, encoding: 'utf8', timeout: 180_000 });
if (r.error) console.error(r.error);
if (!fs.existsSync(result)) { console.error('no result file; editor output:\n', r.stdout, r.stderr); process.exit(1); }
const res = JSON.parse(fs.readFileSync(result, 'utf8'));
for (const s of res.steps) console.log(`✔ ${s.name}\n    ${s.detail}`);
if (!res.ok) { console.error('✖ FAILED\n' + res.error); process.exit(1); }
console.log('\nE2E PASS: failing test -> ranked suspect -> hover assumption -> Check logged, all inside the editor.');

/** Seeds a repo with intent before the editor launches. Usage: tsx prepare.ts <repo> <out.json> */
import fs from 'node:fs';
import path from 'node:path';
import { Workspace, ops } from '../../../core/src/index.ts';

const repo = path.resolve(process.argv[2]);
fs.rmSync(path.join(repo, '.gatekeeper'), { recursive: true, force: true });
const ws = await Workspace.open(repo);
ops.init(ws);
await ws.outer();
const { tasks } = ops.plan(ws, { feature: 'redirects', tasks: ['Follow redirects with a hop limit', 'Memoize auth flow results', 'Format TLS certificates for the CLI', 'Cookie jar merge'] });
await ops.record(ws, {
  id: tasks[0].id, symbols: ['Client._send_handling_redirects'],
  assumes: ['callers pass follow_redirects explicitly; the default stays False so a 3xx is returned, not followed'],
  chose: 'loop with a history list', rejected: 'recursion', why: 'bounded stack depth', by: 'agent',
});
await ops.record(ws, {
  id: tasks[1].id, symbols: ['Client._send_handling_auth'],
  assumes: ['a 60s stale read of the auth state is acceptable to every caller'], chose: 'per-client memo', rejected: 'global cache', why: 'isolation', by: 'agent',
});
await ops.record(ws, { id: tasks[2].id, symbols: ['format_certificate'], assumes: ['the peer certificate dict always has a subject'], by: 'agent' });
await ops.record(ws, { id: tasks[3].id, symbols: ['Cookies.extract_cookies'], by: 'developer' });
fs.writeFileSync(path.resolve(process.argv[3]), JSON.stringify({ repo, tasks: tasks.map((t) => t.id), redirectSymbol: 'httpx/_client.py:Client._send_handling_redirects', authSymbol: 'httpx/_client.py:Client._send_handling_auth' }, null, 2));
console.log('seeded', tasks.map((t) => t.id).join(','));

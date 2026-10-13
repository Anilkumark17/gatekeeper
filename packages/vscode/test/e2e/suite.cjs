// Runs INSIDE VS Code (extension host). Proves the editor claim end to end, in the real editor, with no browser.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, what = 'condition') {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

exports.run = async function run() {
  const out = { steps: [], ok: false };
  const step = (name, detail) => { out.steps.push({ name, detail }); };
  const resultFile = process.env.GK_E2E_RESULT;
  try {
    const fx = JSON.parse(fs.readFileSync(process.env.GK_E2E_FIXTURE, 'utf8'));
    const ext = vscode.extensions.getExtension('gatekeeper.gatekeeper-vscode');
    const api = await ext.activate();
    const ctl = await until(() => api.controller(), 20000, 'controller');
    await until(() => ctl.ws, 20000, 'workspace indexed');
    step('activated', `${ctl.ws.graph.liveNodes().length} nodes`);

    // opened a browser? Record any attempt.
    let browserCalls = 0;
    const origOpen = vscode.env.openExternal;
    try { vscode.env.openExternal = async (u) => { browserCalls++; return false; }; } catch { /* readonly in some builds */ }

    const sym = ctl.ws.graph.get(fx.redirectSymbol);
    const doc = await vscode.workspace.openTextDocument(path.join(fx.repo, sym.props.file));
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const pos = new vscode.Position(sym.props.line - 1, (sym.props.col || 0) + 2);

    // 1. hover on the symbol shows the recorded assumption, decision, rejection, author, age
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, pos);
    const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    if (!/assumes/.test(text) || !/default stays False/.test(text) || !/Rejected/.test(text) || !/recursion/.test(text) || !/agent/.test(text)) throw new Error('hover missing fields:\n' + text);
    step('hover shows assumption + decision + rejected + author + age', text.split('\n').filter(Boolean).slice(0, 6).join(' | '));

    // 2. CodeLens above the symbol
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri);
    const lens = lenses.find((l) => l.range.start.line === sym.props.line - 1 && l.command && /assumption/.test(l.command.title));
    if (!lens) throw new Error('no codelens with assumption count on ' + sym.props.line + '; got ' + lenses.map((l) => l.command && l.command.title).join(','));
    step('codelens above symbol', lens.command.title);

    // 3. open the panel, wait for the webview's JS to run and report its first paint
    ctl.openPanel(fx.redirectSymbol);
    await until(() => ctl.webviewReady && ctl.lastRendered && ctl.lastRendered.nodes > 0, 20000, 'webview first paint');
    step('panel painted beside editor', `${ctl.lastRendered.nodes} nodes, ${ctl.lastRendered.treeTasks} tree tasks`);

    // 4. failing test -> ranked suspects (real pytest failure, real output)
    const r = cp.spawnSync('python', ['-m', 'pytest', 'tests/test_gk_failing.py', '-x', '-q', '-p', 'no:cacheprovider'], { cwd: fx.repo, encoding: 'utf8' });
    if (r.status === 0) throw new Error('expected the fixture test to fail');
    const failure = r.stdout + r.stderr;
    await ctl.runDebug(failure);
    const res = ctl.debug.result;
    step('ranked from failing test output', `suspects=${res.suspects.map((s) => s.id).join(',')} also=${res.also_considered.map((s) => s.id).join(',')} cleared=${res.cleared.join(',')}`);
    const redirectTask = fx.tasks[0];
    const authTask = fx.tasks[1];
    const lit = await until(() => ctl.lastRendered && ctl.lastRendered.lit && ctl.lastRendered.lit.length && ctl.lastRendered, 20000, 'lit nodes in webview');
    step('webview lit nodes', lit.lit.join(', '));
    if (!lit.lit.some((l) => l.startsWith(fx.redirectSymbol))) throw new Error('redirect suspect not lit in panel');
    if (!lit.lit.some((l) => l.startsWith(fx.authSymbol))) throw new Error('auth (caching) record not lit in panel');
    await until(() => ctl.lastRendered.debugCards > 0, 10000, 'debug cards rendered');

    // 5. hover now carries the band for the current symptom
    const hovers2 = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, pos);
    const text2 = hovers2.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    if (!/(Likely|Possible) suspect/.test(text2)) throw new Error('hover lacks band:\n' + text2);
    step('hover shows band for the symptom', (text2.match(/(Likely|Possible) suspect/) || [])[0]);

    // 6. Check logs to outcomes.jsonl
    ctl.doCheck(redirectTask, 'confirmed');
    await sleep(200);
    const outcomes = fs.readFileSync(path.join(fx.repo, '.gatekeeper', 'outcomes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const chk = outcomes.find((o) => o.k === 'check' && o.id === redirectTask);
    if (!chk || chk.result !== 'confirmed') throw new Error('check not logged');
    step('Check logged to outcomes.jsonl', `${chk.id} ${chk.result} rank=${chk.rank} band=${chk.band}`);

    // 7. dynamic tree: removal by "the agent" (another process writing intent.jsonl) reaches the panel
    const before = ctl.lastRendered.treeTasks;
    const cli = path.resolve(__dirname, '../../../cli/dist/gk.mjs');
    cp.spawnSync('node', [cli, 'remove', '--id', fx.tasks[3], '--root', fx.repo], { encoding: 'utf8' });
    await until(() => ctl.lastRendered.treeTasks === before - 1, 10000, 'tree to drop the removed task');
    step('tree dropped removed subtask', `${before} -> ${ctl.lastRendered.treeTasks}`);

    // 8. dynamic tree: code edit on disk marks the symbol as changed since recorded
    const file = path.join(fx.repo, sym.props.file);
    const src = fs.readFileSync(file, 'utf8');
    try {
      const eol = src.includes('\r\n') ? '\r\n' : '\n';
      const lines = src.split(eol);
      const body = lines.findIndex((l, i) => i > sym.props.line - 1 && /^ {8}\S/.test(l));
      lines.splice(body, 0, '        history = []  # gk-e2e edit');
      fs.writeFileSync(file, lines.join(eol));
      await until(() => hasDrift(ctl), 10000, 'drift flagged after external edit');
      step('external code edit reached the graph (inner loop via file watcher)', 'symbol body changed since recorded');
    } finally {
      fs.writeFileSync(file, src);
    }

    if (process.env.GK_E2E_HOLD) {
      // leave the editor in the debug state so a screenshot can be taken
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      fs.writeFileSync(process.env.GK_E2E_HOLD, 'ready');
      await sleep(9000);
    }
    step('browser opened', `${browserCalls} times`);
    if (browserCalls) throw new Error('a browser was opened');
    out.ok = true;
  } catch (e) {
    out.error = String(e && e.stack || e);
  }
  fs.writeFileSync(resultFile, JSON.stringify(out, null, 2));
  if (!out.ok) throw new Error(out.error);
};

function hasDrift(ctl) {
  const core = ctl.ws;
  // read the tree the same way the panel does
  const events = core.store.intentEvents();
  const tasks = new Map();
  for (const ev of events) if (ev.k === 'record') tasks.set(ev.id, ev);
  for (const ev of tasks.values()) {
    for (const [id, sig] of Object.entries(ev.sigs || {})) {
      const n = core.graph.get(id);
      if (n && n.props.sig && n.props.sig !== sig) return true;
    }
  }
  return false;
}

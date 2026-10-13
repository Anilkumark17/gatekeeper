import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Workspace, ops, GK_DIR, type GNode, type SuspectResult } from '@gatekeeper/core';

/* ------------------------------------------------------------------ types shared with the webview */

interface VNode {
  id: string; label: string; type: string; file?: string; line?: number; resolved: boolean; reason?: string; intent: number; dist: number;
}
interface VEdge { from: string; to: string; kind: string; resolved: boolean }
type Band = 'likely' | 'possible' | 'cleared';
interface BandInfo { band: Band; tasks: string[]; reasons: string[] }

const LANGS = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'python'];
const MAX_RENDER = 400;

class Controller implements vscode.HoverProvider, vscode.CodeLensProvider {
  ws: Workspace | null = null;
  panel: vscode.WebviewPanel | null = null;
  webviewReady = false;
  /** last paint the webview reported; the e2e test uses it to prove what is actually lit */
  lastRendered: any = null;
  focus: string | null = null;
  hops = 1;
  mode: 'graph' | 'tree' | 'debug' = 'tree';
  debug: { result: SuspectResult; checked: Map<string, string> } | null = null;

  private rendered = new Map<string, string>();
  private renderedEdges = new Set<string>();
  private intentBySymbol = new Map<string, { id: string; title: string; assumes: string[]; chose?: string; rejected?: string; why?: string; by?: string; age: string; drifted: boolean }[]>();
  private bands = new Map<string, BandInfo>();
  private suppressUntil = 0;
  private pending = new Set<string>();
  private pendingTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lensEmitter = new vscode.EventEmitter<void>();
  onDidChangeCodeLenses = this.lensEmitter.event;
  private status: vscode.StatusBarItem;
  private gutter: vscode.TextEditorDecorationType;
  private decoLikely: vscode.TextEditorDecorationType;
  private decoPossible: vscode.TextEditorDecorationType;
  private decoCleared: vscode.TextEditorDecorationType;

  constructor(private ctx: vscode.ExtensionContext, readonly root: string) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'gatekeeper.openPanel';
    this.gutter = vscode.window.createTextEditorDecorationType({ gutterIconPath: vscode.Uri.file(path.join(ctx.extensionPath, 'media', 'assumption.svg')), gutterIconSize: 'contain' });
    const after = (txt: string, colorId: string) => ({ contentText: `   ${txt}`, color: new vscode.ThemeColor(colorId), fontStyle: 'italic' });
    this.decoLikely = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'), overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'), after: after('', 'editorCodeLens.foreground') });
    this.decoPossible = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'), after: after('', 'editorCodeLens.foreground') });
    this.decoCleared = vscode.window.createTextEditorDecorationType({ after: after('', 'editorGhostText.foreground') });
    ctx.subscriptions.push(this.status, this.gutter, this.decoLikely, this.decoPossible, this.decoCleared, this.lensEmitter);
    this.status.text = '$(sync~spin) GateKeeper indexing…';
    this.status.show();
  }

  /* ------------------------------------------------------------------ lifecycle */

  async start() {
    const t = performance.now();
    this.ws = await Workspace.open(this.root);
    this.refreshIntent();
    this.setStatus(`indexed in ${Math.round(performance.now() - t)}ms`);
    this.paintEditors();
    this.lensEmitter.fire();
    this.watch();
  }

  private setStatus(extra = '') {
    if (!this.ws) return;
    const rep = this.ws.report(this.ws.intent());
    const n = this.ws.graph.liveNodes().length;
    this.status.text = `$(shield) GK ${n} nodes${rep.orphanCount ? ` · ${rep.orphanCount} orphaned` : ''}`;
    this.status.tooltip = `GateKeeper: ${extra}${this.ws.stale.size ? ` · ${this.ws.stale.size} stale file(s) pending` : ''}`;
    this.status.show();
  }

  private watch() {
    const mk = (glob: string) => vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, glob));
    const intentW = mk(`${GK_DIR}/{intent,outcomes}.jsonl`);
    const onIntent = debounce(() => this.onIntentChanged(), 80);
    intentW.onDidChange(onIntent); intentW.onDidCreate(onIntent); intentW.onDidDelete(onIntent);
    const gateW = mk(`${GK_DIR}/gate.json`);
    const onGate = debounce(() => this.onGateChanged(), 60);
    gateW.onDidChange(onGate); gateW.onDidCreate(onGate);
    const srcW = mk('**/*.{ts,tsx,js,jsx,mjs,cjs,py}');
    const onSrc = (u: vscode.Uri) => this.queueFile(u.fsPath);
    srcW.onDidChange(onSrc); srcW.onDidCreate(onSrc); srcW.onDidDelete(onSrc);
    const gitW = mk('.git/logs/HEAD');
    const onCommit = debounce(() => void this.outer(), 400);
    gitW.onDidChange(onCommit); gitW.onDidCreate(onCommit);
    this.ctx.subscriptions.push(intentW, gateW, srcW, gitW,
      vscode.workspace.onDidSaveTextDocument((d) => this.queueFile(d.uri.fsPath, 0)),
      vscode.window.onDidChangeTextEditorSelection(debounce((e: vscode.TextEditorSelectionChangeEvent) => this.onSelection(e), 90)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.paintEditors()),
      vscode.window.onDidChangeActiveTextEditor(() => this.onSelectionActive()),
    );
  }

  /* ------------------------------------------------------------------ inner loop */

  private queueFile(fsPath: string, delay = 120) {
    const rel = path.relative(this.root, fsPath).replace(/\\/g, '/');
    if (rel.startsWith('..') || rel.startsWith(GK_DIR + '/') || rel.includes('node_modules/')) return;
    this.pending.add(rel);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => void this.flush(), delay);
  }

  private async flush() {
    if (!this.ws) return;
    const files = [...this.pending];
    this.pending.clear();
    const budget = vscode.workspace.getConfiguration('gatekeeper').get<number>('innerLoopBudgetMs', 300);
    let worst = 0;
    let changed = false;
    for (const f of files) {
      const r = await this.ws.saveFile(f, budget);
      worst = Math.max(worst, r.ms);
      if (r.status === 'updated' || r.status === 'removed') changed = true;
    }
    if (this.ws.stale.size) this.scheduleIdle();
    if (changed) this.afterGraphChange(`saved in ${Math.round(worst)}ms`);
  }

  /** Heavy files were marked stale instead of blocking; finish them once the editor is idle. */
  private scheduleIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(async () => {
      if (!this.ws) return;
      await this.ws.finishStale();
      this.afterGraphChange('stale files finished on idle');
    }, 1500);
  }

  private afterGraphChange(msg: string) {
    this.refreshIntent();
    this.setStatus(msg);
    this.paintEditors();
    this.lensEmitter.fire();
    this.repaintPanel();
    this.postTree();
  }

  async outer() {
    if (!this.ws) return;
    const d = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'GateKeeper: rebuilding' }, () => this.ws!.outer());
    this.afterGraphChange(`outer loop ${Math.round(d.ms)}ms · +${d.added.length} -${d.removed.length} ~${d.modified.length}`);
    if (d.renamed.length) vscode.window.showInformationMessage(`GateKeeper: kept intent across ${d.renamed.length} rename(s).`);
    if (d.orphanCount) vscode.window.showWarningMessage(`GateKeeper: ${d.orphanCount} intent symbol(s) no longer exist.`);
  }

  /* ------------------------------------------------------------------ intent index */

  /** A prompt just hit the hook (or the plan landed): show the tree, not the graph. */
  private onGateChanged() {
    if (!this.ws) return;
    const g = this.ws.store.readGate();
    if (g.pending) {
      this.mode = 'tree';
      this.openPanel();
      this.post({ type: 'mode', mode: 'tree' });
    }
    this.postTree();
  }

  private onIntentChanged() {
    this.refreshIntent();
    this.paintEditors();
    this.lensEmitter.fire();
    this.postTree();
    this.repaintPanel();
    if (this.debug) this.syncChecks();
  }

  refreshIntent() {
    this.intentBySymbol.clear();
    if (!this.ws) return;
    const t = ops.tree(this.ws);
    for (const f of t.features) {
      for (const k of f.tasks) {
        if (k.status === 'planned' && !k.assumes.length) continue;
        for (const s of k.symbols) {
          const list = this.intentBySymbol.get(s.id) ?? [];
          list.push({ id: k.id, title: k.title, assumes: k.assumes, chose: k.chose, rejected: k.rejected, why: k.why, by: k.by, age: k.age, drifted: s.drifted });
          this.intentBySymbol.set(s.id, list);
        }
      }
    }
  }

  /* ------------------------------------------------------------------ editor features */

  private relOf(doc: vscode.TextDocument) {
    const rel = path.relative(this.root, doc.uri.fsPath).replace(/\\/g, '/');
    return rel.startsWith('..') ? null : rel;
  }

  paintEditors() {
    if (!this.ws) return;
    for (const ed of vscode.window.visibleTextEditors) {
      const rel = this.relOf(ed.document);
      if (!rel) continue;
      const gut: vscode.Range[] = [];
      const likely: vscode.DecorationOptions[] = [];
      const possible: vscode.DecorationOptions[] = [];
      const cleared: vscode.DecorationOptions[] = [];
      for (const n of this.ws.graph.filesNodes(rel)) {
        if (n.type === 'module' || n.props.line == null) continue;
        const line = Math.min(n.props.line - 1, ed.document.lineCount - 1);
        if (this.intentBySymbol.get(n.id)?.some((t) => t.assumes.length)) gut.push(new vscode.Range(line, 0, line, 0));
        const b = this.bands.get(n.id);
        if (!b) continue;
        const label = { likely: '▲ likely suspect', possible: '◇ possible suspect', cleared: '✓ cleared' }[b.band];
        const hover = new vscode.MarkdownString(`**GateKeeper ${label}** (${b.tasks.join(', ')})\n\n${b.reasons.map((r) => `- ${r}`).join('\n')}`);
        const range = new vscode.Range(line, 0, Math.min((n.props.endLine ?? n.props.line) - 1, ed.document.lineCount - 1), 0);
        const opt: vscode.DecorationOptions = { range: b.band === 'cleared' ? new vscode.Range(line, 0, line, 0) : range, hoverMessage: hover, renderOptions: { after: { contentText: `   ${label} · ${b.tasks.join(', ')}` } } };
        (b.band === 'likely' ? likely : b.band === 'possible' ? possible : cleared).push(opt);
      }
      ed.setDecorations(this.gutter, gut);
      ed.setDecorations(this.decoLikely, likely);
      ed.setDecorations(this.decoPossible, possible);
      ed.setDecorations(this.decoCleared, cleared);
    }
  }

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    if (!this.ws) return;
    const rel = this.relOf(doc);
    if (!rel) return;
    const n = this.ws.graph.filesNodes(rel).find((x) => x.type !== 'module' && x.props.line != null && x.props.line - 1 === pos.line && pos.character >= (x.props.col ?? 0) && pos.character <= (x.props.col ?? 0) + x.props.name.length);
    if (!n) return;
    const tasks = this.intentBySymbol.get(n.id) ?? [];
    const band = this.bands.get(n.id);
    if (!tasks.length && !band) return;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['gatekeeper.focusSymbol'] };
    md.appendMarkdown(`**GateKeeper** · \`${n.props.name}\`\n\n`);
    if (band) md.appendMarkdown(`**${{ likely: '▲ Likely suspect', possible: '◇ Possible suspect', cleared: '✓ Cleared' }[band.band]}** for the current symptom\n${band.reasons.map((r) => `- ${r}`).join('\n')}\n\n`);
    for (const t of tasks) {
      md.appendMarkdown(`---\n`);
      for (const a of t.assumes) md.appendMarkdown(`$(warning) **assumes:** ${esc(a)}\n\n`);
      md.appendMarkdown(`Subtask \`${t.id}\` — ${esc(t.title)}\n\n`);
      if (t.chose) md.appendMarkdown(`**Chose:** ${esc(t.chose)}\n\n`);
      if (t.rejected) md.appendMarkdown(`**Rejected:** ${esc(t.rejected)}${t.why ? ` — ${esc(t.why)}` : ''}\n\n`);
      else if (t.why) md.appendMarkdown(`**Why:** ${esc(t.why)}\n\n`);
      md.appendMarkdown(`*by ${t.by ?? 'unknown'}, ${t.age}*${t.drifted ? ' · $(alert) code changed since this was recorded' : ''}\n\n`);
    }
    const arg = encodeURIComponent(JSON.stringify([n.id]));
    md.appendMarkdown(`[Open in GateKeeper panel](command:gatekeeper.focusSymbol?${arg})`);
    return new vscode.Hover(md, new vscode.Range(pos.line, n.props.col ?? 0, pos.line, (n.props.col ?? 0) + n.props.name.length));
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.ws) return [];
    const rel = this.relOf(doc);
    if (!rel) return [];
    const lenses: vscode.CodeLens[] = [];
    for (const n of this.ws.graph.filesNodes(rel)) {
      if ((n.type !== 'function' && n.type !== 'class') || n.props.line == null) continue;
      const deps = this.ws.graph.dependents(n.id).filter((d) => this.ws!.graph.get(d)?.type !== 'module').length;
      const ass = (this.intentBySymbol.get(n.id) ?? []).reduce((a, t) => a + t.assumes.length, 0);
      if (!deps && !ass) continue;
      const parts = [`${deps} dependent${deps === 1 ? '' : 's'}`];
      if (ass) parts.push(`${ass} assumption${ass === 1 ? '' : 's'}`);
      const r = new vscode.Range(Math.min(n.props.line - 1, doc.lineCount - 1), 0, Math.min(n.props.line - 1, doc.lineCount - 1), 0);
      lenses.push(new vscode.CodeLens(r, { title: parts.join(' · '), command: 'gatekeeper.focusSymbol', arguments: [n.id] }));
    }
    return lenses;
  }

  /* ------------------------------------------------------------------ editor <-> panel sync */

  private symbolAtCursor(): string | null {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !this.ws) return null;
    const rel = this.relOf(ed.document);
    if (!rel || !this.ws.linker.hasFile(rel)) return null;
    return this.ws.graph.symbolAt(rel, ed.selection.active.line + 1)?.id ?? rel;
  }

  private onSelection(e: vscode.TextEditorSelectionChangeEvent) {
    if (e.textEditor !== vscode.window.activeTextEditor) return;
    this.onSelectionActive();
  }

  private onSelectionActive() {
    if (!this.panel || Date.now() < this.suppressUntil) return;
    const id = this.symbolAtCursor();
    if (id && id !== this.focus) this.setFocus(id);
  }

  /** Cursor moved to a new symbol. Inside the drawn region only the highlight moves; outside it the region is re-centered as a delta. */
  setFocus(id: string) {
    this.focus = id;
    if (!this.rendered.has(id)) this.repaintPanel();
    this.post({ type: 'focus', id });
  }

  async reveal(id: string) {
    const n = this.ws?.graph.get(id);
    if (!n?.props.file) return;
    this.suppressUntil = Date.now() + 500;
    const uri = vscode.Uri.file(path.join(this.root, n.props.file));
    const doc = await vscode.workspace.openTextDocument(uri);
    const line = Math.min((n.props.line ?? 1) - 1, doc.lineCount - 1);
    const col = n.props.col ?? 0;
    const sel = new vscode.Range(line, col, line, col + (n.type === 'module' ? 0 : n.props.name.length));
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: sel, preserveFocus: false });
    ed.revealRange(sel, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /* ------------------------------------------------------------------ panel */

  openPanel(focusId?: string) {
    if (!this.ws) return void vscode.window.showWarningMessage('GateKeeper is not initialized here. Run "GateKeeper: Initialize in This Workspace".');
    if (focusId) this.focus = focusId;
    else this.focus ??= this.symbolAtCursor();
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      if (focusId) this.setFocus(focusId);
      return;
    }
    const dist = vscode.Uri.file(path.join(this.ctx.extensionPath, 'dist'));
    const panel = vscode.window.createWebviewPanel('gatekeeper', 'GateKeeper', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist] });
    this.panel = panel;
    const nonce = Math.random().toString(36).slice(2);
    const js = panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'panel.js'));
    const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'panel.css'));
    panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head><body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
    panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), undefined, this.ctx.subscriptions);
    panel.onDidDispose(() => {
      this.panel = null;
      this.webviewReady = false;
      this.rendered.clear();
      this.renderedEdges.clear();
    });
  }

  private post(msg: unknown) {
    if (this.panel && this.webviewReady) void this.panel.webview.postMessage(msg);
  }

  private async onMessage(m: any) {
    if (!this.ws) return;
    switch (m.type) {
      case 'ready':
        this.webviewReady = true;
        this.rendered.clear();
        this.renderedEdges.clear();
        this.focus ??= this.symbolAtCursor() ?? this.ws.graph.liveNodes().find((n) => n.type === 'module')?.id ?? null;
        this.post({ type: 'mode', mode: this.mode });
        this.repaintPanel(true);
        this.postTree();
        this.postDebug();
        break;
      case 'select':
        this.focus = m.id;
        await this.reveal(m.id);
        this.post({ type: 'focus', id: m.id });
        break;
      case 'recenter':
        this.focus = m.id;
        this.repaintPanel();
        this.post({ type: 'focus', id: m.id });
        break;
      case 'hops':
        this.hops = Math.max(0, Math.min(4, m.value));
        this.repaintPanel();
        break;
      case 'mode':
        this.mode = m.mode;
        break;
      case 'rendered':
        this.lastRendered = m;
        break;
      case 'check':
        this.doCheck(m.id, m.result);
        break;
      case 'approve':
        ops.approve(this.ws, { id: m.id });
        this.postTree();
        break;
      case 'removeTask':
        ops.remove(this.ws, { id: m.id });
        this.onIntentChanged();
        break;
      case 'removeFeature':
        ops.remove(this.ws, { feature: m.feature });
        this.onIntentChanged();
        break;
      case 'editTask': {
        const title = await vscode.window.showInputBox({ prompt: `Rename ${m.id}`, value: m.title });
        if (title) {
          ops.edit(this.ws, { id: m.id, title });
          this.onIntentChanged();
        }
        break;
      }
    }
  }

  /** Build the focus subgraph and send only what changed since last paint. */
  repaintPanel(force = false) {
    if (!this.panel || !this.webviewReady || !this.ws) return;
    if (force) {
      this.rendered.clear();
      this.renderedEdges.clear();
    }
    let seeds: string[] = this.focus && this.ws.graph.has(this.focus) ? [this.focus] : [];
    if (this.mode === 'debug' && this.debug) seeds = [...new Set([...seeds, ...this.bands.keys()].filter((s) => this.ws!.graph.has(s)))].slice(0, 40);
    if (!seeds.length) {
      this.post({ type: 'delta', reset: true, nodes: { upsert: [], remove: [] }, edges: { add: [], remove: [] }, focus: null, total: 0, shown: 0 });
      return;
    }
    const sub = this.ws.graph.neighbors(seeds, this.hops);
    const ranked = [...sub.dist.entries()].filter(([id]) => {
      const n = this.ws!.graph.get(id)!;
      return n.type !== 'external' || (sub.dist.get(id) ?? 9) <= 1;
    }).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    const keep = ranked.slice(0, MAX_RENDER);
    const keepSet = new Set(keep.map(([id]) => id));
    // unresolved nodes are never silently dropped by the cap
    for (const [id] of ranked.slice(MAX_RENDER)) if (this.ws.graph.get(id)!.type === 'unresolved') keepSet.add(id);
    const nodes: VNode[] = [...keepSet].map((id) => this.toV(this.ws!.graph.get(id)!, sub.dist.get(id) ?? 0));
    const edges: VEdge[] = sub.edges.filter((e) => keepSet.has(e.from) && keepSet.has(e.to)).map((e) => ({ from: e.from, to: e.to, kind: e.kind, resolved: e.resolved }));

    const upsert: VNode[] = [];
    const nextSig = new Map<string, string>();
    for (const n of nodes) {
      const s = JSON.stringify(n);
      nextSig.set(n.id, s);
      if (this.rendered.get(n.id) !== s) upsert.push(n);
    }
    const remove = [...this.rendered.keys()].filter((id) => !nextSig.has(id));
    const keyOf = (e: VEdge) => `${e.from}|${e.kind}|${e.to}`;
    const nextEdges = new Map(edges.map((e) => [keyOf(e), e]));
    const addE = [...nextEdges.entries()].filter(([k]) => !this.renderedEdges.has(k)).map(([, e]) => e);
    const remE = [...this.renderedEdges].filter((k) => !nextEdges.has(k));
    this.rendered = nextSig;
    this.renderedEdges = new Set(nextEdges.keys());
    if (upsert.length || remove.length || addE.length || remE.length || force) {
      this.post({ type: 'delta', reset: force, nodes: { upsert, remove }, edges: { add: addE, remove: remE }, focus: this.focus, total: sub.dist.size, shown: keepSet.size, hops: this.hops });
    }
  }

  private toV(n: GNode, dist: number): VNode {
    const tasks = this.intentBySymbol.get(n.id) ?? [];
    const band = this.bands.get(n.id);
    return {
      id: n.id, label: n.type === 'module' ? n.props.name : n.id.slice(n.id.indexOf(':') + 1), type: n.type, file: n.props.file, line: n.props.line,
      resolved: n.props.resolved !== false && n.type !== 'unresolved', reason: n.props.reason, intent: tasks.filter((t) => t.assumes.length).length, dist,
      ...(band ? { band: band.band, tasks: band.tasks } : {}),
    } as VNode;
  }

  postTree() {
    if (this.ws) this.post({ type: 'tree', tree: ops.tree(this.ws) });
  }

  /* ------------------------------------------------------------------ debug */

  async runDebug(error: string) {
    if (!this.ws) return;
    await this.ws.sync();
    const result = ops.suspects(this.ws, { error });
    this.debug = { result, checked: new Map() };
    this.bands = ops.litBands(this.ws, result);
    this.mode = 'debug';
    this.openPanel();
    this.post({ type: 'mode', mode: 'debug' });
    this.repaintPanel(true);
    this.postDebug();
    this.paintEditors();
    vscode.window.setStatusBarMessage(`GateKeeper: ${result.suspects.length} likely, ${result.also_considered.length} possible, ${result.cleared.length} cleared`, 6000);
  }

  clearDebug() {
    this.debug = null;
    this.bands.clear();
    this.paintEditors();
    this.repaintPanel(true);
    this.postDebug();
  }

  private syncChecks() {
    if (!this.debug || !this.ws) return;
    const qid = this.debug.result.qid;
    this.debug.checked.clear();
    for (const e of this.ws.store.outcomeEvents()) if (e.k === 'check' && e.qid === qid) this.debug.checked.set(e.id, e.result);
    this.postDebug();
  }

  postDebug() {
    this.post({ type: 'debug', debug: this.debug ? { ...this.debug.result, checked: Object.fromEntries(this.debug.checked) } : null });
  }

  doCheck(id: string, result: 'confirmed' | 'cleared') {
    if (!this.ws || !this.debug) return;
    const r = ops.check(this.ws, { id, result, qid: this.debug.result.qid });
    if (!r.ok) return void vscode.window.showErrorMessage(`GateKeeper: ${(r as any).error}`);
    this.debug.checked.set(id, result);
    this.postDebug();
    vscode.window.setStatusBarMessage(`GateKeeper: logged ${id} ${result}`, 4000);
  }

  async pickCheck() {
    if (!this.debug) return void vscode.window.showInformationMessage('No active debug session. Rank suspects first.');
    const all = [...this.debug.result.suspects, ...this.debug.result.also_considered];
    const pick = await vscode.window.showQuickPick(all.map((e) => ({ label: `${e.id} ${e.title}`, description: e.assumes[0], id: e.id })), { placeHolder: 'Which suspect did you test?' });
    if (!pick) return;
    const res = await vscode.window.showQuickPick(['confirmed', 'cleared'], { placeHolder: `Was ${pick.id} the cause?` });
    if (res) this.doCheck(pick.id, res as 'confirmed');
  }

  dispose() {
    this.panel?.dispose();
  }
}

/* ------------------------------------------------------------------ helpers */

function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: NodeJS.Timeout | undefined;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

const esc = (s: string) => s.replace(/[\\`*_{}[\]<>]/g, '\\$&');
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');

/* ------------------------------------------------------------------ activation */

export async function activate(ctx: vscode.ExtensionContext) {
  let ctl: Controller | null = null;
  const api = { controller: () => ctl };
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return api;
  const root = folder.uri.fsPath;

  const boot = async () => {
    ctl = new Controller(ctx, root);
    ctx.subscriptions.push({ dispose: () => ctl?.dispose() });
    const sel = LANGS.map((language) => ({ scheme: 'file', language }));
    ctx.subscriptions.push(vscode.languages.registerHoverProvider(sel, ctl), vscode.languages.registerCodeLensProvider(sel, ctl));
    await ctl.start();
    hookTerminal(ctx, ctl);
  };

  const need = () => {
    if (!ctl) vscode.window.showWarningMessage('GateKeeper is not initialized. Run "GateKeeper: Initialize in This Workspace".');
    return ctl;
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('gatekeeper.init', async () => {
      if (ctl) return void vscode.window.showInformationMessage('GateKeeper is already active here.');
      fs.mkdirSync(path.join(root, GK_DIR), { recursive: true });
      const ws = await Workspace.open(root);
      ops.init(ws);
      await ws.outer();
      await boot();
      vscode.window.showInformationMessage('GateKeeper initialized. Commit .gatekeeper/ so intent travels with the repo.');
    }),
    vscode.commands.registerCommand('gatekeeper.openPanel', () => need()?.openPanel()),
    vscode.commands.registerCommand('gatekeeper.focusSymbol', (id?: string) => need()?.openPanel(id)),
    vscode.commands.registerCommand('gatekeeper.sync', () => need()?.outer()),
    vscode.commands.registerCommand('gatekeeper.clearDebug', () => need()?.clearDebug()),
    vscode.commands.registerCommand('gatekeeper.checkSuspect', () => need()?.pickCheck()),
    vscode.commands.registerCommand('gatekeeper.debug', async () => {
      const c = need();
      if (!c) return;
      const ed = vscode.window.activeTextEditor;
      const seed = ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : '';
      const text = await vscode.window.showInputBox({ prompt: 'Paste the error or describe the symptom', value: seed, ignoreFocusOut: true });
      if (text) await c.runDebug(text);
    }),
    vscode.commands.registerCommand('gatekeeper.debugFromClipboard', async () => {
      const text = await vscode.env.clipboard.readText();
      if (text.trim()) await need()?.runDebug(text);
      else vscode.window.showInformationMessage('Clipboard is empty.');
    }),
  );

  if (fs.existsSync(path.join(root, GK_DIR))) await boot();
  else {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    item.text = '$(shield) GateKeeper: set up';
    item.command = 'gatekeeper.init';
    item.show();
    ctx.subscriptions.push(item);
  }
  return api;
}

/**
 * Failing test -> suspects without leaving the editor. Shell integration lets us read the output of a
 * command that exited non-zero; we start collecting at execution start because read() only sees later data.
 */
function hookTerminal(ctx: vscode.ExtensionContext, ctl: Controller) {
  const w = vscode.window as any;
  if (!w.onDidStartTerminalShellExecution || !w.onDidEndTerminalShellExecution) return;
  const bufs = new WeakMap<object, { text: string }>();
  ctx.subscriptions.push(
    w.onDidStartTerminalShellExecution((e: any) => {
      const b = { text: '' };
      bufs.set(e.execution, b);
      void (async () => {
        try {
          for await (const chunk of e.execution.read()) b.text = (b.text + chunk).slice(-24_000);
        } catch {
          /* terminal closed */
        }
      })();
    }),
    w.onDidEndTerminalShellExecution(async (e: any) => {
      if (!e.exitCode || !vscode.workspace.getConfiguration('gatekeeper').get<boolean>('offerOnTestFailure', true)) return;
      const out = stripAnsi(bufs.get(e.execution)?.text ?? '');
      if (!/error|fail|assert|exception|traceback/i.test(out)) return;
      const pick = await vscode.window.showInformationMessage('Command failed. Rank GateKeeper suspects from its output?', 'Rank suspects');
      if (pick) await ctl.runDebug(out.slice(-6000));
    }),
  );
}

export function deactivate() {}

/* GateKeeper panel. Vanilla JS on purpose: no bundle, no framework, nothing to block the editor. */
(function () {
  const vscode = acquireVsCodeApi();
  const NS = 'http://www.w3.org/2000/svg';
  const GLYPH = { module: '▤', class: '◼', function: 'ƒ', data: '▦', unresolved: '?', external: '⧉' };
  const BAND = { likely: { glyph: '▲', text: 'likely' }, possible: { glyph: '◇', text: 'possible' }, cleared: { glyph: '✓', text: 'cleared' } };

  const state = {
    mode: (vscode.getState() || {}).mode || 'tree',
    nodes: new Map(), edges: new Map(), pos: new Map(), els: new Map(), edgeEls: new Map(),
    focus: null, tree: null, debug: null, total: 0, shown: 0, hops: 1,
    view: { x: -300, y: -200, w: 600, h: 400 }, fitted: false, simTicks: 0, raf: 0,
  };

  const app = document.getElementById('app');
  app.innerHTML = `
    <header>
      <div class="tabs" role="tablist" aria-label="GateKeeper views">
        <button role="tab" data-mode="graph" id="tab-graph">Graph</button>
        <button role="tab" data-mode="tree" id="tab-tree">Tree</button>
        <button role="tab" data-mode="debug" id="tab-debug">Debug</button>
      </div>
      <span id="hopctl" aria-label="Neighborhood depth">
        <button id="hm" title="Fewer hops" aria-label="Fewer hops">−</button>
        <span id="hops">1 hop</span>
        <button id="hp" title="More hops" aria-label="More hops">+</button>
      </span>
      <span class="meta" id="meta" aria-live="polite"></span>
    </header>
    <main>
      <section class="view" id="v-graph" role="tabpanel" aria-labelledby="tab-graph">
        <div id="graphWrap">
          <div id="svgBox"><svg id="svg" role="img" aria-label="Code graph around the current symbol"><g id="gE"></g><g id="gN"></g></svg></div>
          <div id="debugList" hidden></div>
          <div class="legend" aria-label="Legend">
            <span><i class="swatch intent"></i>carries an assumption</span>
            <span><i class="swatch plain"></i>no recorded intent</span>
            <span><i class="swatch unres"></i>? unresolved (dynamic, DI, event bus, ORM, cross-service)</span>
            <span>▤ module · ◼ class · ƒ function · ▦ data · ⧉ external</span>
          </div>
        </div>
      </section>
      <section class="view" id="v-tree" role="tabpanel" aria-labelledby="tab-tree"><div id="treeView"></div></section>
    </main>`;

  const $ = (id) => document.getElementById(id);
  const svg = $('svg'), gN = $('gN'), gE = $('gE');

  /* ---------------------------------------------------------------- tabs */
  function setMode(m, notify) {
    state.mode = m;
    vscode.setState({ mode: m });
    document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
    $('v-graph').classList.toggle('active', m !== 'tree');
    $('v-tree').classList.toggle('active', m === 'tree');
    $('debugList').hidden = m !== 'debug';
    $('hopctl').hidden = m === 'tree';
    renderDebug();
    if (notify) vscode.postMessage({ type: 'mode', mode: m });
    if (m !== 'tree') requestAnimationFrame(render);
  }
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode, true)));
  $('hm').onclick = () => vscode.postMessage({ type: 'hops', value: state.hops - 1 });
  $('hp').onclick = () => vscode.postMessage({ type: 'hops', value: state.hops + 1 });

  /* ---------------------------------------------------------------- graph model (deltas only) */
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }

  function applyDelta(m) {
    if (m.reset) { state.nodes.clear(); state.edges.clear(); state.pos.clear(); gN.replaceChildren(); gE.replaceChildren(); state.els.clear(); state.edgeEls.clear(); state.fitted = false; }
    for (const id of m.nodes.remove) { state.nodes.delete(id); state.pos.delete(id); const el = state.els.get(id); if (el) el.remove(); state.els.delete(id); }
    for (const k of m.edges.remove) { state.edges.delete(k); const el = state.edgeEls.get(k); if (el) el.remove(); state.edgeEls.delete(k); }
    const fresh = [];
    for (const n of m.nodes.upsert) {
      if (!state.nodes.has(n.id)) fresh.push(n.id);
      state.nodes.set(n.id, n);
      const el = state.els.get(n.id); if (el) { el.remove(); state.els.delete(n.id); } // restyle on change
    }
    for (const e of m.edges.add) state.edges.set(e.from + '|' + e.kind + '|' + e.to, e);
    // seed new nodes beside a connected, already placed neighbor so geometry stays stable
    for (const id of fresh) {
      let anchor = null;
      for (const e of state.edges.values()) { const o = e.from === id ? e.to : e.to === id ? e.from : null; if (o && state.pos.has(o)) { anchor = state.pos.get(o); break; } }
      const a = hash(id) * Math.PI * 2, r = 50 + hash(id + 'r') * 60;
      state.pos.set(id, { x: (anchor ? anchor.x : 0) + Math.cos(a) * r, y: (anchor ? anchor.y : 0) + Math.sin(a) * r, vx: 0, vy: 0, fresh: true });
    }
    state.total = m.total; state.shown = m.shown; if (m.hops != null) { state.hops = m.hops; }
    if (m.focus !== undefined) state.focus = m.focus;
    $('hops').textContent = state.hops + (state.hops === 1 ? ' hop' : ' hops');
    kick(fresh.length ? 140 : 40);
  }

  /* ---------------------------------------------------------------- layout: incremental force simulation, chunked so it never hogs a frame */
  function kick(ticks) { state.simTicks = Math.max(state.simTicks, ticks); if (!state.raf) state.raf = requestAnimationFrame(frame); }

  function step(alpha) {
    const ids = [...state.pos.keys()];
    const n = ids.length;
    const P = ids.map((id) => state.pos.get(id));
    const idx = new Map(ids.map((id, i) => [id, i]));
    for (let i = 0; i < n; i++) {
      const a = P[i];
      for (let j = i + 1; j < n; j++) {
        const b = P[j];
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 0.01;
        if (d2 > 160000) continue;
        const f = 6200 / d2, d = Math.sqrt(d2);
        dx = (dx / d) * f; dy = (dy / d) * f;
        a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy;
      }
    }
    for (const e of state.edges.values()) {
      const ia = idx.get(e.from), ib = idx.get(e.to);
      if (ia === undefined || ib === undefined) continue;
      const a = P[ia], b = P[ib];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = (d - 125) * 0.03;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    for (const p of P) {
      p.vx -= p.x * 0.004; p.vy -= p.y * 0.004;
      const m = p.fresh ? 1 : 0.12; // settled nodes barely move: the picture stays recognizable
      p.x += Math.max(-12, Math.min(12, p.vx * alpha * m)); p.y += Math.max(-12, Math.min(12, p.vy * alpha * m));
      p.vx *= 0.55; p.vy *= 0.55;
    }
  }

  function frame() {
    state.raf = 0;
    const per = state.pos.size > 250 ? 3 : 8;
    for (let i = 0; i < per && state.simTicks > 0; i++, state.simTicks--) step(Math.max(0.15, state.simTicks / 140));
    if (state.simTicks <= 0) for (const p of state.pos.values()) p.fresh = false;
    if (!state.fitted && state.simTicks < 60 && state.pos.size) fit();
    render();
    if (state.simTicks > 0) state.raf = requestAnimationFrame(frame);
  }

  function fit() {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const p of state.pos.values()) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const box = svg.getBoundingClientRect(), ar = (box.width || 600) / (box.height || 400);
    let w = Math.max(240, x1 - x0 + 160), h = Math.max(160, y1 - y0 + 100);
    if (w / h < ar) w = h * ar; else h = w / ar;
    state.view = { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h };
    state.fitted = true;
  }

  /* ---------------------------------------------------------------- render (culls off-screen nodes above 300) */
  function shapeFor(n, w, h) {
    let s;
    if (n.type === 'class') { s = document.createElementNS(NS, 'rect'); s.setAttribute('rx', 2); }
    else if (n.type === 'function') { s = document.createElementNS(NS, 'rect'); s.setAttribute('rx', h / 2); }
    else if (n.type === 'data') { s = document.createElementNS(NS, 'polygon'); s.setAttribute('points', `${-w / 2 + 8},${-h / 2} ${w / 2 - 8},${-h / 2} ${w / 2},0 ${w / 2 - 8},${h / 2} ${-w / 2 + 8},${h / 2} ${-w / 2},0`); return s; }
    else { s = document.createElementNS(NS, 'rect'); s.setAttribute('rx', n.type === 'module' ? 6 : 3); }
    s.setAttribute('x', -w / 2); s.setAttribute('y', -h / 2); s.setAttribute('width', w); s.setAttribute('height', h);
    return s;
  }

  function nodeEl(n) {
    const g = document.createElementNS(NS, 'g');
    const label = (GLYPH[n.type] || '') + ' ' + (n.label.length > 30 ? n.label.slice(0, 29) + '…' : n.label);
    const w = Math.min(230, Math.max(70, label.length * 6.4 + 16)), h = 24;
    g.setAttribute('class', ['node', n.type, n.intent ? 'intent' : '', !n.resolved ? 'unresolved' : '', n.band ? 'band-' + n.band : ''].join(' '));
    g.setAttribute('tabindex', '0'); g.setAttribute('role', 'button');
    const bandText = n.band ? ` — ${BAND[n.band].text} suspect` : '';
    g.setAttribute('aria-label', `${n.type} ${n.label}${n.intent ? ', carries an assumption' : ''}${!n.resolved ? ', unresolved' : ''}${bandText}`);
    const t = document.createElementNS(NS, 'title');
    t.textContent = `${n.id}\n${n.type}${n.reason ? ' (' + n.reason + ')' : ''}${n.intent ? '\n' + n.intent + ' subtask(s) with assumptions' : ''}${n.band ? '\n' + BAND[n.band].text + ': ' + n.tasks.join(', ') : ''}`;
    g.appendChild(t);
    const s = shapeFor(n, w, h); s.setAttribute('class', 'shape'); g.appendChild(s);
    const tx = document.createElementNS(NS, 'text'); tx.setAttribute('class', 'name'); tx.setAttribute('text-anchor', 'middle'); tx.setAttribute('dy', '0.35em'); tx.textContent = label; g.appendChild(tx);
    let yy = h / 2 + 11;
    if (n.band) { const b = document.createElementNS(NS, 'text'); b.setAttribute('class', 'tag'); b.setAttribute('text-anchor', 'middle'); b.setAttribute('y', yy); b.textContent = `${BAND[n.band].glyph} ${BAND[n.band].text}`; g.appendChild(b); yy += 11; }
    if (!n.resolved) { const b = document.createElementNS(NS, 'text'); b.setAttribute('class', 'tag'); b.setAttribute('text-anchor', 'middle'); b.setAttribute('y', yy); b.textContent = `unresolved${n.reason ? ': ' + n.reason : ''}`; g.appendChild(b); }
    g.addEventListener('click', () => vscode.postMessage({ type: 'select', id: n.id }));
    g.addEventListener('dblclick', () => vscode.postMessage({ type: 'recenter', id: n.id }));
    g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); vscode.postMessage({ type: 'select', id: n.id }); } });
    return g;
  }

  function render() {
    const v = state.view;
    svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    const cull = state.nodes.size > 300;
    const m = 120;
    const vis = (p) => !cull || (p.x > v.x - m && p.x < v.x + v.w + m && p.y > v.y - m && p.y < v.y + v.h + m);
    const shown = new Set();
    for (const [id, n] of state.nodes) {
      const p = state.pos.get(id); if (!p) continue;
      let el = state.els.get(id);
      if (!vis(p)) { if (el) el.style.display = 'none'; continue; }
      shown.add(id);
      if (!el) { el = nodeEl(n); state.els.set(id, el); gN.appendChild(el); }
      el.style.display = '';
      el.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
      el.classList.toggle('focus', id === state.focus);
    }
    for (const [k, e] of state.edges) {
      const a = state.pos.get(e.from), b = state.pos.get(e.to);
      let el = state.edgeEls.get(k);
      if (!a || !b || !(shown.has(e.from) || shown.has(e.to))) { if (el) el.style.display = 'none'; continue; }
      if (!el) { el = document.createElementNS(NS, 'path'); el.setAttribute('class', `edge ${e.kind}${e.resolved ? '' : ' unres'}`); const t = document.createElementNS(NS, 'title'); t.textContent = `${e.kind}${e.resolved ? '' : ' (unresolved: static analysis guessed)'}`; el.appendChild(t); state.edgeEls.set(k, el); gE.appendChild(el); }
      el.style.display = '';
      el.setAttribute('d', `M${a.x.toFixed(1)},${a.y.toFixed(1)}L${b.x.toFixed(1)},${b.y.toFixed(1)}`);
    }
    reportRendered(shown.size);
    $('meta').textContent = `${state.shown} of ${state.total} nodes${state.total > state.shown ? ' (raise hops carefully; capped)' : ''}${cull ? ` · ${shown.size} drawn` : ''}`;
  }

  let rt = 0;
  function reportRendered(drawn) {
    clearTimeout(rt);
    rt = setTimeout(() => vscode.postMessage({ type: 'rendered', nodes: state.nodes.size, drawn, lit: [...state.nodes.values()].filter((n) => n.band).map((n) => n.id + '=' + n.band), focus: state.focus, mode: state.mode, treeTasks: document.querySelectorAll('#treeView .task').length, debugCards: document.querySelectorAll('#debugList .card').length }), 120);
  }

  function centerOn(id) {
    const p = state.pos.get(id); if (!p) return;
    const v = state.view;
    if (p.x < v.x + 40 || p.x > v.x + v.w - 40 || p.y < v.y + 30 || p.y > v.y + v.h - 30) { v.x = p.x - v.w / 2; v.y = p.y - v.h / 2; }
  }

  /* pan + zoom */
  let drag = null;
  svg.addEventListener('mousedown', (e) => { if (e.target.closest('.node')) return; drag = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y }; svg.style.cursor = 'grabbing'; });
  window.addEventListener('mouseup', () => { drag = null; svg.style.cursor = ''; });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const r = svg.getBoundingClientRect();
    state.view.x = drag.vx - ((e.clientX - drag.x) * state.view.w) / r.width; state.view.y = drag.vy - ((e.clientY - drag.y) * state.view.h) / r.height;
    requestAnimationFrame(render);
  });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect(), v = state.view, k = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    const mx = v.x + ((e.clientX - r.left) / r.width) * v.w, my = v.y + ((e.clientY - r.top) / r.height) * v.h;
    v.x = mx - (mx - v.x) * k; v.y = my - (my - v.y) * k; v.w *= k; v.h *= k;
    requestAnimationFrame(render);
  }, { passive: false });
  new ResizeObserver(() => { if (!state.fitted) fit(); render(); }).observe($('svgBox'));

  /* ---------------------------------------------------------------- tree */
  const h = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function renderTree() {
    const t = state.tree, el = $('treeView');
    if (t && t.gate && t.gate.pending) { el.innerHTML = '<div class="empty">Prompt received. Waiting for the agent to decompose the task…</div>'; return; }
    if (!t || !t.features.length) { el.innerHTML = '<div class="empty">No plan yet. Send a prompt; the agent decomposes it here.</div>'; return; }
    const cur = t.gate && t.gate.current;
    let out = '';
    for (const f of t.features) {
      out += '<div class="feat"><b>' + h(f.feature) + '</b></div>';
      for (const k of f.tasks) {
        const act = '<span class="row-actions"><button data-act="edit" data-id="' + k.id + '" data-title="' + h(k.title) + '" aria-label="Rename ' + k.id + '" title="Rename">✎</button><button data-act="rm" data-id="' + k.id + '" aria-label="Remove ' + k.id + '" title="Remove from plan">×</button></span>';
        const head = act + '<span class="chip ' + k.status + '">' + k.status + '</span><b>' + k.id + '</b> ' + h(k.title);
        if (k.id === cur) {
          out += '<div class="task now">' + head;
          for (const n of k.nodes) out += '<div class="sym">' + h(n.target) + (n.note ? ' <span class="dim">' + h(n.note) + '</span>' : '') + '</div>';
          out += t.gate.approved
            ? '<div class="dim">Approved. Agent is implementing this one.</div>'
            : '<div class="actions"><button class="primary" data-act="approve" data-id="' + k.id + '">Approve ' + k.id + '</button></div>';
          out += '</div>';
        } else if (k.status === 'planned') {
          out += '<div class="task">' + head + '</div>';
        } else {
          out += '<details class="task"><summary>' + head + '</summary>';
          for (const n of k.nodes) out += '<div class="sym">' + h(n.target) + (n.note ? ' <span class="dim">' + h(n.note) + '</span>' : '') + '</div>';
          for (const x of k.assumes) out += '<div class="assume">' + h(x) + '</div>';
          const dec = [k.chose && 'chose: ' + k.chose, k.rejected && 'rejected: ' + k.rejected, k.why && 'why: ' + k.why].filter(Boolean);
          if (dec.length) out += '<div class="dim">' + h(dec.join(' · ')) + '</div>';
          for (const sy of k.symbols) out += '<div class="sym"><a data-act="sel" data-id="' + h(sy.id) + '" tabindex="0" role="link">' + h(sy.id.slice(sy.id.indexOf(':') + 1) || sy.id) + '</a>' + (sy.state === 'missing' ? ' <span class="bad">missing</span>' : '') + (sy.drifted ? ' <span class="warn">changed since recorded</span>' : '') + '</div>';
          out += '</details>';
        }
      }
    }
    el.innerHTML = out;
  }
  $('treeView').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'sel') vscode.postMessage({ type: 'select', id: b.dataset.id });
    else if (a === 'approve') vscode.postMessage({ type: 'approve', id: b.dataset.id });
    else if (a === 'rm') vscode.postMessage({ type: 'removeTask', id: b.dataset.id });
    else if (a === 'rmf') vscode.postMessage({ type: 'removeFeature', feature: b.dataset.f });
    else if (a === 'edit') vscode.postMessage({ type: 'editTask', id: b.dataset.id, title: b.dataset.title });
    if (a !== 'sel') e.preventDefault();
  });
  $('treeView').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset && e.target.dataset.act === 'sel') vscode.postMessage({ type: 'select', id: e.target.dataset.id }); });

  /* ---------------------------------------------------------------- debug */
  function card(e, band) {
    const chk = state.debug.checked[e.id];
    const symbols = e.symbols.map((s) => `<a data-act="sel" data-id="${h(s)}" tabindex="0" role="link">${h(s.slice(s.indexOf(':') + 1))}</a>`).join(', ');
    return `<div class="card ${band}"><div><span class="band-label">${BAND[band].glyph} ${BAND[band].text}</span><b>${e.id}</b> ${h(e.title)} <span class="dim">score ${e.score}</span>${chk ? ` <span class="badge-checked">· you marked it ${chk}</span>` : ''}</div>
      ${e.assumes.map((a) => `<div class="assume">${h(a)}</div>`).join('')}
      <ul>${e.reasons.map((r) => `<li>${h(r)}</li>`).join('')}</ul>
      <div class="dim">${symbols}</div>
      <div class="actions"><button class="primary" data-chk="confirmed" data-id="${e.id}">Check: this was the cause</button><button data-chk="cleared" data-id="${e.id}">Check: ruled out</button></div></div>`;
  }
  function renderDebug() {
    const el = $('debugList');
    if (state.mode !== 'debug') return;
    if (!state.debug) { el.innerHTML = '<div class="empty">No symptom yet. Run <b>GateKeeper: Rank Suspects for Symptom…</b>, or fail a test in the terminal and accept the prompt.</div>'; return; }
    const d = state.debug;
    let out = `<div class="dim">Symptom terms: ${h(d.terms.join(', ') || 'none')} · named symbols: ${h(d.named_symbols.map((s) => s.slice(s.indexOf(':') + 1)).join(', ') || 'none')}</div>`;
    out += d.suspects.map((e) => card(e, 'likely')).join('') || '<div class="dim">No record has structural or lexical evidence. Check the possible band.</div>';
    out += d.also_considered.map((e) => card(e, 'possible')).join('');
    if (d.cleared.length) out += `<div class="card cleared"><span class="band-label">✓ cleared</span> ${d.cleared.map(h).join(', ')} <span class="dim">(dimmed in the graph, never hidden)</span></div>`;
    el.innerHTML = out;
  }
  $('debugList').addEventListener('click', (e) => {
    const c = e.target.closest('[data-chk]');
    if (c) return vscode.postMessage({ type: 'check', id: c.dataset.id, result: c.dataset.chk });
    const s = e.target.closest('[data-act="sel"]'); if (s) vscode.postMessage({ type: 'select', id: s.dataset.id });
  });

  /* ---------------------------------------------------------------- host messages */
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'delta': applyDelta(m); requestAnimationFrame(() => { if (state.focus) centerOn(state.focus); render(); }); break;
      case 'focus': state.focus = m.id; centerOn(m.id); render(); break;
      case 'tree': state.tree = m.tree; renderTree(); reportRendered(state.els.size); break;
      case 'debug': state.debug = m.debug; renderDebug(); reportRendered(state.els.size); break;
      case 'mode': setMode(m.mode, false); break;
    }
  });

  setMode(state.mode, false);
  vscode.postMessage({ type: 'ready' });
})();

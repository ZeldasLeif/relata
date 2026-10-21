(() => {
  'use strict';

  const CFG = window.RELATA_CONFIG;
  const TYPES = CFG.types;
  const TYPE_MAP = new Map(TYPES.map(t => [t.key, t]));
  const NODE_W = CFG.nodeWidth;
  const EDGE_ZONE = 8;          // px inside the card border that start a connection
  const DRAG_THRESHOLD = 4;     // px before a press becomes a drag
  const MIN_SCALE = 0.12, MAX_SCALE = 2.5;
  const FALLBACK_COLOR = '#9a9286';
  const SVGNS = 'http://www.w3.org/2000/svg';

  const $ = s => document.querySelector(s);
  const viewport = $('#viewport');
  const world = $('#world');
  const edgeGroup = $('#edge-group');
  const tempLine = $('#temp-line');
  const labelsLayer = $('#labels');
  const nodesLayer = $('#nodes');
  const nodeTpl = $('#node-tpl');
  const menuEl = $('#menu');
  const fmtEl = $('#fmt');
  const legendEl = $('#legend');
  const searchEl = $('#search');
  const statusEl = $('#status');
  const zoomLabel = $('#zoom-reset');
  const toastEl = $('#toast');
  const helpEl = $('#help');
  const filterHint = $('#filter-hint');
  const emptyHint = $('#empty-hint');
  const importInput = $('#file-import');
  const imageInput = $('#file-image');
  document.documentElement.style.setProperty('--node-w', NODE_W + 'px');

  // ---------- state ----------

  const nodes = new Map();    // id -> {id, type, title, kind, body, image, x, y}
  const edges = new Map();    // id -> {id, a, b, label}
  const adj = new Map();      // nodeId -> Set(edgeId)
  const nodeEls = new Map();  // nodeId -> {root, label, title, body, text, h}
  const edgeEls = new Map();  // edgeId -> {g, hit, line, label}
  const view = { x: 0, y: 0, s: 1 };
  const filter = { type: null, query: '' };
  let selected = null;        // {kind: 'node'|'edge', id}
  let gesture = null;
  let blockNative = false;
  let spaceDown = false;
  let zTop = 1;
  let editSession = null;

  const uid = () => Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 8);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const typeColor = key => (TYPE_MAP.get(key) || {}).color || FALLBACK_COLOR;
  const isEditable = el => !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  const toWorld = (cx, cy) => ({ x: (cx - view.x) / view.s, y: (cy - view.y) / view.s });

  // ---------- frame batching ----------

  const dirtyPos = new Set();
  const dirtyEdgesOf = new Set();
  let viewDirty = false;
  let frameReq = 0;

  function requestFrame() {
    if (!frameReq) frameReq = requestAnimationFrame(flush);
  }

  function flush() {
    frameReq = 0;
    if (viewDirty) { viewDirty = false; renderView(); }
    for (const id of dirtyPos) {
      const n = nodes.get(id), el = nodeEls.get(id);
      if (n && el) el.root.style.transform = `translate(${n.x}px,${n.y}px)`;
    }
    for (const id of dirtyEdgesOf) {
      const set = adj.get(id);
      if (set) for (const eid of set) drawEdge(eid);
    }
    dirtyPos.clear();
    dirtyEdgesOf.clear();
  }

  function markMoved(id) {
    dirtyPos.add(id);
    dirtyEdgesOf.add(id);
    requestFrame();
  }

  // ---------- view ----------

  let settleTimer = 0;
  let viewAnim = 0;

  function setView(x, y, s) {
    view.x = x; view.y = y; view.s = s;
    viewDirty = true;
    requestFrame();
    world.classList.add('moving');
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => world.classList.remove('moving'), 180);
  }

  function renderView() {
    world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.s})`;
    let step = 24;
    while (step * view.s < 14) step *= 2;
    const g = step * view.s;
    viewport.style.backgroundSize = `${g}px ${g}px`;
    viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
    zoomLabel.textContent = Math.round(view.s * 100) + '%';
  }

  function animateView(tx, ty, ts) {
    cancelAnimationFrame(viewAnim);
    const fx = view.x, fy = view.y, fs = view.s, t0 = performance.now(), dur = 320;
    const step = now => {
      const t = Math.min(1, (now - t0) / dur);
      const k = 1 - Math.pow(1 - t, 3);
      setView(fx + (tx - fx) * k, fy + (ty - fy) * k, fs + (ts - fs) * k);
      if (t < 1) viewAnim = requestAnimationFrame(step);
    };
    viewAnim = requestAnimationFrame(step);
  }

  function zoomAt(cx, cy, ns) {
    cancelAnimationFrame(viewAnim);
    ns = clamp(ns, MIN_SCALE, MAX_SCALE);
    const w = toWorld(cx, cy);
    setView(cx - w.x * ns, cy - w.y * ns, ns);
  }

  function nodeHeight(id) {
    const el = nodeEls.get(id);
    if (!el) return 0;
    if (!el.h) el.h = el.root.offsetHeight;
    return el.h || 110;
  }

  function center(id) {
    const n = nodes.get(id);
    return { x: n.x + NODE_W / 2, y: n.y + nodeHeight(id) / 2 };
  }

  function centerOn(id, s = view.s, animate = true) {
    const c = center(id);
    const tx = innerWidth / 2 - c.x * s, ty = innerHeight / 2 - c.y * s;
    animate ? animateView(tx, ty, s) : setView(tx, ty, s);
  }

  function centerFirst(animate = true) {
    const first = nodes.keys().next().value;
    if (first) centerOn(first, 1, animate);
    else animate ? animateView(innerWidth / 2, innerHeight / 2, 1) : setView(innerWidth / 2, innerHeight / 2, 1);
  }

  function fitView() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes.values()) {
      if (n._vis === false) continue;
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + NODE_W); y1 = Math.max(y1, n.y + nodeHeight(n.id));
    }
    if (x0 === Infinity) return;
    const pad = 90;
    const s = clamp(Math.min(innerWidth / (x1 - x0 + pad * 2), innerHeight / (y1 - y0 + pad * 2)), MIN_SCALE, 1);
    animateView(innerWidth / 2 - (x0 + x1) / 2 * s, innerHeight / 2 - (y0 + y1) / 2 * s, s);
  }

  // ---------- nodes ----------

  function makeNode(d) {
    const n = {
      id: typeof d.id === 'string' && d.id ? d.id : uid(),
      type: typeof d.type === 'string' && d.type.trim() ? d.type.trim().toUpperCase().slice(0, 40) : CFG.defaultType,
      title: typeof d.title === 'string' ? d.title.replace(/[\r\n\t]+/g, ' ').slice(0, 1000) : '',
      kind: d.kind === 'image' ? 'image' : 'text',
      body: typeof d.body === 'string' ? Sanitize.rich(d.body) : '',
      image: typeof d.image === 'string' && /^data:image\//.test(d.image) ? d.image : '',
      x: Number.isFinite(+d.x) ? +d.x : 0,
      y: Number.isFinite(+d.y) ? +d.y : 0,
    };
    if (n.kind === 'image' && !n.image) n.kind = 'text';
    if (n.kind === 'text') n.image = '';
    return n;
  }

  const ro = new ResizeObserver(entries => {
    for (const en of entries) {
      const id = en.target.dataset.id;
      const el = nodeEls.get(id);
      if (!el) continue;
      const box = en.borderBoxSize && en.borderBoxSize[0];
      const h = box ? box.blockSize : en.target.offsetHeight;
      if (h && h !== el.h) { el.h = h; dirtyEdgesOf.add(id); }
    }
    requestFrame();
  });

  function mountNode(n, parent = nodesLayer) {
    const root = nodeTpl.content.firstElementChild.cloneNode(true);
    root.dataset.id = n.id;
    const el = {
      root,
      label: root.querySelector('.type-label'),
      title: root.querySelector('.title'),
      body: root.querySelector('.body'),
      text: null,
      h: 0,
    };
    el.title.textContent = n.title;
    root.style.transform = `translate(${n.x}px,${n.y}px)`;
    nodeEls.set(n.id, el);
    paintType(n);
    paintBody(n);
    parent.appendChild(root);
    ro.observe(root);
    return el;
  }

  function paintType(n) {
    const el = nodeEls.get(n.id);
    el.root.style.setProperty('--tc', typeColor(n.type));
    el.label.textContent = n.type;
  }

  function paintBody(n) {
    const el = nodeEls.get(n.id);
    el.body.textContent = '';
    el.text = null;
    el.root.classList.toggle('is-image', n.kind === 'image');
    if (n.kind === 'image') {
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      img.src = n.image;
      el.body.appendChild(img);
    } else {
      const t = document.createElement('div');
      t.className = 'text';
      t.contentEditable = 'true';
      t.spellcheck = true;
      t.dataset.placeholder = 'Write…';
      t.innerHTML = n.body;
      el.body.appendChild(t);
      el.text = t;
    }
  }

  function insertNode(n) {
    if (nodes.has(n.id)) n.id = uid();
    nodes.set(n.id, n);
    adj.set(n.id, new Set());
    mountNode(n);
    return n;
  }

  // Creates a node as a user action (caller records history first).
  function createNode(props) {
    const n = insertNode(makeNode(props));
    if (filter.query) { filter.query = ''; searchEl.value = ''; }
    applyFilter();
    refreshCounts();
    scheduleSave();
    return n;
  }

  function removeNode(id) {
    for (const eid of [...(adj.get(id) || [])]) removeEdge(eid);
    const el = nodeEls.get(id);
    if (el) { ro.unobserve(el.root); el.root.remove(); }
    if (selected && selected.kind === 'node' && selected.id === id) selected = null;
    if (editSession && editSession.id === id) editSession = null;
    nodes.delete(id);
    nodeEls.delete(id);
    adj.delete(id);
  }

  function bringToFront(id) {
    const el = nodeEls.get(id);
    if (el) el.root.style.zIndex = ++zTop;
  }

  // ---------- edges ----------

  function makeEdge(a, b, label, id) {
    return {
      id: typeof id === 'string' && id && !edges.has(id) ? id : uid(),
      a: String(a), b: String(b),
      label: typeof label === 'string' ? label.replace(/\s+/g, ' ').trim().slice(0, 200) : '',
    };
  }

  function findEdge(a, b) {
    for (const eid of adj.get(a) || []) {
      const e = edges.get(eid);
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return e;
    }
    return null;
  }

  function insertEdge(e) {
    if (!nodes.has(e.a) || !nodes.has(e.b) || e.a === e.b || findEdge(e.a, e.b)) return null;
    edges.set(e.id, e);
    adj.get(e.a).add(e.id);
    adj.get(e.b).add(e.id);
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'edge-g');
    g.dataset.id = e.id;
    const hit = document.createElementNS(SVGNS, 'line');
    hit.setAttribute('class', 'edge-hit');
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('class', 'edge');
    g.append(hit, line);
    edgeGroup.appendChild(g);
    edgeEls.set(e.id, { g, hit, line, label: null });
    if (e.label) ensureLabel(e);
    drawEdge(e.id);
    return e;
  }

  function removeEdge(eid) {
    const e = edges.get(eid), ee = edgeEls.get(eid);
    if (!e) return;
    adj.get(e.a)?.delete(eid);
    adj.get(e.b)?.delete(eid);
    if (ee) { ee.g.remove(); ee.label?.remove(); }
    edges.delete(eid);
    edgeEls.delete(eid);
    if (selected && selected.kind === 'edge' && selected.id === eid) selected = null;
  }

  function drawEdge(eid) {
    const e = edges.get(eid), ee = edgeEls.get(eid);
    if (!e || !ee) return;
    const p = center(e.a), q = center(e.b);
    for (const l of [ee.hit, ee.line]) {
      l.setAttribute('x1', p.x); l.setAttribute('y1', p.y);
      l.setAttribute('x2', q.x); l.setAttribute('y2', q.y);
    }
    if (ee.label) {
      ee.label.style.transform = `translate(${(p.x + q.x) / 2}px,${(p.y + q.y) / 2}px) translate(-50%,-50%)`;
    }
  }

  function ensureLabel(e) {
    const ee = edgeEls.get(e.id);
    if (ee.label) return ee.label;
    const l = document.createElement('div');
    l.className = 'edge-label';
    l.dataset.id = e.id;
    l.textContent = e.label;
    if (edges.has(e.id) && ee.g.classList.contains('is-hidden')) l.classList.add('is-hidden');
    labelsLayer.appendChild(l);
    ee.label = l;
    return l;
  }

  function editEdgeLabel(eid) {
    const e = edges.get(eid);
    if (!e) return;
    const l = ensureLabel(e);
    drawEdge(eid);
    select({ kind: 'edge', id: eid });
    const snap = snapshot();
    const before = e.label;
    l.contentEditable = 'true';
    l.spellcheck = false;
    l.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(l);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);

    const finish = commit => {
      l.removeEventListener('blur', onBlur);
      l.removeEventListener('keydown', onKey);
      l.contentEditable = 'false';
      const val = commit ? l.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) : before;
      l.textContent = val;
      if (val !== before) {
        pushHistory(snap);
        e.label = val;
        scheduleSave();
      }
      if (!val) {
        l.remove();
        const ee = edgeEls.get(eid);
        if (ee) ee.label = null;
      }
    };
    const onBlur = () => finish(true);
    const onKey = ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); l.blur(); }
      else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
        l.blur();
      }
    };
    l.addEventListener('blur', onBlur);
    l.addEventListener('keydown', onKey);
  }

  // ---------- selection ----------

  function selectedEls(sel) {
    if (!sel) return [];
    if (sel.kind === 'node') return [nodeEls.get(sel.id)?.root];
    const ee = edgeEls.get(sel.id);
    return ee ? [ee.g, ee.label] : [];
  }

  function select(sel) {
    for (const el of selectedEls(selected)) el?.classList.remove('selected');
    selected = sel;
    for (const el of selectedEls(selected)) el?.classList.add('selected');
    if (sel && sel.kind === 'node') bringToFront(sel.id);
  }

  // ---------- history ----------

  const history = [];
  const future = [];

  function snapshot() {
    return {
      nodes: [...nodes.values()].map(n => ({ ...n })),
      edges: [...edges.values()].map(e => ({ ...e })),
    };
  }

  function pushHistory(snap = snapshot()) {
    history.push(snap);
    if (history.length > 100) history.shift();
    future.length = 0;
  }

  function restore(snap) {
    loadData(snap);
    scheduleSave();
  }

  function undo() {
    if (!history.length) return toast('Nothing to undo');
    future.push(snapshot());
    restore(history.pop());
  }

  function redo() {
    if (!future.length) return toast('Nothing to redo');
    history.push(snapshot());
    restore(future.pop());
  }

  // ---------- load / save ----------

  function loadData(data) {
    ro.disconnect();
    nodesLayer.textContent = '';
    edgeGroup.textContent = '';
    labelsLayer.textContent = '';
    nodes.clear(); edges.clear(); adj.clear(); nodeEls.clear(); edgeEls.clear();
    selected = null;
    editSession = null;
    const frag = document.createDocumentFragment();
    for (const d of Array.isArray(data && data.nodes) ? data.nodes : []) {
      if (!d || typeof d !== 'object') continue;
      const n = makeNode(d);
      if (nodes.has(n.id)) n.id = uid();
      nodes.set(n.id, n);
      adj.set(n.id, new Set());
      mountNode(n, frag);
    }
    nodesLayer.appendChild(frag);
    for (const d of Array.isArray(data && data.edges) ? data.edges : []) {
      if (!d || typeof d !== 'object') continue;
      insertEdge(makeEdge(d.a, d.b, d.label, d.id));
    }
    applyFilter();
    refreshCounts();
  }

  function serialize() {
    return {
      app: 'relata',
      version: 1,
      savedAt: new Date().toISOString(),
      nodes: [...nodes.values()].map(n => ({
        id: n.id, type: n.type, title: n.title, kind: n.kind,
        body: n.body, image: n.kind === 'image' ? n.image : '',
        x: Math.round(n.x), y: Math.round(n.y),
      })),
      edges: [...edges.values()].map(e => ({ id: e.id, a: e.a, b: e.b, label: e.label })),
    };
  }

  let saveTimer = 0;
  let saveState = 'saved';

  function scheduleSave() {
    setSaveState('pending');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    return RelataStore.save(serialize())
      .then(() => { if (!saveTimer) setSaveState('saved'); })
      .catch(err => {
        console.error(err);
        setSaveState('error');
        toast('Could not save locally — please export a backup.');
      });
  }

  function setSaveState(s) {
    saveState = s;
    renderStatus();
  }

  function renderStatus() {
    const words = { saved: 'saved', pending: 'saving…', error: 'not saved' };
    statusEl.className = 'ui ' + saveState;
    statusEl.innerHTML = `${nodes.size} node${nodes.size === 1 ? '' : 's'} · ${edges.size} connection${edges.size === 1 ? '' : 's'}<span class="dot"></span>${words[saveState]}`;
  }

  const flushPending = () => { if (saveTimer) saveNow(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPending(); });
  window.addEventListener('pagehide', flushPending);
  window.addEventListener('beforeunload', flushPending);

  // ---------- filter & legend ----------

  function plainOf(n) {
    if (n._plainSrc !== n.body) {
      n._plain = Sanitize.plain(n.body).toLowerCase();
      n._plainSrc = n.body;
    }
    return n._plain;
  }

  function applyFilter() {
    const q = filter.query.trim().toLowerCase();
    const active = !!(filter.type || q);
    for (const n of nodes.values()) {
      const vis = (!filter.type || n.type === filter.type) &&
        (!q || n.title.toLowerCase().includes(q) || plainOf(n).includes(q));
      n._vis = vis;
      const el = nodeEls.get(n.id);
      el.root.classList.toggle('is-hidden', !vis);
      el.root.classList.toggle('is-highlight', active && vis);
    }
    for (const e of edges.values()) {
      const hide = !(nodes.get(e.a)._vis && nodes.get(e.b)._vis);
      const ee = edgeEls.get(e.id);
      ee.g.classList.toggle('is-hidden', hide);
      ee.label?.classList.toggle('is-hidden', hide);
    }
    document.body.classList.toggle('filtering', active);
    for (const chip of legendEl.children) chip.classList.toggle('active', chip.dataset.type === filter.type);
    if (active) {
      const count = [...nodes.values()].filter(n => n._vis).length;
      const parts = [];
      if (filter.type) parts.push(`<b>${escapeHtml(filter.type)}</b>`);
      if (q) parts.push(`“${escapeHtml(filter.query.trim())}”`);
      filterHint.innerHTML = `Showing ${parts.join(' · ')} — ${count} node${count === 1 ? '' : 's'} · click empty space to show all`;
    }
    filterHint.hidden = !active;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function toggleTypeFilter(type) {
    filter.type = filter.type === type ? null : type;
    applyFilter();
  }

  function clearFilter() {
    filter.type = null;
    filter.query = '';
    searchEl.value = '';
    applyFilter();
  }

  function buildLegend() {
    legendEl.textContent = '';
    for (const t of TYPES) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.type = t.key;
      b.title = `Show only ${t.key.toLowerCase()} nodes`;
      b.style.setProperty('--tc', t.color);
      b.innerHTML = '<span class="dot"></span><span class="name"></span><span class="count"></span>';
      b.querySelector('.name').textContent = t.key;
      legendEl.appendChild(b);
    }
  }

  function refreshCounts() {
    const counts = new Map();
    for (const n of nodes.values()) counts.set(n.type, (counts.get(n.type) || 0) + 1);
    for (const chip of legendEl.children) {
      const c = counts.get(chip.dataset.type) || 0;
      chip.querySelector('.count').textContent = c;
      chip.classList.toggle('empty', !c);
    }
    emptyHint.hidden = nodes.size > 0;
    renderStatus();
  }

  legendEl.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (chip) toggleTypeFilter(chip.dataset.type);
  });

  searchEl.addEventListener('input', () => {
    filter.query = searchEl.value;
    applyFilter();
  });
  searchEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      searchEl.value = '';
      filter.query = '';
      applyFilter();
    } else if (e.key === 'Enter') {
      fitView();
    }
  });

  // ---------- editing helpers ----------

  function blurEditing() {
    const a = document.activeElement;
    if (a && a.isContentEditable) a.blur();
  }

  function placeCaret(range) {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function focusEnd(el) {
    el.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    placeCaret(r);
  }

  function rangeFromPoint(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (!p) return null;
      const r = document.createRange();
      r.setStart(p.offsetNode, p.offset);
      return r;
    }
    return null;
  }

  function focusAt(el, x, y) {
    el.focus({ preventScroll: true });
    const r = rangeFromPoint(x, y);
    if (r && el.contains(r.startContainer)) {
      r.collapse(true);
      placeCaret(r);
    } else {
      focusEnd(el);
    }
  }

  function inEdgeZone(nodeEl, cx, cy) {
    const r = nodeEl.querySelector('.card').getBoundingClientRect();
    const d = Math.min(cx - r.left, r.right - cx, cy - r.top, r.bottom - cy);
    return d < EDGE_ZONE;
  }

  // ---------- pointer interaction ----------

  function listen() {
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function unlisten() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  }

  function startPan(e, bg) {
    cancelAnimationFrame(viewAnim);
    gesture = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false, bg };
    listen();
  }

  viewport.addEventListener('pointerdown', e => {
    blockNative = false;
    hideMenu();
    if (gesture) return;
    const t = e.target;
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      blockNative = true;
      e.preventDefault();
      startPan(e, false);
      return;
    }
    if (e.button !== 0) {
      // Right-click on a field that isn't being edited shouldn't focus it (we show our own menu).
      const ed = t.closest('[contenteditable="true"]');
      if (!ed || ed !== document.activeElement) blockNative = true;
      return;
    }

    const nodeEl = t.closest('.node');
    if (nodeEl) return onNodeDown(e, nodeEl);

    const edgeEl = t.closest('.edge-g, .edge-label');
    if (edgeEl) {
      if (edgeEl.isContentEditable) return;
      blockNative = true;
      blurEditing();
      select({ kind: 'edge', id: edgeEl.dataset.id });
      return;
    }

    blockNative = true;
    blurEditing();
    startPan(e, true);
  });

  // Suppress native focus/selection for presses we handle ourselves.
  viewport.addEventListener('mousedown', e => {
    if (blockNative) e.preventDefault();
    blockNative = false;
  });

  function onNodeDown(e, nodeEl) {
    const id = nodeEl.dataset.id;
    const n = nodes.get(id);
    const t = e.target;

    const pick = t.closest('.type-pick');
    if (pick) {
      blockNative = true;
      blurEditing();
      select({ kind: 'node', id });
      const r = pick.getBoundingClientRect();
      openTypeMenu(id, r.left - 4, r.bottom + 6);
      return;
    }

    if (inEdgeZone(nodeEl, e.clientX, e.clientY)) {
      blockNative = true;
      blurEditing();
      gesture = { kind: 'connect', id, sx: e.clientX, sy: e.clientY, moved: false, target: null };
      listen();
      return;
    }

    const ed = t.closest('[contenteditable="true"]');
    if (ed && ed === document.activeElement) return; // native text editing / selection

    blockNative = true;
    gesture = { kind: 'press', id, t, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, moved: false, snap: null };
    listen();
  }

  function onMove(e) {
    const g = gesture;
    if (!g) return;
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (!g.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      g.moved = true;
      startGesture(g);
    }
    if (g.kind === 'pan') {
      setView(g.vx + dx, g.vy + dy, view.s);
    } else if (g.kind === 'drag') {
      const n = nodes.get(g.id);
      if (!n) return;
      n.x = g.ox + dx / view.s;
      n.y = g.oy + dy / view.s;
      markMoved(g.id);
    } else if (g.kind === 'connect') {
      if (!nodes.has(g.id)) return;
      const c = center(g.id), p = toWorld(e.clientX, e.clientY);
      tempLine.setAttribute('x1', c.x); tempLine.setAttribute('y1', c.y);
      tempLine.setAttribute('x2', p.x); tempLine.setAttribute('y2', p.y);
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      let target = hit && hit.closest('.node');
      if (target && target.dataset.id === g.id) target = null;
      if (target !== g.target) {
        g.target?.classList.remove('drop-target');
        target?.classList.add('drop-target');
        g.target = target;
      }
    }
  }

  function startGesture(g) {
    if (g.kind === 'pan') {
      viewport.classList.add('panning');
    } else if (g.kind === 'press') {
      g.kind = 'drag';
      g.snap = snapshot();
      blurEditing();
      select({ kind: 'node', id: g.id });
      nodeEls.get(g.id)?.root.classList.add('dragging');
    } else if (g.kind === 'connect') {
      tempLine.style.display = '';
      document.body.classList.add('connecting');
    }
  }

  function onUp(e) {
    const g = gesture;
    gesture = null;
    unlisten();
    viewport.classList.remove('panning');
    if (!g) return;
    const cancelled = e.type === 'pointercancel';

    if (g.kind === 'pan') {
      if (!g.moved && g.bg && !cancelled) onBackgroundClick();
    } else if (g.kind === 'drag') {
      nodeEls.get(g.id)?.root.classList.remove('dragging');
      pushHistory(g.snap);
      scheduleSave();
    } else if (g.kind === 'press') {
      if (!cancelled) onNodeClick(g, e);
    } else if (g.kind === 'connect') {
      tempLine.style.display = 'none';
      document.body.classList.remove('connecting');
      g.target?.classList.remove('drop-target');
      if (g.moved && !cancelled) finishConnect(g, e);
      else select({ kind: 'node', id: g.id });
    }
  }

  function onBackgroundClick() {
    if (filter.type || filter.query) clearFilter();
    select(null);
  }

  function onNodeClick(g, e) {
    const id = g.id, n = nodes.get(id), el = nodeEls.get(id);
    if (!n) return;
    select({ kind: 'node', id });
    const t = g.t;
    if (t.closest('.seg.type')) {
      blurEditing();
      toggleTypeFilter(n.type);
    } else if (t.closest('.title')) {
      focusAt(el.title, e.clientX, e.clientY);
    } else if (n.kind === 'text' && t.closest('.body')) {
      focusAt(el.text, e.clientX, e.clientY);
    } else {
      blurEditing();
    }
  }

  function finishConnect(g, e) {
    const src = nodes.get(g.id);
    if (!src) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    if (hit && hit.closest('.ui')) return;
    const targetEl = hit && hit.closest('.node');
    if (targetEl) {
      const tid = targetEl.dataset.id;
      if (tid === g.id) return;
      if (findEdge(g.id, tid)) return toast('Already connected');
      pushHistory();
      insertEdge(makeEdge(g.id, tid));
      applyFilter();
      refreshCounts();
      scheduleSave();
      return;
    }
    pushHistory();
    const p = toWorld(e.clientX, e.clientY);
    const n = createNode({ type: src.type, x: p.x - NODE_W / 2, y: p.y - 20 });
    insertEdge(makeEdge(src.id, n.id));
    applyFilter();
    refreshCounts();
    scheduleSave();
    select({ kind: 'node', id: n.id });
    focusEnd(nodeEls.get(n.id).title);
  }

  // Edge-hover affordance (crosshair + halo).
  let hoverNode = null;
  viewport.addEventListener('pointermove', e => {
    if (gesture) return;
    const nodeEl = e.target.closest && e.target.closest('.node');
    const on = nodeEl && inEdgeZone(nodeEl, e.clientX, e.clientY) ? nodeEl : null;
    if (on !== hoverNode) {
      hoverNode?.classList.remove('edge-hover');
      on?.classList.add('edge-hover');
      hoverNode = on;
    }
  });
  viewport.addEventListener('pointerleave', () => {
    hoverNode?.classList.remove('edge-hover');
    hoverNode = null;
  });

  viewport.addEventListener('dblclick', e => {
    const t = e.target;
    const edgeEl = t.closest('.edge-g, .edge-label');
    if (edgeEl) {
      if (!edgeEl.isContentEditable) editEdgeLabel(edgeEl.dataset.id);
      return;
    }
    if (t.closest('.node')) return;
    pushHistory();
    const p = toWorld(e.clientX, e.clientY);
    const n = createNode({ type: filter.type || CFG.defaultType, x: p.x - NODE_W / 2, y: p.y - 20 });
    select({ kind: 'node', id: n.id });
    focusEnd(nodeEls.get(n.id).title);
  });

  viewport.addEventListener('wheel', e => {
    e.preventDefault();
    hideMenu();
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    else if (e.deltaMode === 2) { dx *= innerWidth; dy *= innerHeight; }
    if (!e.ctrlKey && !e.metaKey && Math.abs(dx) > Math.abs(dy)) {
      cancelAnimationFrame(viewAnim);
      setView(view.x - dx, view.y - dy, view.s);
      return;
    }
    const k = e.ctrlKey ? 0.01 : 0.0018;
    zoomAt(e.clientX, e.clientY, view.s * Math.exp(-dy * k));
  }, { passive: false });

  // Focusing text inside an overflow:hidden container can scroll it; keep it pinned.
  viewport.addEventListener('scroll', () => { viewport.scrollTop = 0; viewport.scrollLeft = 0; });

  // ---------- text editing ----------

  nodesLayer.addEventListener('focusin', e => {
    const ed = e.target;
    if (!ed.isContentEditable) return;
    const root = ed.closest('.node');
    const n = nodes.get(root.dataset.id);
    editSession = { id: n.id, snap: snapshot(), title: n.title, body: n.body };
    select({ kind: 'node', id: n.id });
  });

  nodesLayer.addEventListener('focusout', e => {
    const ed = e.target;
    if (!ed.isContentEditable) return;
    const id = ed.closest('.node').dataset.id;
    const n = nodes.get(id);
    if (editSession && editSession.id === id && n && (n.title !== editSession.title || n.body !== editSession.body)) {
      pushHistory(editSession.snap);
    }
    editSession = null;
    fmtEl.hidden = true;
  });

  nodesLayer.addEventListener('input', e => {
    const ed = e.target;
    const root = ed.closest('.node');
    if (!root) return;
    const n = nodes.get(root.dataset.id);
    if (!n) return;
    if (ed.classList.contains('title')) {
      if (ed.innerHTML === '<br>') ed.innerHTML = '';
      n.title = ed.textContent.replace(/[\r\n\t]+/g, ' ');
    } else if (ed.classList.contains('text')) {
      if (ed.innerHTML === '<br>') ed.innerHTML = '';
      n.body = Sanitize.rich(ed.innerHTML);
    }
    scheduleSave();
  });

  nodesLayer.addEventListener('keydown', e => {
    const ed = e.target;
    if (!ed.isContentEditable) return;
    const el = nodeEls.get(ed.closest('.node').dataset.id);
    const mod = e.ctrlKey || e.metaKey;
    if (ed.classList.contains('title')) {
      if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        if (el.text) focusEnd(el.text); else ed.blur();
      } else if (mod && /^[biu]$/i.test(e.key)) {
        e.preventDefault();
      }
    } else if (ed.classList.contains('text') && e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) focusEnd(el.title); else ed.blur();
    }
  });

  viewport.addEventListener('paste', e => {
    const ed = e.target.closest && e.target.closest('[contenteditable="true"]');
    if (!ed) return;
    e.preventDefault();
    const cd = e.clipboardData;
    const file = [...cd.files].find(f => f.type.startsWith('image/'));
    const root = ed.closest('.node');
    if (file && root && ed.classList.contains('text') && !ed.textContent.trim()) {
      setNodeImage(root.dataset.id, file);
      return;
    }
    let text = cd.getData('text/plain');
    if (!text) return;
    if (!ed.classList.contains('text')) text = text.replace(/\s+/g, ' ');
    document.execCommand('insertText', false, text);
  });

  // Paste an image with nothing focused → new image node in the middle of the screen.
  document.addEventListener('paste', e => {
    if (isEditable(document.activeElement)) return;
    const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    const p = toWorld(innerWidth / 2, innerHeight / 2);
    createImageNode(file, p.x, p.y);
  });

  // ---------- formatting toolbar ----------

  function updateFmt() {
    const sel = getSelection();
    const a = document.activeElement;
    if (!sel.rangeCount || sel.isCollapsed || !a || !a.classList || !a.classList.contains('text') || !a.contains(sel.anchorNode)) {
      fmtEl.hidden = true;
      return;
    }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r.width && !r.height) { fmtEl.hidden = true; return; }
    fmtEl.hidden = false;
    const fw = fmtEl.offsetWidth, fh = fmtEl.offsetHeight;
    fmtEl.style.left = clamp(r.left + r.width / 2 - fw / 2, 8, innerWidth - fw - 8) + 'px';
    fmtEl.style.top = (r.top - fh - 8 < 8 ? r.bottom + 8 : r.top - fh - 8) + 'px';
    for (const b of fmtEl.children) {
      let on = false;
      try { on = document.queryCommandState(b.dataset.cmd); } catch (err) { /* ignore */ }
      b.classList.toggle('on', on);
    }
  }

  let fmtReq = 0;
  document.addEventListener('selectionchange', () => {
    if (!fmtReq) fmtReq = requestAnimationFrame(() => { fmtReq = 0; updateFmt(); });
  });
  fmtEl.addEventListener('mousedown', e => e.preventDefault());
  fmtEl.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    document.execCommand(b.dataset.cmd);
    updateFmt();
  });

  // ---------- images ----------

  function readImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return reject(new Error('Empty image'));
        const k = Math.min(1, (NODE_W * 4) / w, 2400 / h);
        w = Math.round(w * k); h = Math.round(h * k);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        let data = c.toDataURL('image/webp', 0.86);
        if (!data.startsWith('data:image/webp')) data = c.toDataURL('image/jpeg', 0.88);
        resolve(data);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Unreadable image')); };
      img.src = url;
    });
  }

  function setNodeImage(id, file) {
    readImage(file).then(data => {
      const n = nodes.get(id);
      if (!n) return;
      pushHistory();
      n.kind = 'image';
      n.image = data;
      paintBody(n);
      scheduleSave();
    }).catch(() => toast('Could not read that image'));
  }

  function createImageNode(file, x, y) {
    readImage(file).then(data => {
      pushHistory();
      const n = createNode({ type: filter.type || CFG.defaultType, kind: 'image', image: data, x: x - NODE_W / 2, y: y - 20 });
      select({ kind: 'node', id: n.id });
    }).catch(() => toast('Could not read that image'));
  }

  function setNodeText(id) {
    const n = nodes.get(id);
    if (!n) return;
    pushHistory();
    n.kind = 'text';
    n.image = '';
    paintBody(n);
    scheduleSave();
  }

  function pickImage(id) {
    imageInput.dataset.target = id;
    imageInput.value = '';
    imageInput.click();
  }

  imageInput.addEventListener('change', () => {
    const file = imageInput.files[0];
    if (file && nodes.has(imageInput.dataset.target)) setNodeImage(imageInput.dataset.target, file);
  });

  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  viewport.addEventListener('drop', e => {
    e.preventDefault();
    const files = [...(e.dataTransfer.files || [])];
    const images = files.filter(f => f.type.startsWith('image/'));
    const nodeEl = e.target.closest && e.target.closest('.node');
    if (images.length) {
      if (nodeEl) setNodeImage(nodeEl.dataset.id, images[0]);
      else {
        const p = toWorld(e.clientX, e.clientY);
        images.forEach((f, i) => createImageNode(f, p.x + i * (NODE_W + 30), p.y));
      }
      return;
    }
    const json = files.find(f => /\.json$/i.test(f.name) || f.type === 'application/json');
    if (json) return importFile(json);
    const ed = e.target.closest && e.target.closest('[contenteditable="true"]');
    const text = e.dataTransfer.getData('text/plain');
    if (ed && text) {
      focusAt(ed, e.clientX, e.clientY);
      document.execCommand('insertText', false, ed.classList.contains('text') ? text : text.replace(/\s+/g, ' '));
    }
  });

  // ---------- context menu ----------

  function showMenu(items, x, y) {
    menuEl.textContent = '';
    for (const it of items) {
      if (it === '-') {
        menuEl.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }));
      } else if (it.heading) {
        menuEl.appendChild(Object.assign(document.createElement('div'), { className: 'heading', textContent: it.heading }));
      } else {
        const b = document.createElement('button');
        b.className = 'mi' + (it.danger ? ' danger' : '') + (it.color ? ' typed' : '');
        if (it.color) {
          const dot = document.createElement('span');
          dot.className = 'dot';
          dot.style.background = it.color;
          b.appendChild(dot);
        }
        b.appendChild(document.createTextNode(it.label));
        if (it.checked) {
          const c = document.createElement('span');
          c.className = 'check';
          c.textContent = '✓';
          b.appendChild(c);
        }
        b.addEventListener('click', () => { hideMenu(); it.action(); });
        menuEl.appendChild(b);
      }
    }
    menuEl.hidden = false;
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = clamp(x, 8, innerWidth - r.width - 8) + 'px';
    menuEl.style.top = clamp(y, 8, innerHeight - r.height - 8) + 'px';
  }

  function hideMenu() {
    menuEl.hidden = true;
  }

  window.addEventListener('pointerdown', e => {
    if (!menuEl.hidden && !menuEl.contains(e.target)) hideMenu();
  }, true);

  function typeItems(id) {
    const n = nodes.get(id);
    return TYPES.map(t => ({ label: t.key, color: t.color, checked: n.type === t.key, action: () => setType(id, t.key) }));
  }

  function openTypeMenu(id, x, y) {
    showMenu([{ heading: 'Type' }, ...typeItems(id)], x, y);
  }

  function setType(id, key) {
    const n = nodes.get(id);
    if (!n || n.type === key) return;
    pushHistory();
    n.type = key;
    paintType(n);
    applyFilter();
    refreshCounts();
    scheduleSave();
  }

  function deleteNode(id) {
    if (!nodes.has(id)) return;
    pushHistory();
    removeNode(id);
    applyFilter();
    refreshCounts();
    scheduleSave();
    toast('Node deleted — Ctrl/⌘ Z to undo');
  }

  function deleteEdge(eid) {
    if (!edges.has(eid)) return;
    pushHistory();
    removeEdge(eid);
    refreshCounts();
    scheduleSave();
  }

  viewport.addEventListener('contextmenu', e => {
    const t = e.target;
    const ed = t.closest('[contenteditable="true"]');
    if (ed && ed === document.activeElement) return; // keep the native menu (spellcheck) while writing
    e.preventDefault();
    const nodeEl = t.closest('.node');
    if (nodeEl) {
      const id = nodeEl.dataset.id;
      const n = nodes.get(id);
      blurEditing();
      select({ kind: 'node', id });
      const items = [{ heading: 'Type' }, ...typeItems(id), '-'];
      if (n.kind === 'text') items.push({ label: 'Add image…', action: () => pickImage(id) });
      else items.push({ label: 'Replace image…', action: () => pickImage(id) }, { label: 'Back to text', action: () => setNodeText(id) });
      items.push({ label: 'Center view here', action: () => centerOn(id) }, '-',
        { label: 'Delete node', danger: true, action: () => deleteNode(id) });
      showMenu(items, e.clientX, e.clientY);
      return;
    }
    const edgeEl = t.closest('.edge-g, .edge-label');
    if (edgeEl) {
      const eid = edgeEl.dataset.id;
      select({ kind: 'edge', id: eid });
      showMenu([
        { label: edges.get(eid).label ? 'Edit label' : 'Add label', action: () => editEdgeLabel(eid) },
        '-',
        { label: 'Delete connection', danger: true, action: () => deleteEdge(eid) },
      ], e.clientX, e.clientY);
      return;
    }
    const p = toWorld(e.clientX, e.clientY);
    showMenu([
      { heading: 'New node' },
      ...TYPES.map(t => ({
        label: t.key, color: t.color, action: () => {
          pushHistory();
          const n = createNode({ type: t.key, x: p.x - NODE_W / 2, y: p.y - 20 });
          select({ kind: 'node', id: n.id });
          focusEnd(nodeEls.get(n.id).title);
        },
      })),
      '-',
      { label: 'Fit all', action: fitView },
      { label: 'Center on first node', action: () => centerFirst() },
    ], e.clientX, e.clientY);
  });

  // ---------- keyboard ----------

  window.addEventListener('keydown', e => {
    const a = document.activeElement;
    const editing = isEditable(a);
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (e.key === 'Escape') {
      if (!menuEl.hidden) return hideMenu();
      if (!helpEl.hidden) return (helpEl.hidden = true);
      if (editing) return a.blur();
      if (filter.type || filter.query) return clearFilter();
      return select(null);
    }
    if (mod && key === 'f') { e.preventDefault(); searchEl.focus(); searchEl.select(); return; }
    if (mod && key === 's') { e.preventDefault(); saveNow(); toast('Saved'); return; }
    if (editing) return;

    if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && key === 'y') { e.preventDefault(); redo(); return; }
    if (mod) return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!selected) return;
      e.preventDefault();
      selected.kind === 'node' ? deleteNode(selected.id) : deleteEdge(selected.id);
    } else if (e.key === ' ') {
      e.preventDefault();
      spaceDown = true;
      viewport.classList.add('space');
    } else if (key === '/') {
      e.preventDefault();
      searchEl.focus();
    } else if (key === 'f') {
      fitView();
    } else if (key === '0' || e.key === 'Home') {
      centerFirst();
    } else if (key === '+' || key === '=') {
      zoomAt(innerWidth / 2, innerHeight / 2, view.s * 1.2);
    } else if (key === '-') {
      zoomAt(innerWidth / 2, innerHeight / 2, view.s / 1.2);
    } else if (e.key === 'Enter' && selected) {
      e.preventDefault();
      if (selected.kind === 'node') focusEnd(nodeEls.get(selected.id).title);
      else editEdgeLabel(selected.id);
    }
  });

  window.addEventListener('keyup', e => {
    if (e.key === ' ') { spaceDown = false; viewport.classList.remove('space'); }
  });
  window.addEventListener('blur', () => { spaceDown = false; viewport.classList.remove('space'); });

  // ---------- toolbar ----------

  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  function exportJSON() {
    flushPending();
    const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `relata-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function importFile(file) {
    file.text().then(txt => {
      let data;
      try { data = JSON.parse(txt); } catch (err) { return toast('That file is not valid JSON'); }
      if (!data || !Array.isArray(data.nodes)) return toast('No nodes found in that file');
      if (nodes.size && !confirm(`Replace the current world (${nodes.size} nodes) with “${file.name}”?\nYou can undo this with Ctrl/⌘ Z.`)) return;
      pushHistory();
      filter.type = null; filter.query = ''; searchEl.value = '';
      loadData(data);
      if (!nodes.size) seedFirst();
      centerFirst();
      scheduleSave();
      toast(`Imported ${nodes.size} node${nodes.size === 1 ? '' : 's'}`);
    });
  }

  $('#btn-fit').addEventListener('click', fitView);
  $('#btn-export').addEventListener('click', exportJSON);
  $('#btn-import').addEventListener('click', () => { importInput.value = ''; importInput.click(); });
  importInput.addEventListener('change', () => { if (importInput.files[0]) importFile(importInput.files[0]); });
  $('#btn-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('relata.theme', next); } catch (err) { /* ignore */ }
  });
  $('#btn-help').addEventListener('click', () => { helpEl.hidden = false; });
  helpEl.addEventListener('click', e => {
    if (e.target === helpEl || e.target.closest('.help-close')) helpEl.hidden = true;
  });
  $('#zoom-in').addEventListener('click', () => zoomAt(innerWidth / 2, innerHeight / 2, view.s * 1.2));
  $('#zoom-out').addEventListener('click', () => zoomAt(innerWidth / 2, innerHeight / 2, view.s / 1.2));
  zoomLabel.addEventListener('click', () => {
    const c = toWorld(innerWidth / 2, innerHeight / 2);
    animateView(innerWidth / 2 - c.x, innerHeight / 2 - c.y, 1);
  });

  // ---------- startup ----------

  function seedFirst() {
    insertNode(makeNode({ type: CFG.defaultType, x: -NODE_W / 2, y: -60 }));
    applyFilter();
    refreshCounts();
  }

  async function init() {
    try { document.execCommand('styleWithCSS', false, false); } catch (err) { /* ignore */ }
    buildLegend();
    let data = null;
    try { data = await RelataStore.load(); } catch (err) { console.warn(err); }
    if (data && Array.isArray(data.nodes)) loadData(data);
    if (!nodes.size) seedFirst();
    if (!data) helpEl.hidden = false;
    centerFirst(false);
    flush();
    refreshCounts();
    if (!data) scheduleSave();
  }

  init();
})();

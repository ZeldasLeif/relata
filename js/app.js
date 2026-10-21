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
  const titleInput = $('#project-title');
  const projectsBtn = $('#btn-projects');
  const connectEl = $('#connect');
  const Store = window.RelataStore;
  document.documentElement.style.setProperty('--node-w', NODE_W + 'px');

  // ---------- state ----------

  const nodes = new Map();    // id -> {id, type, title, kind, body, image, x, y}
  const edges = new Map();    // id -> {id, a, b, label}
  const adj = new Map();      // nodeId -> Set(edgeId)
  const nodeEls = new Map();  // nodeId -> {root, label, title, body, text, h}
  const edgeEls = new Map();  // edgeId -> {g, hit, line, label}
  const view = { x: 0, y: 0, s: 1 };
  const filter = { type: null, query: '', chapter: null }; // chapter: {id, mode: 'only' | 'upto'}
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
    if (storyPrefs.path && dirtyEdgesOf.size) drawStoryPath();
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

  // Left edge of the free canvas area (the story panel covers the left side when open).
  function freeLeft() {
    const story = document.getElementById('story');
    return story && !story.hidden ? story.getBoundingClientRect().right : 0;
  }

  function centerOn(id, s = view.s, animate = true) {
    const c = center(id);
    const cx = (freeLeft() + innerWidth) / 2;
    const tx = cx - c.x * s, ty = innerHeight / 2 - c.y * s;
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
    const pad = 90, left = freeLeft(), w = innerWidth - left;
    const s = clamp(Math.min(w / (x1 - x0 + pad * 2), innerHeight / (y1 - y0 + pad * 2)), MIN_SCALE, 1);
    animateView(left + w / 2 - (x0 + x1) / 2 * s, innerHeight / 2 - (y0 + y1) / 2 * s, s);
  }

  // ---------- nodes ----------

  function makeNode(d) {
    const n = {
      id: typeof d.id === 'string' && d.id ? d.id : uid(),
      type: typeof d.type === 'string' && d.type.trim() ? d.type.trim().toUpperCase().slice(0, 40) : CFG.defaultType,
      title: typeof d.title === 'string' ? d.title.replace(/[\r\n\t]+/g, ' ').slice(0, 1000) : '',
      kind: d.kind === 'image' ? 'image' : 'text',
      body: typeof d.body === 'string' ? Sanitize.rich(d.body) : '',
      image: typeof d.image === 'string' && (/^data:image\//.test(d.image) || IMAGE_PATH.test(d.image)) ? d.image : '',
      parent: typeof d.parent === 'string' ? d.parent : '',
      x: Number.isFinite(+d.x) ? +d.x : 0,
      y: Number.isFinite(+d.y) ? +d.y : 0,
    };
    if (n.kind === 'image' && !n.image) n.kind = 'text';
    if (n.kind === 'text') { n.image = ''; n.parent = ''; }
    return n;
  }

  const IMAGE_PATH = /^images\/[^/\\]+$/;

  // Attached image nodes show their parent's title and type and follow it around.
  function childrenOf(id) {
    const out = [];
    for (const n of nodes.values()) if (n.parent === id) out.push(n);
    return out;
  }

  function paintTitle(n) {
    const el = nodeEls.get(n.id);
    if (el.title.textContent !== n.title) el.title.textContent = n.title;
    const attached = !!n.parent;
    el.root.classList.toggle('attached', attached);
    el.title.contentEditable = attached ? 'false' : 'true';
    el.title.title = attached ? `Image of “${n.title || 'Untitled'}”` : '';
  }

  function syncChildren(id) {
    const p = nodes.get(id);
    if (!p) return;
    for (const c of childrenOf(id)) {
      const typeChanged = c.type !== p.type;
      c.title = p.title;
      c.type = p.type;
      paintTitle(c);
      if (typeChanged) paintType(c);
    }
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
    root.style.transform = `translate(${n.x}px,${n.y}px)`;
    nodeEls.set(n.id, el);
    paintTitle(n);
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

  // Image references are data: URLs (browser storage) or "images/<file>" inside the data folder.
  const imageURLs = new Map(); // path -> Promise<objectURL>

  function imageSrc(ref) {
    if (ref.startsWith('data:')) return Promise.resolve(ref);
    if (!imageURLs.has(ref)) {
      if (!backend.readImage) return Promise.reject(new Error('No image folder'));
      const p = backend.readImage(ref).then(blob => URL.createObjectURL(blob));
      p.catch(() => imageURLs.delete(ref));
      imageURLs.set(ref, p);
    }
    return imageURLs.get(ref);
  }

  function forgetImageURLs() {
    for (const p of imageURLs.values()) p.then(u => URL.revokeObjectURL(u), () => {});
    imageURLs.clear();
  }

  function paintBody(n) {
    const el = nodeEls.get(n.id);
    el.body.textContent = '';
    el.text = null;
    dropMentions(n.id);
    el.root.classList.toggle('is-image', n.kind === 'image');
    el.root.classList.remove('img-missing');
    if (n.kind === 'image') {
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      el.body.appendChild(img);
      const ref = n.image;
      imageSrc(ref).then(url => { if (n.image === ref) img.src = url; })
        .catch(() => { if (n.image === ref) el.root.classList.add('img-missing'); });
    } else {
      const t = document.createElement('div');
      t.className = 'text';
      t.contentEditable = 'true';
      t.spellcheck = true;
      t.dataset.placeholder = 'Write…';
      t.innerHTML = n.body;
      el.body.appendChild(t);
      el.text = t;
      if (!bulkLoading) scanMentions(n.id);
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
    scheduleMentionRescan();
    return n;
  }

  function removeNode(id) {
    for (const eid of [...(adj.get(id) || [])]) removeEdge(eid);
    const el = nodeEls.get(id);
    if (el) { ro.unobserve(el.root); el.root.remove(); }
    if (selected && selected.kind === 'node' && selected.id === id) selected = null;
    if (editSession && editSession.id === id) editSession = null;
    dropMentions(id);
    nodes.delete(id);
    nodeEls.delete(id);
    adj.delete(id);
    for (const c of childrenOf(id)) { c.parent = ''; paintTitle(c); }
    removeFromStory(id);
    if (!bulkLoading) scheduleMentionRescan();
  }

  function bringToFront(id) {
    const el = nodeEls.get(id);
    if (el) el.root.style.zIndex = ++zTop;
  }

  // ---------- edges ----------

  const DASHES = ['solid', 'dashed', 'dotted'];
  const DEFAULT_WIDTH = 1.5;

  function makeEdge(a, b, label, id, style = {}) {
    const w = +style.width;
    return {
      id: typeof id === 'string' && id && !edges.has(id) ? id : uid(),
      a: String(a), b: String(b),
      label: typeof label === 'string' ? label.replace(/\s+/g, ' ').trim().slice(0, 200) : '',
      color: typeof style.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(style.color) ? style.color : '',
      width: Number.isFinite(w) && w > 0 ? clamp(w, 0.5, 8) : DEFAULT_WIDTH,
      dash: DASHES.includes(style.dash) ? style.dash : 'solid',
    };
  }

  function dashArray(dash, w) {
    if (dash === 'dashed') return `${(4 * w + 2).toFixed(1)} ${(3 * w + 3).toFixed(1)}`;
    if (dash === 'dotted') return `0 ${(2.6 * w + 2).toFixed(1)}`;
    return '';
  }

  function paintEdgeStyle(e) {
    const ee = edgeEls.get(e.id);
    if (!ee) return;
    ee.line.style.stroke = e.color;
    ee.line.classList.toggle('colored', !!e.color);
    ee.line.style.strokeWidth = e.width;
    ee.line.style.strokeDasharray = dashArray(e.dash, e.width);
    ee.hit.style.strokeWidth = Math.max(14, e.width + 10);
    if (ee.label) ee.label.style.borderColor = e.color ? `color-mix(in oklab, ${e.color} 60%, transparent)` : '';
  }

  function styleEdge(eid, patch) {
    const e = edges.get(eid);
    if (!e || Object.keys(patch).every(k => e[k] === patch[k])) return;
    pushHistory();
    Object.assign(e, patch);
    paintEdgeStyle(e);
    scheduleSave();
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
    paintEdgeStyle(e);
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
    paintEdgeStyle(e);
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
      chapters: chapters.map(c => ({ ...c, items: [...c.items] })),
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
    externalizeImages();
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
    clearMentions();
    selected = null;
    editSession = null;
    bulkLoading = true;
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
      insertEdge(makeEdge(d.a, d.b, d.label, d.id, d));
    }
    for (const n of nodes.values()) {
      const p = n.parent && nodes.get(n.parent);
      if (n.parent && (!p || p.parent || n.kind !== 'image')) { n.parent = ''; paintTitle(n); }
    }
    for (const n of nodes.values()) if (!n.parent) syncChildren(n.id);
    chapters = makeChapters(data && data.chapters);
    bulkLoading = false;
    rescanAllMentions();
    scheduleStory();
    applyFilter();
    refreshCounts();
  }

  function serialize() {
    return {
      app: 'relata',
      version: 1,
      title: project.title,
      savedAt: new Date().toISOString(),
      nodes: [...nodes.values()].map(n => ({
        id: n.id, type: n.type, title: n.title, kind: n.kind,
        body: n.body, image: n.kind === 'image' ? n.image : '',
        ...(n.parent ? { parent: n.parent } : {}),
        x: Math.round(n.x), y: Math.round(n.y),
      })),
      edges: [...edges.values()].map(e => ({
        id: e.id, a: e.a, b: e.b, label: e.label, color: e.color, width: e.width, dash: e.dash,
      })),
      chapters: chapters.map(c => ({ id: c.id, title: c.title, items: [...c.items] })),
    };
  }

  // ---------- projects & autosave ----------
  // Every change is written (debounced) to the current project's backend:
  // a .json file in the data folder, or the browser's own storage.

  let backend = Store.browser;
  const project = { id: null, title: '' };
  let saveTimer = 0;
  let saveState = 'saved';
  let saveChain = Promise.resolve();

  function scheduleSave() {
    if (!project.id) return;
    setSaveState('pending');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!project.id) return saveChain;
    const target = backend, id = project.id, data = serialize();
    saveChain = saveChain
      .then(() => target.write(id, data))
      .then(() => {
        if (!saveTimer) setSaveState('saved');
        target.backup(id, data).catch(err => console.warn('Backup failed', err));
      })
      .catch(err => {
        console.error(err);
        setSaveState('error');
        toast(target.kind === 'folder'
          ? `Could not write ${id} — check the data folder, or export a backup.`
          : 'Could not save locally — please export a backup.');
      });
    return saveChain;
  }

  function flushSave() {
    return saveTimer ? saveNow() : saveChain;
  }

  function setSaveState(s) {
    saveState = s;
    renderStatus();
  }

  function renderStatus() {
    const where = backend.kind === 'folder' ? `${backend.label}/${project.id || ''}` : 'this browser';
    const words = { saved: `saved to ${where}`, pending: 'saving…', error: 'not saved' };
    statusEl.className = 'ui ' + saveState;
    statusEl.innerHTML = `${nodes.size} node${nodes.size === 1 ? '' : 's'} · ${edges.size} connection${edges.size === 1 ? '' : 's'}<span class="dot"></span>`;
    statusEl.appendChild(document.createTextNode(words[saveState]));
  }

  const flushPending = () => { if (saveTimer) saveNow(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPending(); });
  window.addEventListener('pagehide', flushPending);
  window.addEventListener('beforeunload', flushPending);

  function blankProject(title) {
    return { app: 'relata', version: 1, title, nodes: [], edges: [] };
  }

  async function openProject(id, { center = true } = {}) {
    await flushSave();
    let data;
    try { data = await backend.read(id); } catch (err) {
      console.error(err);
      toast('Could not open that project');
      return false;
    }
    if (!data || !Array.isArray(data.nodes)) { toast('That file is not a relata project'); return false; }
    project.id = id;
    project.renamePending = false;
    project.title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : String(id).replace(/\.json$/i, '');
    titleInput.value = project.title;
    document.title = `${project.title} · relata`;
    history.length = 0;
    future.length = 0;
    filter.type = null; filter.chapter = null; filter.query = ''; searchEl.value = '';
    stopPlay();
    loadData(data);
    if (!nodes.size) { seedFirst(); scheduleSave(); }
    if (center) centerFirst(false);
    externalizeImages();
    Store.kvSet('last', { kind: backend.kind, id }).catch(() => {});
    renderStatus();
    return true;
  }

  async function openLatest() {
    let list = [];
    try { list = await backend.list(); } catch (err) { console.error(err); }
    if (!list.length) return newProject('Untitled world');
    // The project open last time comes first, then the most recently modified file.
    const last = await Store.kvGet('last').catch(() => null);
    const rank = p => (last && last.kind === backend.kind && last.id === p.id ? Infinity : p.modified);
    list.sort((a, b) => rank(b) - rank(a));
    for (const p of list) if (await openProject(p.id)) return;
    return newProject('Untitled world');
  }

  async function newProject(title = 'Untitled world', data = blankProject(title)) {
    await flushSave();
    let id;
    try { id = await backend.create(title, { ...data, title }); } catch (err) {
      console.error(err);
      toast('Could not create the project');
      return;
    }
    await openProject(id);
  }

  async function renameProject() {
    const title = titleInput.value.replace(/\s+/g, ' ').trim() || 'Untitled world';
    titleInput.value = title;
    if (title === project.title && !project.renamePending) return;
    project.title = title;
    project.renamePending = false;
    document.title = `${title} · relata`;
    await saveNow();
    try {
      const id = await backend.rename(project.id, title);
      if (id !== project.id) {
        project.id = id;
        Store.kvSet('last', { kind: backend.kind, id }).catch(() => {});
        renderStatus();
      }
    } catch (err) { console.warn('Rename failed', err); }
  }

  titleInput.addEventListener('input', () => {
    project.title = titleInput.value.replace(/\s+/g, ' ').trim() || 'Untitled world';
    project.renamePending = true;
    scheduleSave();
  });
  titleInput.addEventListener('change', renameProject);
  titleInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); titleInput.blur(); }
  });

  async function useBackend(next) {
    await flushSave();
    forgetImageURLs();
    backend = next;
    renderStatus();
  }

  // Connects a data folder. An empty folder receives the project currently open.
  async function connectFolder(dir) {
    const folder = Store.folder(dir);
    let list = [];
    try { list = await folder.list(); } catch (err) { console.error(err); toast('Could not read that folder'); return false; }
    const carry = !list.length && project.id && nodes.size ? serialize() : null;
    await useBackend(folder);
    project.id = null;
    if (carry) await newProject(carry.title || 'Untitled world', carry);
    else await openLatest();
    toast(`Saving to folder “${dir.name}”`);
    return true;
  }

  async function chooseFolder() {
    let dir;
    try { dir = await Store.pickFolder(); } catch (err) {
      if (err && err.name !== 'AbortError') { console.error(err); toast('Could not open that folder'); }
      return false;
    }
    return connectFolder(dir);
  }

  async function useBrowserStorage() {
    await Store.forgetFolder();
    await useBackend(Store.browser);
    project.id = null;
    await openLatest();
  }

  function relTime(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 30) return Math.round(s / 86400) + ' d ago';
    return new Date(ms).toLocaleDateString();
  }

  async function openProjectMenu() {
    await flushSave();
    let list = [];
    try { list = await backend.list(); } catch (err) { console.error(err); }
    list.sort((a, b) => b.modified - a.modified);
    const items = [{ heading: backend.kind === 'folder' ? `Folder · ${backend.label}` : 'In this browser' }];
    for (const p of list) {
      items.push({
        label: p.title, className: 'project', checked: p.id === project.id,
        hint: p.id === project.id ? '' : relTime(p.modified),
        title: backend.kind === 'folder' ? p.id : '',
        action: () => { if (p.id !== project.id) openProject(p.id); },
      });
    }
    items.push('-', { label: 'New project', action: () => newProject('Untitled world').then(() => { titleInput.focus(); titleInput.select(); }) });
    if (Store.folderSupported) {
      if (backend.kind === 'folder') {
        items.push({ label: 'Change data folder…', action: chooseFolder },
          { label: 'Keep projects in this browser instead', action: useBrowserStorage });
      } else {
        items.push({ label: 'Save to a data folder…', action: chooseFolder });
      }
    } else {
      items.push({ note: 'Saving into a data folder needs Chrome, Edge or another Chromium browser. Here, projects live in this browser — export now and then.' });
    }
    const r = projectsBtn.getBoundingClientRect();
    showMenu(items, r.right - 240, r.bottom + 8);
  }

  projectsBtn.addEventListener('click', () => {
    if (menuEl.hidden) openProjectMenu(); else hideMenu();
  });

  // ---------- mentions ----------
  // Another node's exact title inside a text becomes a link. Nothing is stored or inserted
  // into the text: matches are found on the fly and painted with the CSS Highlight API,
  // so renaming a node updates every link and the caret is never disturbed while writing.

  const MIN_TITLE = 3;
  const mentionHL = window.CSS && CSS.highlights && typeof window.Highlight === 'function' ? new Highlight() : null;
  if (mentionHL) CSS.highlights.set('mention', mentionHL);
  const mentionRanges = new Map(); // nodeId -> [{range, target}]
  const titleTargets = new Map();  // normalized title -> nodeId
  let titleRegex = null;
  let bulkLoading = false;
  let rescanTimer = 0;

  const normTitle = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function rebuildTitleIndex() {
    titleTargets.clear();
    for (const n of nodes.values()) {
      if (n.parent) continue;
      const k = normTitle(n.title);
      if (k.length >= MIN_TITLE && !titleTargets.has(k)) titleTargets.set(k, n.id);
    }
    const keys = [...titleTargets.keys()].sort((a, b) => b.length - a.length)
      .map(k => escapeRe(k).replace(/ /g, '\\s+'));
    titleRegex = keys.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${keys.join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
  }

  function dropMentions(id) {
    const old = mentionRanges.get(id);
    if (old && mentionHL) for (const m of old) mentionHL.delete(m.range);
    mentionRanges.delete(id);
  }

  function clearMentions() {
    mentionHL?.clear();
    mentionRanges.clear();
  }

  function scanMentions(id) {
    dropMentions(id);
    const el = nodeEls.get(id);
    if (!el || !el.text || !titleRegex) return;
    // Flatten the text, remembering where each text node starts.
    const parts = [];
    let str = '';
    const walker = document.createTreeWalker(el.text, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === 3) { parts.push([node, str.length]); str += node.nodeValue; }
      else if (node.tagName === 'BR' || node.tagName === 'DIV' || node.tagName === 'P') str += '\n';
    }
    if (!parts.length) return;
    const locate = (pos, isEnd) => {
      for (const [node, start] of parts) {
        const end = start + node.nodeValue.length;
        if (isEnd ? pos > start && pos <= end : pos >= start && pos < end) return [node, pos - start];
      }
      return null;
    };
    const list = [];
    titleRegex.lastIndex = 0;
    for (let m = titleRegex.exec(str); m; m = titleRegex.exec(str)) {
      const target = titleTargets.get(normTitle(m[0]));
      if (!target || target === id) continue;
      const s = locate(m.index, false), e = locate(m.index + m[0].length, true);
      if (!s || !e) continue;
      const range = document.createRange();
      range.setStart(s[0], s[1]);
      range.setEnd(e[0], e[1]);
      list.push({ range, target });
      mentionHL?.add(range);
    }
    if (list.length) mentionRanges.set(id, list);
  }

  function rescanAllMentions() {
    clearTimeout(rescanTimer);
    rescanTimer = 0;
    rebuildTitleIndex();
    clearMentions();
    for (const id of nodes.keys()) scanMentions(id);
  }

  // Titles changed (typed, created, deleted): rebuild all links shortly after.
  function scheduleMentionRescan() {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(rescanAllMentions, 350);
  }

  function mentionAt(id, x, y) {
    for (const m of mentionRanges.get(id) || []) {
      for (const r of m.range.getClientRects()) {
        if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) return m.target;
      }
    }
    return null;
  }

  function jumpTo(id) {
    const n = nodes.get(id);
    if (!n) return;
    if (n._vis === false) clearFilter();
    blurEditing();
    select({ kind: 'node', id });
    centerOn(id, Math.max(view.s, 0.85));
    const root = nodeEls.get(id).root;
    root.classList.remove('pulse');
    void root.offsetWidth;
    root.classList.add('pulse');
    setTimeout(() => root.classList.remove('pulse'), 2100);
  }


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
    let allowed = null, ci = -1;
    if (filter.chapter) {
      ci = chapters.findIndex(c => c.id === filter.chapter.id);
      if (ci < 0) filter.chapter = null;
      else {
        allowed = new Set();
        const shown = filter.chapter.mode === 'only' ? [chapters[ci]] : chapters.slice(0, ci + 1);
        for (const c of shown) for (const id of c.items) allowed.add(id);
      }
    }
    const active = !!(filter.type || q || allowed);
    for (const n of nodes.values()) {
      const vis = (!filter.type || n.type === filter.type) &&
        (!q || n.title.toLowerCase().includes(q) || plainOf(n).includes(q)) &&
        (!allowed || allowed.has(n.id) || (!!n.parent && allowed.has(n.parent)));
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
      if (allowed) {
        const name = escapeHtml(chapterName(chapters[ci], ci));
        parts.push(filter.chapter.mode === 'only' ? `chapter <b>${ci + 1}</b> ${name}` : `what's known up to chapter <b>${ci + 1}</b>`);
      }
      if (filter.type) parts.push(`<b>${escapeHtml(filter.type)}</b>`);
      if (q) parts.push(`“${escapeHtml(filter.query.trim())}”`);
      filterHint.innerHTML = `Showing ${parts.join(' · ')} — ${count} node${count === 1 ? '' : 's'} · click empty space to show all`;
    }
    filterHint.hidden = !active;
    if (!storyEl.hidden || storyPrefs.path) scheduleStory();
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
    filter.chapter = null;
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
    if (ed && ed === document.activeElement) {
      // Ctrl/⌘-click follows a mention while writing; anything else is native editing.
      const target = (e.ctrlKey || e.metaKey) && ed.classList.contains('text') && mentionAt(id, e.clientX, e.clientY);
      if (target) { blockNative = true; jumpTo(target); }
      return;
    }

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
      for (const k of g.kids) {
        const c = nodes.get(k.id);
        if (c) { c.x = k.ox + dx / view.s; c.y = k.oy + dy / view.s; markMoved(k.id); }
      }
      showItemDrop(storyEl.hidden ? null : itemDropAt(e.clientX, e.clientY));
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
      g.kids = childrenOf(g.id).map(c => ({ id: c.id, ox: c.x, oy: c.y }));
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
      const drop = !cancelled && !storyEl.hidden && itemDropAt(e.clientX, e.clientY);
      clearDropMarks();
      if (drop) {
        // Dropped onto a chapter: the node goes back where it was and joins the story.
        for (const k of [{ id: g.id, ox: g.ox, oy: g.oy }, ...g.kids]) {
          const c = nodes.get(k.id);
          if (c) { c.x = k.ox; c.y = k.oy; markMoved(k.id); }
        }
        placeInChapter(g.id, drop.ch, drop.index);
        return;
      }
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
    if (filter.type || filter.query || filter.chapter) clearFilter();
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
      const target = mentionAt(id, e.clientX, e.clientY);
      if (target) jumpTo(target);
      else focusAt(el.text, e.clientX, e.clientY);
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
    const text = !on && nodeEl && e.target.closest('.text');
    const overMention = !!text && (text !== document.activeElement || e.ctrlKey || e.metaKey) &&
      !!mentionAt(nodeEl.dataset.id, e.clientX, e.clientY);
    document.body.classList.toggle('over-mention', overMention);
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
      syncChildren(n.id);
      scheduleMentionRescan();
      scheduleStory();
    } else if (ed.classList.contains('text')) {
      if (ed.innerHTML === '<br>') ed.innerHTML = '';
      n.body = Sanitize.rich(ed.innerHTML);
      scanMentions(n.id);
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
    if (file && root) {
      addImageTo(root.dataset.id, file);
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
  // "Add image" never replaces a node's text: it creates an image node attached to it.
  // In folder mode the image is saved as a file in data/images/ and referenced by path.

  const COPY_TYPES = /^image\/(jpeg|png|webp|gif)$/;
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

  // Keeps the original file when it's reasonably sized, otherwise makes a downscaled copy.
  function processImage(file, maxSide, maxBytes) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return reject(new Error('Empty image'));
        if (COPY_TYPES.test(file.type) && Math.max(w, h) <= maxSide && file.size <= maxBytes) {
          return resolve({ blob: file, ext: EXT[file.type] });
        }
        const k = Math.min(1, maxSide / Math.max(w, h));
        const c = document.createElement('canvas');
        c.width = Math.round(w * k);
        c.height = Math.round(h * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(b => b ? resolve({ blob: b, ext: EXT[b.type] || 'png' }) : reject(new Error('Encode failed')), 'image/webp', 0.88);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Unreadable image')); };
      img.src = url;
    });
  }

  const blobToDataURL = blob => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  function dataURLToBlob(url) {
    const [head, b64] = url.split(',');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: head.slice(5).split(';')[0] });
  }

  const imageName = (hint, ext) => `${Store.slug(hint) || 'image'}-${uid().slice(-6)}.${ext}`;

  // Returns what the node stores: "images/<file>" in folder mode, otherwise a data URL.
  async function storeImage(file, hint) {
    if (backend.writeImage) {
      const { blob, ext } = await processImage(file, 2000, 3 * 1024 * 1024);
      const ref = await backend.writeImage(imageName(hint, ext), blob);
      imageURLs.set(ref, Promise.resolve(URL.createObjectURL(blob)));
      return ref;
    }
    const { blob } = await processImage(file, 1040, 400 * 1024);
    return blobToDataURL(blob);
  }

  // Moves embedded images (browser projects, imports, older files) into data/images/.
  async function externalizeImages() {
    if (!backend.writeImage) return;
    const target = backend;
    let changed = false;
    for (const n of [...nodes.values()]) {
      if (n.kind !== 'image' || !n.image.startsWith('data:')) continue;
      try {
        const blob = dataURLToBlob(n.image);
        const ref = await target.writeImage(imageName(n.title, EXT[blob.type] || 'png'), blob);
        imageURLs.set(ref, Promise.resolve(URL.createObjectURL(blob)));
        if (backend === target && nodes.get(n.id) === n) { n.image = ref; changed = true; }
      } catch (err) { console.warn('Could not move image into the folder', err); }
    }
    if (changed) scheduleSave();
  }

  // Data URLs for every image, so an export is one self-contained file.
  async function embeddedImages(data) {
    for (const d of data.nodes) {
      if (d.kind !== 'image' || !IMAGE_PATH.test(d.image)) continue;
      try { d.image = await blobToDataURL(await backend.readImage(d.image)); } catch (err) { /* leave the path */ }
    }
    return data;
  }

  async function addImageTo(id, file) {
    const p = nodes.get(id);
    if (!p) return;
    let ref;
    try { ref = await storeImage(file, p.title); } catch (err) { return toast('Could not read that image'); }
    if (!nodes.has(id)) return;
    pushHistory();
    let y = p.y;
    for (const c of childrenOf(id)) y = Math.max(y, c.y + nodeHeight(c.id) + 28);
    const n = createNode({ kind: 'image', image: ref, parent: id, type: p.type, title: p.title, x: p.x + NODE_W + 60, y });
    insertEdge(makeEdge(id, n.id));
    applyFilter();
    refreshCounts();
    scheduleSave();
    select({ kind: 'node', id: n.id });
  }

  async function setNodeImage(id, file) {
    const n0 = nodes.get(id);
    if (!n0) return;
    let ref;
    try { ref = await storeImage(file, n0.title); } catch (err) { return toast('Could not read that image'); }
    const n = nodes.get(id);
    if (!n) return;
    pushHistory();
    n.kind = 'image';
    n.image = ref;
    paintBody(n);
    scheduleSave();
  }

  async function createImageNode(file, x, y) {
    let ref;
    try { ref = await storeImage(file, file.name.replace(/\.[^.]+$/, '')); } catch (err) { return toast('Could not read that image'); }
    pushHistory();
    const n = createNode({ type: filter.type || CFG.defaultType, kind: 'image', image: ref, x: x - NODE_W / 2, y: y - 20 });
    select({ kind: 'node', id: n.id });
  }

  // Images dropped on a text node attach to it; on an image node they replace the picture.
  async function imagesOnto(id, files) {
    const n = nodes.get(id);
    if (!n) return;
    if (n.kind === 'image') return setNodeImage(id, files[0]);
    for (const f of files) await addImageTo(id, f);
  }

  function setNodeText(id) {
    const n = nodes.get(id);
    if (!n) return;
    pushHistory();
    n.kind = 'text';
    n.image = '';
    n.parent = '';
    paintTitle(n);
    paintBody(n);
    scheduleSave();
  }

  function detachImage(id) {
    const n = nodes.get(id);
    if (!n || !n.parent) return;
    pushHistory();
    n.parent = '';
    paintTitle(n);
    scheduleSave();
    scheduleMentionRescan();
  }

  function pickImage(id, mode) {
    imageInput.dataset.target = id;
    imageInput.dataset.mode = mode;
    imageInput.multiple = mode === 'attach';
    imageInput.value = '';
    imageInput.click();
  }

  imageInput.addEventListener('change', () => {
    const files = [...imageInput.files];
    const id = imageInput.dataset.target;
    if (!files.length || !nodes.has(id)) return;
    if (imageInput.dataset.mode === 'attach') imagesOnto(id, files);
    else setNodeImage(id, files[0]);
  });

  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  viewport.addEventListener('drop', e => {
    e.preventDefault();
    const files = [...(e.dataTransfer.files || [])];
    const images = files.filter(f => f.type.startsWith('image/'));
    const nodeEl = e.target.closest && e.target.closest('.node');
    if (images.length) {
      if (nodeEl) imagesOnto(nodeEl.dataset.id, images);
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
    const el = (tag, className, text) => {
      const n = document.createElement(tag);
      if (className) n.className = className;
      if (text != null) n.textContent = text;
      return n;
    };
    const pick = (b, action) => b.addEventListener('click', () => { hideMenu(); action(); });
    for (const it of items) {
      if (it === '-') {
        menuEl.appendChild(el('div', 'sep'));
      } else if (it.heading) {
        menuEl.appendChild(el('div', 'heading', it.heading));
      } else if (it.note) {
        menuEl.appendChild(el('div', 'note', it.note));
      } else if (it.swatches || it.options) {
        const row = el('div', 'row');
        for (const o of it.swatches || it.options) {
          const b = el('button', (it.swatches ? 'swatch' : 'opt') + (o.checked ? ' on' : ''));
          b.title = o.title;
          if (it.swatches) b.style.background = o.color || 'var(--edge-hi)';
          else b.innerHTML = o.svg;
          pick(b, o.action);
          row.appendChild(b);
        }
        menuEl.appendChild(row);
      } else {
        const b = el('button', 'mi' + (it.danger ? ' danger' : '') + (it.color ? ' typed' : '') + (it.className ? ' ' + it.className : ''));
        if (it.title) b.title = it.title;
        if (it.color) {
          const dot = el('span', 'dot');
          dot.style.background = it.color;
          b.appendChild(dot);
        }
        b.appendChild(document.createTextNode(it.label));
        if (it.hint) b.appendChild(el('span', 'hint', it.hint));
        if (it.checked) b.appendChild(el('span', 'check', '✓'));
        pick(b, it.action);
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
    if (!menuEl.hidden && !menuEl.contains(e.target) && !projectsBtn.contains(e.target)) hideMenu();
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
    syncChildren(id);
    scheduleStory();
    applyFilter();
    refreshCounts();
    scheduleSave();
  }

  function deleteNode(id) {
    if (!nodes.has(id)) return;
    pushHistory();
    for (const c of childrenOf(id)) removeNode(c.id);
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

  function lineSample(width, dash) {
    const da = dashArray(dash, width);
    return `<svg viewBox="0 0 36 12" width="36" height="12"><line x1="4" y1="6" x2="32" y2="6" stroke="currentColor" stroke-width="${width}" stroke-linecap="round"${da ? ` stroke-dasharray="${da}"` : ''}/></svg>`;
  }

  // Style changes apply immediately and reopen the menu so options can be tried in a row.
  function openEdgeMenu(eid, x, y) {
    const e = edges.get(eid);
    if (!e) return;
    const restyle = patch => () => { styleEdge(eid, patch); openEdgeMenu(eid, x, y); };
    showMenu([
      { label: e.label ? 'Edit label' : 'Add label', action: () => editEdgeLabel(eid) },
      { heading: 'Color' },
      { swatches: (CFG.edgeColors || []).map(c => ({ color: c.color, title: c.name, checked: e.color === c.color, action: restyle({ color: c.color }) })) },
      { heading: 'Thickness' },
      { options: (CFG.edgeWidths || []).map(w => ({ svg: lineSample(w.width, 'solid'), title: w.name, checked: e.width === w.width, action: restyle({ width: w.width }) })) },
      { heading: 'Line' },
      { options: DASHES.map(d => ({ svg: lineSample(Math.max(e.width, 1.5), d), title: d[0].toUpperCase() + d.slice(1), checked: e.dash === d, action: restyle({ dash: d }) })) },
      '-',
      { label: 'Delete connection', danger: true, action: () => deleteEdge(eid) },
    ], x, y);
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
      const items = n.parent ? [] : [{ heading: 'Type' }, ...typeItems(id), '-'];
      if (n.kind === 'text') items.push({ label: 'Add image…', action: () => pickImage(id, 'attach') });
      else {
        items.push({ label: 'Replace image…', action: () => pickImage(id, 'replace') });
        if (n.parent) items.push({ label: 'Go to ' + (nodes.get(n.parent).title || 'parent'), action: () => jumpTo(n.parent) },
          { label: 'Detach (own title)', action: () => detachImage(id) });
        else items.push({ label: 'Back to text', action: () => setNodeText(id) });
      }
      items.push(...chapterItems(id));
      items.push('-', { label: 'Center view here', action: () => centerOn(id) },
        { label: n.parent ? 'Delete image' : 'Delete node', danger: true, action: () => deleteNode(id) });
      showMenu(items, e.clientX, e.clientY);
      return;
    }
    const edgeEl = t.closest('.edge-g, .edge-label');
    if (edgeEl) {
      const eid = edgeEl.dataset.id;
      select({ kind: 'edge', id: eid });
      openEdgeMenu(eid, e.clientX, e.clientY);
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
      if (play) return stopPlay();
      if (filter.type || filter.query || filter.chapter) return clearFilter();
      return select(null);
    }
    if (mod && key === 'f') { e.preventDefault(); searchEl.focus(); searchEl.select(); return; }
    if (mod && key === 's') { e.preventDefault(); saveNow(); toast('Saved'); return; }
    if (editing) return;

    if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && key === 'y') { e.preventDefault(); redo(); return; }
    if (mod) return;

    if (play && ['ArrowRight', 'ArrowDown', 'PageDown', 'ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) {
      e.preventDefault();
      stepPlay(['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key) ? 1 : -1);
    } else if (key === 'c') {
      toggleStory();
    } else if (key === 'p') {
      play ? stopPlay() : startPlay();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
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

  // ---------- story: chapters, reading order, play ----------
  // The map layout is never touched. Chapters hold an ordered list of node ids ("beats");
  // the story shows up as markers on nodes, an ordering panel, an optional path and play mode.

  let chapters = []; // [{id, title, items: [nodeId]}]
  const storyEl = $('#story');
  const storyList = $('#story-list');
  const storyPathEl = $('#story-path');
  const playEl = $('#play');
  const storyBtn = $('#btn-story');
  const storyPrefs = (() => {
    try { return JSON.parse(localStorage.getItem('relata.story')) || {}; } catch (err) { return {}; }
  })();
  const saveStoryPrefs = () => {
    try { localStorage.setItem('relata.story', JSON.stringify(storyPrefs)); } catch (err) { /* ignore */ }
  };
  let storyReq = 0;
  let play = null; // {seq, i}

  function makeChapters(list) {
    const out = [], seen = new Set();
    for (const c of Array.isArray(list) ? list : []) {
      if (!c || typeof c !== 'object') continue;
      const id = typeof c.id === 'string' && c.id && !seen.has(c.id) ? c.id : uid();
      seen.add(id);
      const items = [];
      for (const x of Array.isArray(c.items) ? c.items : []) if (nodes.has(x) && !items.includes(x)) items.push(x);
      out.push({ id, title: typeof c.title === 'string' ? c.title.slice(0, 200) : '', items });
    }
    return out;
  }

  function sequence() {
    const seq = [];
    chapters.forEach((ch, ci) => ch.items.forEach((id, pi) => seq.push({ id, ch, ci, pi })));
    return seq;
  }

  const chapterName = (ch, ci) => ch.title.trim() || `Chapter ${ci + 1}`;

  function removeFromStory(id) {
    let hit = false;
    for (const c of chapters) {
      const i = c.items.indexOf(id);
      if (i >= 0) { c.items.splice(i, 1); hit = true; }
    }
    if (hit) scheduleStory();
  }

  function storyChanged() {
    scheduleSave();
    if (filter.chapter) applyFilter();
    if (play) { play.seq = sequence(); play.i = Math.min(play.i, play.seq.length - 1); if (play.i < 0) stopPlay(); }
    scheduleStory();
  }

  function scheduleStory() {
    if (!storyReq) storyReq = requestAnimationFrame(() => { storyReq = 0; renderStory(); });
  }

  function renderStory() {
    renderStoryMarks();
    const editingTitle = storyEl.contains(document.activeElement) && document.activeElement.classList.contains('ch-title');
    if (!storyEl.hidden && !editingTitle) renderStoryPanel();
    drawStoryPath();
    storyBtn.classList.toggle('on', !storyEl.hidden);
  }

  // Small "chapter·position" marker on each node that is part of the story.
  function renderStoryMarks() {
    const marks = new Map();
    chapters.forEach((c, ci) => c.items.forEach((id, pi) => {
      if (!marks.has(id)) marks.set(id, []);
      marks.get(id).push([ci, pi, c]);
    }));
    for (const [id, el] of nodeEls) {
      const m = marks.get(id);
      if (!m) { if (el.mark) el.mark.hidden = true; continue; }
      if (!el.mark) {
        el.mark = document.createElement('span');
        el.mark.className = 'story-mark';
        el.label.after(el.mark);
      }
      el.mark.hidden = false;
      el.mark.textContent = `${m[0][0] + 1}·${m[0][1] + 1}` + (m.length > 1 ? ` +${m.length - 1}` : '');
      el.mark.title = m.map(([ci, pi, c]) => `${chapterName(c, ci)} · beat ${pi + 1}`).join('\n');
    }
  }

  function renderStoryPanel() {
    const active = filter.chapter;
    const cur = play && play.seq[play.i];
    storyList.textContent = '';
    if (!chapters.length) {
      const p = document.createElement('p');
      p.className = 'story-empty';
      p.textContent = 'No chapters yet. Add one with +, then drag nodes from the canvas onto it.';
      storyList.appendChild(p);
      return;
    }
    chapters.forEach((c, ci) => {
      const sec = document.createElement('section');
      sec.className = 'chapter';
      sec.dataset.id = c.id;
      if (active && active.id === c.id) sec.classList.add(active.mode === 'only' ? 'active' : 'upto');
      sec.innerHTML = `<div class="ch-head" draggable="true">
          <button class="ch-num" title="Show only this chapter"></button>
          <input class="ch-title" spellcheck="false">
          <button class="ch-btn ch-upto" title="Reader's view: show only what appears up to here"><svg viewBox="0 0 20 20"><path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z"/><circle cx="10" cy="10" r="2.2"/></svg></button>
          <button class="ch-btn ch-more" title="More"><svg viewBox="0 0 20 20"><circle cx="5" cy="10" r="1.1" class="fill"/><circle cx="10" cy="10" r="1.1" class="fill"/><circle cx="15" cy="10" r="1.1" class="fill"/></svg></button>
        </div><ol class="ch-items"></ol>`;
      sec.querySelector('.ch-num').textContent = ci + 1;
      const input = sec.querySelector('.ch-title');
      input.value = c.title;
      input.placeholder = `Chapter ${ci + 1}`;
      sec.querySelector('.ch-upto').classList.toggle('on', !!active && active.id === c.id && active.mode === 'upto');
      const ol = sec.querySelector('.ch-items');
      c.items.forEach((id, pi) => {
        const n = nodes.get(id);
        const li = document.createElement('li');
        li.className = 'ch-item';
        li.draggable = true;
        li.dataset.node = id;
        li.dataset.index = pi;
        li.style.setProperty('--tc', typeColor(n.type));
        li.innerHTML = '<span class="dot"></span><span class="name"></span><button class="ch-x" title="Remove from chapter">×</button>';
        li.querySelector('.name').textContent = n.title || 'Untitled';
        if (cur && cur.ch === c && cur.pi === pi) li.classList.add('current');
        ol.appendChild(li);
      });
      if (!c.items.length) {
        const em = document.createElement('li');
        em.className = 'ch-empty';
        em.textContent = 'Drag nodes here';
        ol.appendChild(em);
      }
      storyList.appendChild(sec);
    });
  }

  function drawStoryPath() {
    const pts = [];
    if (storyPrefs.path) {
      let last = null;
      for (const b of sequence()) {
        const n = nodes.get(b.id);
        if (b.id === last || !n || n._vis === false) continue;
        last = b.id;
        const c = center(b.id);
        pts.push(`${c.x.toFixed(1)},${c.y.toFixed(1)}`);
      }
    }
    storyPathEl.setAttribute('d', pts.length > 1 ? 'M' + pts.join('L') : '');
    $('#story-path-btn').classList.toggle('on', !!storyPrefs.path);
  }

  function toggleStory(open = storyEl.hidden) {
    storyEl.hidden = !open;
    storyPrefs.open = open;
    saveStoryPrefs();
    if (open) storyEl.style.top = Math.round($('#bar-left').getBoundingClientRect().bottom + 10) + 'px';
    renderStory();
  }

  function addChapter(withNode) {
    pushHistory();
    const ch = { id: uid(), title: '', items: withNode ? [withNode] : [] };
    chapters.push(ch);
    if (storyEl.hidden) toggleStory(true);
    storyChanged();
    renderStory();
    const input = storyList.querySelector(`.chapter[data-id="${ch.id}"] .ch-title`);
    if (input) { input.focus(); input.scrollIntoView({ block: 'nearest' }); }
  }

  function deleteChapter(id) {
    const i = chapters.findIndex(c => c.id === id);
    if (i < 0) return;
    pushHistory();
    chapters.splice(i, 1);
    if (filter.chapter && filter.chapter.id === id) filter.chapter = null;
    applyFilter();
    storyChanged();
    toast('Chapter deleted — Ctrl/⌘ Z to undo');
  }

  function moveChapter(id, to) {
    const from = chapters.findIndex(c => c.id === id);
    if (from < 0) return;
    to = clamp(to, 0, chapters.length);
    if (to === from || to === from + 1) return;
    pushHistory();
    const [ch] = chapters.splice(from, 1);
    chapters.splice(from < to ? to - 1 : to, 0, ch);
    storyChanged();
  }

  // Puts a node at `index` in a chapter (moving it if it's already there).
  // `from` is the panel position it was dragged from, if any.
  function placeInChapter(nodeId, ch, index, from) {
    if (!nodes.has(nodeId) || !chapters.includes(ch)) return;
    pushHistory();
    if (from) {
      from.ch.items.splice(from.index, 1);
      if (from.ch === ch && from.index < index) index--;
    }
    const existing = ch.items.indexOf(nodeId);
    if (existing >= 0) {
      ch.items.splice(existing, 1);
      if (existing < index) index--;
    }
    ch.items.splice(clamp(index, 0, ch.items.length), 0, nodeId);
    storyChanged();
  }

  function toggleInChapter(nodeId, ch) {
    if (ch.items.includes(nodeId)) {
      pushHistory();
      ch.items = ch.items.filter(x => x !== nodeId);
      storyChanged();
    } else {
      placeInChapter(nodeId, ch, ch.items.length);
    }
  }

  function chapterItems(id) {
    if (!chapters.length) return ['-', { label: 'Start a chapter with this', action: () => addChapter(id) }];
    return [
      '-', { heading: 'In chapters' },
      ...chapters.map((c, ci) => ({ label: `${ci + 1} · ${chapterName(c, ci)}`, checked: c.items.includes(id), action: () => toggleInChapter(id, c) })),
      { label: 'New chapter with this', action: () => addChapter(id) },
    ];
  }

  function toggleChapterFilter(id, mode) {
    const same = filter.chapter && filter.chapter.id === id && filter.chapter.mode === mode;
    filter.chapter = same ? null : { id, mode };
    applyFilter();
    if (filter.chapter) fitView();
  }

  // ----- panel drag & drop (native) -----

  function itemDropAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    const sec = hit && hit.closest && hit.closest('#story .chapter');
    if (!sec) return null;
    const ch = chapters.find(c => c.id === sec.dataset.id);
    if (!ch) return null;
    const lis = [...sec.querySelectorAll('.ch-item')];
    let index = lis.length;
    for (let i = 0; i < lis.length; i++) {
      const r = lis[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) { index = i; break; }
    }
    return { sec, ch, index, lis };
  }

  function clearDropMarks() {
    for (const el of storyEl.querySelectorAll('.drop-before, .drop-after, .drop-into')) {
      el.classList.remove('drop-before', 'drop-after', 'drop-into');
    }
  }

  function showItemDrop(t) {
    clearDropMarks();
    if (!t) return;
    if (!t.lis.length) t.sec.classList.add('drop-into');
    else if (t.index < t.lis.length) t.lis[t.index].classList.add('drop-before');
    else t.lis[t.lis.length - 1].classList.add('drop-after');
  }

  function chapterDropAt(x, y) {
    const secs = [...storyList.querySelectorAll('.chapter')];
    let to = secs.length;
    for (let i = 0; i < secs.length; i++) {
      const r = secs[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) { to = i; break; }
    }
    return { to, secs };
  }

  let panelDrag = null; // {kind: 'item', ch, index, node} | {kind: 'chapter', id}

  storyList.addEventListener('dragstart', e => {
    const li = e.target.closest && e.target.closest('.ch-item');
    const head = e.target.closest && e.target.closest('.ch-head');
    if (li) {
      const ch = chapters.find(c => c.id === li.closest('.chapter').dataset.id);
      panelDrag = { kind: 'item', ch, index: +li.dataset.index, node: li.dataset.node };
    } else if (head) {
      panelDrag = { kind: 'chapter', id: head.closest('.chapter').dataset.id };
    } else return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
  });

  storyList.addEventListener('dragover', e => {
    if (!panelDrag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (panelDrag.kind === 'item') return showItemDrop(itemDropAt(e.clientX, e.clientY));
    clearDropMarks();
    const { to, secs } = chapterDropAt(e.clientX, e.clientY);
    if (!secs.length) return;
    if (to < secs.length) secs[to].classList.add('drop-before');
    else secs[secs.length - 1].classList.add('drop-after');
  });

  storyList.addEventListener('drop', e => {
    if (!panelDrag) return;
    e.preventDefault();
    const d = panelDrag;
    panelDrag = null;
    clearDropMarks();
    if (d.kind === 'item') {
      const t = itemDropAt(e.clientX, e.clientY);
      if (t) placeInChapter(d.node, t.ch, t.index, { ch: d.ch, index: d.index });
    } else {
      moveChapter(d.id, chapterDropAt(e.clientX, e.clientY).to);
    }
  });

  storyList.addEventListener('dragend', () => { panelDrag = null; clearDropMarks(); });

  // ----- panel clicks & editing -----

  storyList.addEventListener('click', e => {
    const t = e.target;
    const sec = t.closest('.chapter');
    if (!sec) return;
    const ch = chapters.find(c => c.id === sec.dataset.id);
    if (!ch) return;
    const li = t.closest('.ch-item');
    if (t.closest('.ch-x') && li) {
      pushHistory();
      ch.items.splice(+li.dataset.index, 1);
      storyChanged();
    } else if (li) {
      const at = sequence().findIndex(b => b.ch === ch && b.pi === +li.dataset.index);
      if (play && at >= 0) { play.i = at; showBeat(); } else jumpTo(li.dataset.node);
    } else if (t.closest('.ch-num')) {
      toggleChapterFilter(ch.id, 'only');
    } else if (t.closest('.ch-upto')) {
      toggleChapterFilter(ch.id, 'upto');
    } else if (t.closest('.ch-more')) {
      const ci = chapters.indexOf(ch);
      const r = t.closest('.ch-more').getBoundingClientRect();
      showMenu([
        { label: 'Play from here', action: () => startPlay(sequence().findIndex(b => b.ch === ch)) },
        { label: 'Move up', action: () => moveChapter(ch.id, ci - 1) },
        { label: 'Move down', action: () => moveChapter(ch.id, ci + 2) },
        '-',
        { label: 'Delete chapter', danger: true, action: () => deleteChapter(ch.id) },
      ], r.left, r.bottom + 6);
    }
  });

  let chapterEdit = null;
  storyList.addEventListener('focusin', e => {
    if (e.target.classList.contains('ch-title')) chapterEdit = snapshot();
  });
  storyList.addEventListener('input', e => {
    if (!e.target.classList.contains('ch-title')) return;
    const ch = chapters.find(c => c.id === e.target.closest('.chapter').dataset.id);
    if (!ch) return;
    ch.title = e.target.value.slice(0, 200);
    renderStoryMarks();
    scheduleSave();
  });
  storyList.addEventListener('focusout', e => {
    if (!e.target.classList.contains('ch-title')) return;
    const before = chapterEdit;
    chapterEdit = null;
    const id = e.target.closest('.chapter').dataset.id;
    const old = before && before.chapters.find(c => c.id === id);
    const now = chapters.find(c => c.id === id);
    if (old && now && old.title !== now.title) pushHistory(before);
    scheduleStory();
  });
  storyList.addEventListener('keydown', e => {
    if (e.target.classList.contains('ch-title') && (e.key === 'Enter' || e.key === 'Escape')) {
      e.preventDefault();
      e.stopPropagation();
      e.target.blur();
    }
  });

  $('#story-add').addEventListener('click', () => addChapter());
  $('#story-close').addEventListener('click', () => toggleStory(false));
  $('#story-play').addEventListener('click', () => (play ? stopPlay() : startPlay()));
  $('#story-path-btn').addEventListener('click', () => {
    storyPrefs.path = !storyPrefs.path;
    saveStoryPrefs();
    drawStoryPath();
  });
  storyBtn.addEventListener('click', () => toggleStory());
  window.addEventListener('resize', () => { if (!storyEl.hidden) toggleStory(true); });

  // ----- play -----

  function startPlay(from) {
    const seq = sequence();
    if (!seq.length) return toast('Add nodes to a chapter first');
    if (from == null) {
      const ci = filter.chapter ? chapters.findIndex(c => c.id === filter.chapter.id) : -1;
      from = ci >= 0 ? Math.max(0, seq.findIndex(b => b.ci >= ci)) : 0;
    }
    play = { seq, i: clamp(from, 0, seq.length - 1) };
    playEl.hidden = false;
    $('#story-play').classList.add('on');
    showBeat();
  }

  function stepPlay(d) {
    if (!play) return;
    const i = play.i + d;
    if (i < 0 || i >= play.seq.length) return;
    play.i = i;
    showBeat();
  }

  function stopPlay() {
    if (!play) return;
    play = null;
    playEl.hidden = true;
    $('#story-play').classList.remove('on');
    for (const el of nodesLayer.querySelectorAll('.play-current')) el.classList.remove('play-current');
    scheduleStory();
  }

  function showBeat() {
    const b = play.seq[play.i];
    if (!b || !nodes.has(b.id)) return stopPlay();
    for (const el of nodesLayer.querySelectorAll('.play-current')) el.classList.remove('play-current');
    jumpTo(b.id);
    nodeEls.get(b.id).root.classList.add('play-current');
    $('#play-chapter').textContent = `${b.ci + 1} · ${chapterName(b.ch, b.ci)}`;
    $('#play-title').textContent = nodes.get(b.id).title || 'Untitled';
    $('#play-count').textContent = `${play.i + 1} / ${play.seq.length}`;
    $('#play-prev').disabled = play.i === 0;
    $('#play-next').disabled = play.i === play.seq.length - 1;
    scheduleStory();
  }

  $('#play-prev').addEventListener('click', () => stepPlay(-1));
  $('#play-next').addEventListener('click', () => stepPlay(1));
  $('#play-stop').addEventListener('click', stopPlay);

  // ---------- toolbar ----------

  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  async function exportJSON() {
    flushPending();
    const data = backend.readImage ? await embeddedImages(serialize()) : serialize();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${Store.slug(project.title) || 'relata'}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // Imported files become a new project next to the existing ones.
  function importFile(file) {
    file.text().then(txt => {
      let data;
      try { data = JSON.parse(txt); } catch (err) { return toast('That file is not valid JSON'); }
      if (!data || !Array.isArray(data.nodes)) return toast('No nodes found in that file');
      const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : file.name.replace(/\.json$/i, '');
      newProject(title, data).then(() => toast(`Imported “${title}” as a new project`));
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

  // A small blocking card for the storage choice; resolves once an action succeeds.
  function showConnect({ sub, text, actions, fine }) {
    return new Promise(resolve => {
      $('#connect-sub').textContent = sub;
      $('#connect-text').textContent = text;
      $('#connect-fine').textContent = fine || '';
      const box = $('#connect-actions');
      box.textContent = '';
      actions.forEach((a, i) => {
        const b = document.createElement('button');
        b.className = 'btn' + (i === 0 ? ' primary' : '');
        b.textContent = a.label;
        b.addEventListener('click', async () => {
          if ((await a.run()) === false) return;
          connectEl.hidden = true;
          resolve();
        });
        box.appendChild(b);
      });
      connectEl.hidden = false;
    });
  }

  async function init() {
    try { document.execCommand('styleWithCSS', false, false); } catch (err) { /* ignore */ }
    buildLegend();
    centerFirst(false);
    flush();
    await Store.migrateLegacy().catch(err => console.warn(err));
    const browserProjects = await Store.browser.list().catch(() => []);
    const firstRun = !browserProjects.length && !(await Store.kvGet('dir'));
    let saved = null;
    try { saved = await Store.savedFolder(); } catch (err) { console.warn(err); }
    const useBrowser = async () => { backend = Store.browser; await openLatest(); };

    if (saved && saved.granted) {
      backend = Store.folder(saved.dir);
      await openLatest();
    } else if (saved) {
      await showConnect({
        sub: 'Welcome back.',
        text: `Your worlds are saved in the folder “${saved.dir.name}”. The browser needs your permission again to open it.`,
        actions: [
          { label: 'Reconnect folder', run: async () => {
            try { if (!(await Store.regrant(saved.dir))) return false; } catch (err) { return false; }
            backend = Store.folder(saved.dir);
            await openLatest();
          } },
          { label: 'Choose another folder', run: chooseFolder },
          { label: 'Use browser storage', run: useBrowserStorage },
        ],
        fine: 'Tip: if Chrome offers “Allow on every visit”, choose it to skip this step next time.',
      });
    } else if (firstRun && Store.folderSupported) {
      await showConnect({
        sub: 'A quiet canvas for the relationships in your world.',
        text: 'Where should your worlds be saved? Choose the “data” folder next to index.html (or the relata folder itself). Every change is then written straight into a .json file there, so nothing depends on remembering to export.',
        actions: [
          { label: 'Choose data folder', run: chooseFolder },
          { label: 'Keep in this browser', run: useBrowser },
        ],
        fine: 'You can change this later from the project menu (⌄ next to the project title).',
      });
    } else {
      await useBrowser();
    }
    if (firstRun) helpEl.hidden = false;
    if (storyPrefs.open) toggleStory(true);
    flush();
    refreshCounts();
  }

  init();
})();

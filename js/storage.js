// Persistence.
// Two interchangeable project backends with the same interface:
//   folder(dir) — .json files inside a user-chosen "data" folder (File System Access API: Chrome/Edge)
//   browser     — projects kept in IndexedDB (localStorage fallback), for browsers without folder access
// Backend interface: list() → [{id, title, modified}], read(id), write(id, data), create(title, data) → id,
//                    rename(id, title) → id, backup(id, data)
window.RelataStore = (() => {
  // ---------- tiny key/value layer (IndexedDB, falls back to localStorage) ----------

  const DB = 'relata', STORE = 'kv', LS = 'relata.';
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function request(mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    }));
  }

  async function kvGet(key) {
    try { return await request('readonly', s => s.get(key)); } catch (e) {
      try { const v = localStorage.getItem(LS + key); return v ? JSON.parse(v) : undefined; } catch (e2) { return undefined; }
    }
  }

  async function kvSet(key, value) {
    try { await request('readwrite', s => s.put(value, key)); } catch (e) {
      localStorage.setItem(LS + key, JSON.stringify(value));
    }
  }

  async function kvDel(key) {
    try { await request('readwrite', s => s.delete(key)); } catch (e) { /* ignore */ }
    try { localStorage.removeItem(LS + key); } catch (e) { /* ignore */ }
  }

  const slug = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

  // ---------- browser backend ----------

  const browser = {
    kind: 'browser',
    label: 'this browser',
    async list() { return (await kvGet('index')) || []; },
    async read(id) { return kvGet('p:' + id); },
    async write(id, data) {
      await kvSet('p:' + id, data);
      const index = (await kvGet('index')) || [];
      const meta = { id, title: data.title || 'Untitled world', modified: Date.now() };
      const i = index.findIndex(m => m.id === id);
      if (i >= 0) index[i] = meta; else index.push(meta);
      await kvSet('index', index);
    },
    async create(title, data) {
      const id = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      await this.write(id, { ...data, title });
      return id;
    },
    async rename(id) { return id; },
    async backup() {},
  };

  // ---------- folder backend ----------

  async function exists(dir, name) {
    try { await dir.getFileHandle(name); return true; } catch (e) { return false; }
  }

  async function uniqueName(dir, base, keep) {
    base = base || 'untitled';
    let name = base + '.json';
    for (let i = 2; name !== keep && await exists(dir, name); i++) name = `${base}-${i}.json`;
    return name;
  }

  async function writeFile(dir, name, text) {
    const h = await dir.getFileHandle(name, { create: true });
    const w = await h.createWritable();
    await w.write(text);
    await w.close();
  }

  function folder(dir) {
    const backupsDone = new Set();
    return {
      kind: 'folder',
      dir,
      label: dir.name,
      async list() {
        const out = [];
        for await (const [name, h] of dir.entries()) {
          if (h.kind !== 'file' || !/\.json$/i.test(name) || name.startsWith('.')) continue;
          try {
            const f = await h.getFile();
            const d = JSON.parse(await f.text());
            if (!d || !Array.isArray(d.nodes)) continue;
            const title = typeof d.title === 'string' && d.title.trim() ? d.title.trim() : name.replace(/\.json$/i, '');
            out.push({ id: name, title, modified: f.lastModified });
          } catch (e) { /* not a relata file */ }
        }
        return out;
      },
      async read(id) {
        const f = await (await dir.getFileHandle(id)).getFile();
        return JSON.parse(await f.text());
      },
      async write(id, data) {
        await writeFile(dir, id, JSON.stringify(data, null, 2));
      },
      async create(title, data) {
        const name = await uniqueName(dir, slug(title));
        await this.write(name, { ...data, title });
        return name;
      },
      // Renames the file to match the title where the browser supports it; otherwise keeps the name.
      async rename(id, title) {
        const h = await dir.getFileHandle(id);
        if (typeof h.move !== 'function') return id;
        const name = await uniqueName(dir, slug(title), id);
        if (name === id) return id;
        try { await h.move(name); return name; } catch (e) { return id; }
      },
      // Image files live in data/images/; nodes reference them as "images/<name>".
      async writeImage(name, blob) {
        const idir = await dir.getDirectoryHandle('images', { create: true });
        const h = await idir.getFileHandle(name, { create: true });
        const w = await h.createWritable();
        await w.write(blob);
        await w.close();
        return 'images/' + name;
      },
      async readImage(path) {
        const name = String(path).replace(/^images\//, '');
        const idir = await dir.getDirectoryHandle('images');
        return (await idir.getFileHandle(name)).getFile();
      },
      // One snapshot per project per day in data/backups/, keeping the 10 most recent.
      async backup(id, data) {
        const day = new Date().toISOString().slice(0, 10);
        if (backupsDone.has(id + day)) return;
        backupsDone.add(id + day);
        const base = id.replace(/\.json$/i, '');
        const bdir = await dir.getDirectoryHandle('backups', { create: true });
        await writeFile(bdir, `${base}.${day}.json`, JSON.stringify(data, null, 2));
        const mine = [];
        for await (const [name] of bdir.entries()) {
          if (name.startsWith(base + '.') && /^\d{4}-\d{2}-\d{2}\.json$/.test(name.slice(base.length + 1))) mine.push(name);
        }
        mine.sort().reverse();
        for (const name of mine.slice(10)) await bdir.removeEntry(name);
      },
    };
  }

  // ---------- folder access ----------

  const folderSupported = typeof window.showDirectoryPicker === 'function';

  // If the user picks the relata app folder itself, use (or create) its data/ subfolder.
  async function resolveDataDir(dir) {
    try { return await dir.getDirectoryHandle('data'); } catch (e) { /* none */ }
    if (await exists(dir, 'index.html')) return dir.getDirectoryHandle('data', { create: true });
    return dir;
  }

  async function pickFolder() {
    const picked = await window.showDirectoryPicker({ id: 'relata-data', mode: 'readwrite' });
    const dir = await resolveDataDir(picked);
    await kvSet('dir', dir);
    return dir;
  }

  async function savedFolder() {
    if (!folderSupported) return null;
    const dir = await kvGet('dir');
    if (!dir || typeof dir.queryPermission !== 'function') return null;
    return { dir, granted: (await dir.queryPermission({ mode: 'readwrite' })) === 'granted' };
  }

  async function regrant(dir) {
    return (await dir.requestPermission({ mode: 'readwrite' })) === 'granted';
  }

  async function forgetFolder() {
    await kvDel('dir');
  }

  // Moves a world saved by the first version (single project) into the project list.
  async function migrateLegacy() {
    let old = await kvGet('project');
    if (!old) {
      try { const s = localStorage.getItem('relata.project'); old = s ? JSON.parse(s) : null; } catch (e) { old = null; }
    }
    if (!old || !Array.isArray(old.nodes)) return;
    await browser.create(old.title || 'My world', old);
    await kvDel('project');
    try { localStorage.removeItem('relata.project'); } catch (e) { /* ignore */ }
  }

  return { browser, folder, folderSupported, pickFolder, savedFolder, regrant, forgetFolder, migrateLegacy, kvGet, kvSet, slug };
})();

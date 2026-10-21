// Local persistence: IndexedDB (roomy, handles images) with a localStorage fallback.
window.RelataStore = (() => {
  const DB = 'relata', STORE = 'kv', KEY = 'project', LS_KEY = 'relata.project';
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

  function readLocal() {
    try {
      const s = localStorage.getItem(LS_KEY);
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  }

  async function load() {
    try {
      const data = await request('readonly', s => s.get(KEY));
      return data || readLocal();
    } catch (e) {
      console.warn('IndexedDB load failed, using localStorage', e);
      return readLocal();
    }
  }

  async function save(data) {
    try {
      await request('readwrite', s => s.put(data, KEY));
    } catch (e) {
      console.warn('IndexedDB save failed, using localStorage', e);
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    }
  }

  return { load, save };
})();

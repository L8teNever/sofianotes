(() => {
  const DB_NAME = "sofianotes-off";
  const VER = 1;
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        if (!db.objectStoreNames.contains("strokes")) db.createObjectStore("strokes");
        if (!db.objectStoreNames.contains("media")) db.createObjectStore("media");
        if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function getKv(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction("kv").objectStore("kv").get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function setKv(key, value) {
    const db = await openDb();
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    return txDone(tx);
  }

  async function getStrokes(boardId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction("strokes").objectStore("strokes").get(boardId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function setStrokes(boardId, strokes) {
    const db = await openDb();
    const tx = db.transaction("strokes", "readwrite");
    tx.objectStore("strokes").put(strokes, boardId);
    return txDone(tx);
  }

  async function putMedia(id, blob) {
    const db = await openDb();
    const tx = db.transaction("media", "readwrite");
    tx.objectStore("media").put(blob, id);
    return txDone(tx);
  }

  async function getMedia(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction("media").objectStore("media").get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function enqueue(op) {
    const db = await openDb();
    const tx = db.transaction("outbox", "readwrite");
    tx.objectStore("outbox").add(op);
    return txDone(tx);
  }

  async function outboxEntries() {
    const db = await openDb();
    const store = db.transaction("outbox").objectStore("outbox");
    const values = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const keys = await new Promise((resolve, reject) => {
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    return keys.map((key, i) => ({ key, op: values[i] }));
  }

  async function outboxDelete(key) {
    const db = await openDb();
    const tx = db.transaction("outbox", "readwrite");
    tx.objectStore("outbox").delete(key);
    return txDone(tx);
  }

  async function outboxCount() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction("outbox").objectStore("outbox").count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => reject(req.error);
    });
  }

  window.SofiaOffline = {
    getKv,
    setKv,
    getStrokes,
    setStrokes,
    putMedia,
    getMedia,
    enqueue,
    outboxEntries,
    outboxDelete,
    outboxCount,
  };
})();

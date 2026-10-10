// Experimentell: Handschrift direkt auf dem Geraet erkennen (TrOCR small, deutsch, quantisiert).
// Laedt transformers.js erst beim Einschalten, das Modell kommt vom eigenen Server
// (/models/trocr-de-small) und liegt danach im Browser-Cache - erkennt dann auch offline.
// Das Modell liest eine Zeile auf einmal; mehrere Zeilen werden vorher getrennt.
(function () {
  const LIB_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.0/dist/transformers.min.js";
  const MODEL = "trocr-de-small";
  const KEY = "sofianotes-exp-local-ocr";

  let state = "off"; // off | loading | ready | error | missing
  let progress = 0;
  let errorText = "";
  let pipePromise = null;
  const listeners = new Set();

  function emit() {
    for (const fn of listeners) {
      try {
        fn({ state, progress, error: errorText });
      } catch (err) {}
    }
  }
  function enabled() {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch (err) {
      return false;
    }
  }
  async function modelAvailable() {
    try {
      const r = await fetch("/models/" + MODEL + "/config.json", { cache: "no-store" });
      return r.ok;
    } catch (err) {
      return false;
    }
  }

  function load() {
    if (pipePromise) return pipePromise;
    state = "loading";
    progress = 0;
    errorText = "";
    emit();
    pipePromise = (async () => {
      if (!(await modelAvailable())) {
        state = "missing";
        emit();
        throw new Error("missing");
      }
      const tf = await import(LIB_URL);
      tf.env.allowRemoteModels = false;
      tf.env.allowLocalModels = true;
      tf.env.localModelPath = "/models/";
      tf.env.useBrowserCache = true;
      const files = new Map();
      const pipe = await tf.pipeline("image-to-text", MODEL, {
        dtype: "q8",
        device: "wasm",
        progress_callback: (p) => {
          if (!p || !p.file) return;
          if (p.status === "progress" && p.total) files.set(p.file, { loaded: p.loaded, total: p.total });
          if (p.status === "done") {
            const f = files.get(p.file);
            if (f) f.loaded = f.total;
          }
          let loaded = 0;
          let total = 0;
          for (const f of files.values()) {
            loaded += f.loaded;
            total += f.total;
          }
          if (total) {
            progress = Math.min(0.99, loaded / total);
            emit();
          }
        },
      });
      state = "ready";
      progress = 1;
      emit();
      return pipe;
    })().catch((err) => {
      if (state !== "missing") {
        state = "error";
        errorText = String((err && err.message) || err).slice(0, 160);
      }
      pipePromise = null;
      emit();
      throw err;
    });
    return pipePromise;
  }

  // Ein Bild (Data-URL oder Canvas) mit genau einer Zeile -> Text
  async function readLine(image) {
    const pipe = await load();
    const src = typeof image === "string" ? image : image.toDataURL("image/png");
    const out = await pipe(src, { max_new_tokens: 64 });
    const t = Array.isArray(out) && out[0] ? out[0].generated_text : "";
    return String(t || "").trim();
  }

  window.SofiaLocalOcr = {
    enabled,
    setEnabled(on) {
      try {
        localStorage.setItem(KEY, on ? "1" : "0");
      } catch (err) {}
      if (on) load().catch(() => {});
      else {
        state = pipePromise ? state : "off";
        emit();
      }
    },
    status: () => ({ state, progress, error: errorText }),
    ready: () => state === "ready",
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    load,
    readLine,
  };

  // War es eingeschaltet: im Hintergrund vorladen, damit die erste Erkennung nicht wartet
  if (enabled()) setTimeout(() => load().catch(() => {}), 3000);
})();

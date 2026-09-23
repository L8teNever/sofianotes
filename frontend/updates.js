(function () {
  const banner = document.getElementById("update-banner");
  const bannerBtn = document.getElementById("btn-update-now");
  const bannerLater = document.getElementById("btn-update-later");
  const versionLabel = document.getElementById("settings-version-label");
  const commitBadge = document.getElementById("settings-commit-badge");
  const buildDateEl = document.getElementById("settings-build-date");
  const statusText = document.getElementById("settings-version-status-text");
  const statusRow = document.getElementById("settings-version-status");
  const descEl = document.getElementById("settings-update-desc");
  const checkBtn = document.getElementById("btn-check-updates");
  const applyBtn = document.getElementById("btn-apply-update");
  const checkLabel = document.getElementById("text-check-updates");

  let pendingWorker = null;
  let updateAvailable = false;
  let checking = false;

  function clientBuild() {
    return String(window.__BUILD_TS__ || "");
  }

  function clientVersion() {
    return String(window.__APP_VERSION__ || "1.0.0");
  }

  function showBanner() {
    if (banner) banner.classList.remove("hidden");
  }

  function hideBanner() {
    if (banner) banner.classList.add("hidden");
  }

  function markReady(msg) {
    updateAvailable = true;
    if (statusText) statusText.textContent = "Update verfügbar";
    if (statusRow) statusRow.classList.add("update-needed");
    if (descEl) descEl.textContent = msg || "Ein neues Update ist bereit.";
    if (applyBtn) applyBtn.classList.remove("hidden");
    showBanner();
  }

  function markCurrent(info) {
    updateAvailable = false;
    if (statusText) statusText.textContent = "Auf neuestem Stand";
    if (statusRow) statusRow.classList.remove("update-needed");
    const ver = (info && info.version) || clientVersion();
    if (descEl) descEl.textContent = "Deine Version ist aktuell (v" + ver + ").";
    if (applyBtn) applyBtn.classList.add("hidden");
    hideBanner();
  }

  function fillInfo(info) {
    if (!info) return;
    if (versionLabel) versionLabel.textContent = "v" + (info.version || clientVersion());
    if (commitBadge) commitBadge.textContent = "#" + (info.commit || "main");
    if (buildDateEl) buildDateEl.textContent = "Stand: " + (info.build_date || "unbekannt");
  }

  async function fetchVersion() {
    const res = await fetch("/api/version", { cache: "no-store" });
    if (!res.ok) throw new Error("version");
    return res.json();
  }

  async function waitingWorker() {
    if (!("serviceWorker" in navigator)) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return (reg && reg.waiting) || null;
  }

  async function applyUpdate() {
    try {
      let sw = pendingWorker || (await waitingWorker());
      if (sw) {
        sw.postMessage({ type: "SKIP_WAITING" });
      } else {
        if ("serviceWorker" in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        }
        if ("caches" in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
      }
    } catch (err) {
      /* reload anyway */
    }
    setTimeout(() => {
      window.location.reload();
    }, 400);
  }

  async function checkForUpdates(manual) {
    if (checking) return;
    checking = true;
    if (manual && checkLabel) checkLabel.textContent = "Prüfe…";
    if (manual && descEl) descEl.textContent = "Suche nach einer neuen Version…";
    try {
      let found = false;
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          const installed = new Promise((resolve) => {
            let done = false;
            const finish = () => {
              if (!done) {
                done = true;
                resolve();
              }
            };
            reg.addEventListener("updatefound", () => {
              const nw = reg.installing;
              if (!nw) {
                finish();
                return;
              }
              nw.addEventListener("statechange", () => {
                if (nw.state === "installed" || nw.state === "redundant") finish();
              });
            });
            setTimeout(finish, 4000);
          });
          await reg.update().catch(() => {});
          await installed;
          if (reg.waiting) {
            pendingWorker = reg.waiting;
            found = true;
          }
        }
      }

      const info = await fetchVersion().catch(() => null);
      fillInfo(info);
      const mine = clientBuild();
      if (
        mine &&
        mine !== "__BUILD__" &&
        info &&
        info.build_ts &&
        String(info.build_ts) !== mine
      ) {
        found = true;
      }

      if (found) {
        markReady("Neues Update verfügbar. Tippe auf „Jetzt aktualisieren“.");
      } else {
        markCurrent(info);
      }
    } catch (err) {
      if (descEl) descEl.textContent = "Update-Prüfung fehlgeschlagen.";
    } finally {
      checking = false;
      if (checkLabel) checkLabel.textContent = "Nach Updates suchen";
    }
  }

  async function loadVersionInfo() {
    if (versionLabel) versionLabel.textContent = "v" + clientVersion();
    try {
      const waiting = await waitingWorker();
      if (waiting) {
        pendingWorker = waiting;
        const info = await fetchVersion().catch(() => null);
        fillInfo(info);
        markReady("Ein neues Update ist bereits geladen.");
        return;
      }
      const info = await fetchVersion();
      fillInfo(info);
      const mine = clientBuild();
      if (
        mine &&
        mine !== "__BUILD__" &&
        info.build_ts &&
        String(info.build_ts) !== mine
      ) {
        markReady("Eine neuere Version ist auf dem Server.");
        return;
      }
      markCurrent(info);
    } catch (err) {
      if (buildDateEl) buildDateEl.textContent = "Version: v" + clientVersion();
    }
  }

  function registerWorker() {
    if (!("serviceWorker" in navigator)) return;
    let hadController = !!navigator.serviceWorker.controller;
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("/service-worker.js", { updateViaCache: "none" })
        .then((reg) => {
          if (reg.waiting) {
            pendingWorker = reg.waiting;
            markReady("Ein neues Update ist bereits geladen.");
          }
          reg.addEventListener("updatefound", () => {
            const nw = reg.installing;
            if (!nw) return;
            nw.addEventListener("statechange", () => {
              if (nw.state === "installed" && navigator.serviceWorker.controller) {
                pendingWorker = reg.waiting || nw;
                markReady("Ein neues Update ist bereit.");
              }
            });
          });
        })
        .catch(() => {});
    });

    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data && event.data.type === "SW_UPDATED") {
        markReady("Eine neue Version ist bereit.");
      }
    });

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) {
        hadController = true;
        return;
      }
      if (sessionStorage.getItem("sofianotes-reloaded")) return;
      sessionStorage.setItem("sofianotes-reloaded", "1");
      window.location.reload();
    });
  }

  if (bannerBtn) bannerBtn.addEventListener("click", (e) => {
    e.preventDefault();
    applyUpdate();
  });
  if (bannerLater) bannerLater.addEventListener("click", (e) => {
    e.preventDefault();
    hideBanner();
  });
  if (checkBtn) checkBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    checkForUpdates(true);
  });
  if (applyBtn) applyBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    applyUpdate();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForUpdates(false);
  });
  window.addEventListener("online", () => checkForUpdates(false));
  setInterval(() => {
    if (document.visibilityState === "visible") checkForUpdates(false);
  }, 5 * 60 * 1000);

  registerWorker();
  loadVersionInfo();
  window.SofiaUpdates = {
    check: () => checkForUpdates(true),
    apply: applyUpdate,
    refreshInfo: loadVersionInfo,
  };
})();

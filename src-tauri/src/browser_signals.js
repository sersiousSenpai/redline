(function () {
  if (window !== window.top || window.__redline_signals_installed) return;
  window.__redline_signals_installed = true;
  let nav = 0, pending = false;
  const revision = () => String(performance.timeOrigin) + ":" + nav;
  window.__redline_revision = revision;
  const post = (event) => {
    try { window.webkit.messageHandlers.redlineBrowser.postMessage(JSON.stringify(event)); return true; }
    catch (error) { if (event.kind === "inspect") console.error("Redline element signal failed", error); return false; }
  };
  window.__redline_signal = post;
  function state() {
    pending = false;
    post({ kind: "state", url: location.href.slice(0, 8192), title: document.title.slice(0, 512), revision: revision(), fullscreen: !!window.__redline_fs });
  }
  function schedule() { if (!pending) { pending = true; requestAnimationFrame(state); } }
  for (const name of ["pushState", "replaceState"]) {
    const original = history[name];
    history[name] = function (...args) { const result = original.apply(this, args); nav++; schedule(); return result; };
  }
  for (const name of ["popstate", "hashchange", "pageshow", "DOMContentLoaded"]) addEventListener(name, () => { nav++; schedule(); });
  let fullscreen = !!window.__redline_fs;
  try { Object.defineProperty(window, "__redline_fs", { configurable: true, get: () => fullscreen, set: (value) => { fullscreen = !!value; schedule(); } }); } catch (_) {}
  for (const [key, kind] of [["__redline_newtabs", "tabs"], ["__redline_selections", "selection"]]) {
    let values = window[key] || [];
    function wrap(array) {
      const result = Array.isArray(array) ? array : [];
      result.push = function (...items) {
        for (const item of items.slice(0, 20)) post({ kind, value: item });
        return 0;
      };
      for (const value of result.splice(0, 20)) post({ kind, value });
      return result;
    }
    values = wrap(values);
    try { Object.defineProperty(window, key, { configurable: true, get: () => values, set: (array) => { values = wrap(array); } }); } catch (_) {}
  }
  document.addEventListener("keydown", (event) => {
    if (!event.isTrusted) return;
    let value;
    if (event.key === "Escape" && !window.__redline_inspect_stop) value = "exit-focus";
    if (event.metaKey || event.ctrlKey) {
      const key = event.key.toLowerCase();
      if (key === "l") value = "location";
      if (key === "f" && event.metaKey && event.ctrlKey && window.__redline_fs) value = "toggle-video-screen";
      if (key === "t" && !event.shiftKey) value = "new-tab";
      if (key === "w" && !event.shiftKey) value = "close-tab";
      if (event.key === "Tab") value = event.shiftKey ? "previous-tab" : "next-tab";
      if (event.metaKey && event.shiftKey && (event.code === "BracketRight" || event.key === "]")) value = "next-tab";
      if (event.metaKey && event.shiftKey && (event.code === "BracketLeft" || event.key === "[")) value = "previous-tab";
    }
    if (value) { event.preventDefault(); event.stopImmediatePropagation(); post({ kind: "shortcut", value }); }
  }, true);
  let lastInput = 0;
  for (const name of ["pointerdown", "keydown", "wheel", "touchstart"]) document.addEventListener(name, (event) => {
    if (!event.isTrusted) return;
    if ((name === "wheel" || name === "touchstart") && performance.now() - lastInput < 100) return;
    lastInput = performance.now();
    post({ kind: "interaction", revision: revision() });
  }, { capture: true, passive: true });
  document.addEventListener("focusin", () => post({ kind: "focus" }), true);
  function observeTitle() {
    const title = document.querySelector("title");
    if (title) new MutationObserver(schedule).observe(title, { subtree: true, childList: true, characterData: true });
    schedule();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observeTitle, { once: true });
  else observeTitle();
})();

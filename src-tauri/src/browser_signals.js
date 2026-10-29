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
    if (!event.isTrusted || event.target?.closest?.("[data-redline-selection]")) return;
    let value;
    // The flow shell's ⌘B (sidebar) and ⌘⌥B (plan panel), matched on the
    // physical key because ⌥ rewrites event.key. Told, never taken: the page
    // keeps its own ⌘B (bold in a web editor, which is why an editable target
    // is left out entirely), and the classic shell ignores the signal.
    if (event.metaKey && !event.ctrlKey && !event.shiftKey && event.code === "KeyB") {
      const t = event.target;
      if (!(t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName || ""))) post({ kind: "shortcut", value: event.altKey ? "toggle-plan-panel" : "toggle-sidebar" });
      return;
    }
    if (event.key === "Escape" && !window.__redline_inspect_stop) value = "exit-focus";
    if (event.metaKey || event.ctrlKey) {
      const key = event.key.toLowerCase();
      if (key === "l") value = "location";
      if (key === "j" && !event.shiftKey && !event.altKey) value = "toggle-monochat";
      if (key === "f" && event.metaKey && event.ctrlKey && window.__redline_fs) value = "toggle-video-screen";
      // ⌃Tab / ⌃⇧Tab cycle the browser's PAGES (Ctrl, not ⌘: the ⌘ chords
      // below are the workbench's). ⌘T, ⌘W and ⌘⇧[ / ⌘⇧] are not forwarded:
      // they are native menu items now, and the menu takes them before the
      // page sees them.
      if (event.key === "Tab" && event.ctrlKey && !event.metaKey) value = event.shiftKey ? "previous-page" : "next-page";
      // ⌘⌥← / ⌘⌥→ — the previous / next WORKBENCH tab, an alias of the
      // menu's ⌘⇧[ / ⌘⇧] (a menu item carries one accelerator). On the
      // physical key: ⌥ rewrites event.key.
      if (event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey && (event.code === "ArrowLeft" || event.code === "ArrowRight")) value = event.code === "ArrowRight" ? "next-tab" : "previous-tab";
      // The app's globals, which no menu item carries: ⌘K the palette (over
      // the page's own ⌘K: the palette is ⌘K everywhere), ⌘⇧J the agent that
      // needs you, ⌘⇧N plan a build, ⌘⇧0 snap the layout back. ⌘ only, on
      // the physical key (⇧ rewrites event.key).
      if (event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.code === "KeyK" && !event.shiftKey) value = "palette";
        else if (event.code === "KeyJ" && event.shiftKey) value = "needs-you";
        else if (event.code === "KeyN" && event.shiftKey) value = "new-plan";
        else if (event.code === "Digit0" && event.shiftKey) value = "snap-back";
        // The workbench's pane chords (W5): ⌘\ splits right with a door,
        // ⌘⇧↩ zooms the pane. ⌘D / ⌘⇧D wait for the page (below).
        else if (event.code === "Backslash" && !event.shiftKey) value = "split-anywhere";
        else if ((event.code === "Enter" || event.code === "NumpadEnter") && event.shiftKey) value = "zoom-pane";
      }
      // ⌘⌥= evens the tab's splits; ⌃⌘ + an arrow focuses the pane that way
      // (⌘⌥↑ / ⌘⌥↓ stay the page's). On the physical key: ⌥ rewrites key.
      if (event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey && (event.code === "Equal" || event.code === "NumpadEqual")) value = "equalize";
      if (event.metaKey && event.ctrlKey && !event.altKey && !event.shiftKey) {
        const focus = { ArrowLeft: "focus-left", ArrowRight: "focus-right", ArrowUp: "focus-up", ArrowDown: "focus-down" }[event.code];
        if (focus) value = focus;
      }
    }
    if (value) { event.preventDefault(); event.stopImmediatePropagation(); post({ kind: "shortcut", value }); }
  }, true);
  // ⌘D / ⌘⇧D split the pane right / down — unless the page took the key
  // itself (a web editor's ⌘D): heard after the page's own handlers, on the
  // way out, and only when nobody prevented its default.
  window.addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.defaultPrevented || event.target?.closest?.("[data-redline-selection]")) return;
    if (!event.metaKey || event.ctrlKey || event.altKey || event.code !== "KeyD") return;
    event.preventDefault();
    post({ kind: "shortcut", value: event.shiftKey ? "split-down" : "split" });
  });
  let lastInput = 0;
  // A pointerup too: a drag that began in Redline's own document and was
  // let go over this page never hears its release otherwise (LAST2).
  for (const name of ["pointerdown", "pointerup", "keydown", "wheel", "touchstart"]) document.addEventListener(name, (event) => {
    if (!event.isTrusted) return;
    if ((name === "wheel" || name === "touchstart") && performance.now() - lastInput < 100) return;
    lastInput = performance.now();
    // Named, so a press can dismiss the island's card and a scroll cannot.
    post({ kind: "interaction", value: name, revision: revision() });
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

// Installed in every frame: keyboard events inside an iframe do not bubble
// to the top page. This script only forwards the explicit front-door chord,
// and never from a text field, where it is the page's own newline — and, from
// a sub-frame, that it was pressed, which the page's own signals (main frame
// only) never hear: a press anywhere in the page puts the island's card away.
(function () {
  if (window.__redline_frontdoor_shortcut_installed) return;
  window.__redline_frontdoor_shortcut_installed = true;
  if (window.top !== window) for (const name of ["pointerdown", "touchstart"]) window.addEventListener(name, (event) => {
    if (!event.isTrusted) return;
    try {
      window.webkit.messageHandlers.redlineBrowser.postMessage(JSON.stringify({ kind: "interaction", value: name }));
    } catch (_) {}
  }, { capture: true, passive: true });
  window.addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.isComposing || event.keyCode === 229) return;
    if (event.key !== "Enter" || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    // The field itself, even inside a web component (the window sees only
    // its host), and a custom editor that says it is a text box.
    const target = (event.composedPath && event.composedPath()[0]) || event.target;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || "") || (target.closest && target.closest('[role="textbox"]')))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    try {
      window.webkit.messageHandlers.redlineBrowser.postMessage(JSON.stringify({ kind: "shortcut", value: "open-front-door" }));
    } catch (_) {}
  }, true);
})();

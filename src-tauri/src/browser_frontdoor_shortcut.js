// Installed in every frame: keyboard events inside an iframe do not bubble
// to the top page. This script only forwards the explicit front-door chord.
(function () {
  if (window.__redline_frontdoor_shortcut_installed) return;
  window.__redline_frontdoor_shortcut_installed = true;
  window.addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.isComposing || event.keyCode === 229) return;
    if (event.key !== "Enter" || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    try {
      window.webkit.messageHandlers.redlineBrowser.postMessage(JSON.stringify({ kind: "shortcut", value: "open-front-door" }));
    } catch (_) {}
  }, true);
})();

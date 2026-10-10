// Installed in every frame: keyboard events inside an iframe do not bubble
// to the top page. This script only forwards the explicit front-door chord,
// and never from a text field, where it is the page's own newline — and, from
// a sub-frame, that it was pressed, which the page's own signals (main frame
// only) never hear: a press anywhere in the page puts the island's card away.
// And the hold-to-dictate key's presses, which Redline's window never hears
// (src/audio/voiceHotkey.ts reads them); never keeping a key from the page.
(function () {
  if (window.__redline_frontdoor_shortcut_installed) return;
  window.__redline_frontdoor_shortcut_installed = true;
  const post = (kind, value) => {
    try {
      window.webkit.messageHandlers.redlineBrowser.postMessage(JSON.stringify({ kind, value }));
    } catch (_) {}
  };
  const holdKeys = { AltRight: "altKey", MetaRight: "metaKey", ControlRight: "ctrlKey" };
  let held = null;
  for (const name of ["pointerdown", "touchstart"]) window.addEventListener(name, (event) => {
    if (!event.isTrusted) return;
    // With the dictation key down, the key modifies the press: no dictation.
    if (held) post("voice", "other");
    if (window.top !== window) post("interaction", name);
  }, { capture: true, passive: true });
  window.addEventListener("keydown", (event) => {
    if (!event.isTrusted) return;
    // The field itself, even inside a web component (the window sees only
    // its host).
    const target = (event.composedPath && event.composedPath()[0]) || event.target;
    const own = holdKeys[event.code];
    if (own) {
      if (event.repeat || held) return;
      held = event.code;
      const alone = !event.shiftKey && !event.isComposing && ["altKey", "metaKey", "ctrlKey"].every((flag) => flag === own || !event[flag]);
      // Redline can type only into the main frame.
      const field = window.top === window && !!target && (target.isContentEditable || target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && typeof target.selectionStart === "number"));
      post("voice", alone ? (field ? "field:" : "down:") + event.code : "other");
      return;
    }
    if (held) post("voice", "other");
    else if (event.key === "Escape" && !event.isComposing) post("voice", "escape");
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key !== "Enter" || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    // A custom editor that says it is a text box counts as a field too.
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || "") || (target.closest && target.closest('[role="textbox"]')))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    post("shortcut", "open-front-door");
  }, true);
  window.addEventListener("keyup", (event) => {
    if (!event.isTrusted || event.code !== held) return;
    held = null;
    post("voice", "up");
  }, true);
  window.addEventListener("blur", () => {
    if (!held) return;
    held = null;
    post("voice", "up");
  });
})();

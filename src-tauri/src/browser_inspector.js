(function () {
  if (window.__redline_inspect_stop) { window.__redline_inspect_stop(); return; }
  window.__redline_inspect_status = { state: "picking", at: Date.now() };
  let selected = null, frame = 0, point = null;
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:absolute;left:0;top:0;z-index:2147483647;pointer-events:none";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = '<style>:host{all:initial}div{position:absolute;box-sizing:border-box;border:2px solid #589dff;background:#589dff15;pointer-events:none}span{position:absolute;background:#173759;color:white;font:12px/1.4 system-ui;padding:4px 8px;border-radius:4px;white-space:nowrap}</style><div></div><span></span>';
  const box = root.querySelector("div"), caption = root.querySelector("span");
  document.documentElement.appendChild(host);
  // Build structural selectors without depending on page text or class churn.
  function structural(element) {
    const owner = element.getRootNode();
    const resolves = (selector) => { const matches = owner.querySelectorAll(selector); return matches.length === 1 && matches[0] === element; };
    if (element.id && resolves("#" + CSS.escape(element.id))) return "#" + CSS.escape(element.id);
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && parts.length < 64; node = node.parentElement) {
      let segment = node.localName;
      if (node.parentElement) segment += ":nth-of-type(" + ([...node.parentElement.children].filter((child) => child.localName === node.localName).indexOf(node) + 1) + ")";
      parts.unshift(segment);
      if (resolves(parts.join(" > "))) return parts.join(" > ");
    }
    return null;
  }
  function sanitized(element) {
    const clone = element.cloneNode(true);
    for (const field of [clone, ...clone.querySelectorAll("input,textarea,select,option,[contenteditable]")]) {
      if (field.matches?.("input,textarea,select,option,[contenteditable]")) {
        for (const attribute of ["value", "checked", "selected", "aria-valuenow", "aria-valuetext"]) field.removeAttribute(attribute);
        if (field.matches("input,textarea,[contenteditable]:not([contenteditable='false'])")) field.textContent = "";
      }
    }
    if (element.closest("[contenteditable]:not([contenteditable='false'])")) clone.textContent = "";
    return clone;
  }
  function name(element) {
    const explicit = element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("title");
    if (explicit) return explicit.trim().slice(0, 160);
    if (element.closest("input,textarea,[contenteditable]:not([contenteditable='false'])")) return element.localName;
    // Hover must not clone a whole page or expose descendant editable values.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text = "", visited = 0, node;
    while (text.length < 160 && visited++ < 200 && (node = walker.nextNode())) {
      if (!node.parentElement?.closest("input,textarea,script,style,[contenteditable]:not([contenteditable='false'])")) text += node.textContent.slice(0, 160 - text.length);
    }
    return text.trim() || element.localName;
  }
  function highlight(element) {
    if (!element || element === host) return;
    selected = element;
    const r = element.getBoundingClientRect();
    box.style.cssText = `left:${r.left + scrollX}px;top:${r.top + scrollY}px;width:${r.width}px;height:${r.height}px`;
    caption.style.left = Math.max(scrollX, r.left + scrollX) + "px";
    caption.style.top = Math.max(scrollY, r.top + scrollY - 32) + "px";
    caption.textContent = `${element.localName} · ${name(element)} · ↑ parent / ↓ child · click to attach · Esc exit`;
  }
  function move(event) { point = [event.clientX, event.clientY]; if (!frame) frame = requestAnimationFrame(() => { frame = 0; let el = document.elementFromPoint(...point); while (el?.shadowRoot?.elementFromPoint(...point)) { const child = el.shadowRoot.elementFromPoint(...point); if (child === el) break; el = child; } highlight(el); }); }
  function stop(state = "cancelled") { window.__redline_inspect_status = { state, at: Date.now() }; cancelAnimationFrame(frame); host.remove(); document.removeEventListener("pointermove", move, true); document.removeEventListener("click", click, true); document.removeEventListener("keydown", key, true); document.removeEventListener("scroll", refresh, true); window.__redline_inspect_stop = null; }
  function capture(element) {
    const r = element.getBoundingClientRect(), owner = element.getRootNode();
    const clone = sanitized(element), selector = structural(element);
    return { url: location.href.slice(0, 8192), title: document.title.slice(0, 512), revision: window.__redline_revision?.() || String(performance.timeOrigin), selectors: selector ? [selector] : [], accessibleName: name(element), tag: element.localName,
      frame: "top", shadow: owner instanceof ShadowRoot ? structural(owner.host) : null,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height }, viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY }, zoom: visualViewport?.scale || 1,
      markup: clone.outerHTML.slice(0, 4000), capturedAt: Date.now(), limitation: !selector ? "No unique bounded selector; inspect the target again before acting." : element.matches("iframe,canvas") ? "Container selection; inner content is not accessible." : owner instanceof ShadowRoot ? "Selection inside an open shadow root; resolve through its host." : null };
  }
  function click(event) {
    const element = selected || event.composedPath().find(node => node instanceof Element && node !== host);
    if (!element) return;
    event.preventDefault(); event.stopImmediatePropagation();
    window.__redline_inspect_status = { state: "pending", at: Date.now() };
    try {
      if (typeof window.__redline_signal !== "function" || window.__redline_signal({ kind: "inspect", value: capture(element) }) !== true) throw new Error("Page signal transport unavailable");
      stop("sent");
    } catch (error) { console.error("Redline element picking failed", error); stop("error"); }
  }
  function key(event) { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); stop(); } else if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); event.stopImmediatePropagation(); highlight(event.key === "ArrowUp" ? selected?.parentElement : selected?.firstElementChild); } }
  function refresh() { if (selected) highlight(selected); }
  document.addEventListener("pointermove", move, true); document.addEventListener("click", click, true); document.addEventListener("keydown", key, true); document.addEventListener("scroll", refresh, true);
  window.__redline_inspect_stop = stop;
})();

// SPDX-License-Identifier: Apache-2.0
(function () {
  if (window.__redline_fs_installed) return;
  window.__redline_fs_installed = true;
  var PIN = '__redline_fs_pin__', IPIN = '__redline_fs_iframe__';
  var tracked = null, pinnedIframes = [], lifted = [], watchdog = null, hint = null, hintTimer = null;
  var css = '.' + PIN + ',.' + IPIN + '{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;z-index:2147483647!important;margin:0!important;background:#000!important;transform:none!important;filter:none!important;-webkit-filter:none!important;}' +
    '.' + IPIN + '{border:0!important;}' +
    'html.__redline_fs_on,html.__redline_fs_on body{filter:none!important;-webkit-filter:none!important;overflow:hidden!important;}' +
    'html.__redline_fs_on :is(img,picture,video,canvas,svg,iframe,embed,object),.' + PIN + ' :is(img,picture,video,canvas,svg,iframe,embed,object){filter:none!important;-webkit-filter:none!important;}' +
    '[data-rl-fs-lift]{transform:none!important;filter:none!important;-webkit-filter:none!important;perspective:none!important;contain:none!important;will-change:auto!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;content-visibility:visible!important;}' ;
  function isTop() { return window === window.top; }
  function current() { return tracked || pinnedIframes[pinnedIframes.length - 1] || null; }
  function ensureStyle(root) {
    root = root || document;
    if (root.querySelector('#__redline_fs__')) return;
    var style = document.createElement('style'); style.id = '__redline_fs__'; style.textContent = css;
    (root === document ? document.head || document.documentElement : root).appendChild(style);
  }
  function parentOf(el) { return el.parentElement || (el.getRootNode && el.getRootNode().host) || null; }
  function lift(el) {
    ensureStyle();
    for (var node = el; node; node = parentOf(node)) {
      var root = node.getRootNode(); if (root !== document) ensureStyle(root);
      if (node === el) continue;
      var style = getComputedStyle(node);
      if ([style.transform, style.filter, style.perspective, style.backdropFilter, style.webkitBackdropFilter].some(function (value) { return value && value !== 'none'; }) ||
          /layout|paint|strict|content/.test(style.contain || '') || /transform|filter|perspective|contain/.test(style.willChange || '') || style.contentVisibility === 'auto') {
        if (!lifted.some(function (entry) { return entry.el === node; })) { lifted.push({ el: node, previous: node.getAttribute('data-rl-fs-lift') }); node.setAttribute('data-rl-fs-lift', ''); }
      }
    }
  }
  function fire(el) {
    var target = el && el.isConnected ? el : document;
    target.dispatchEvent(new Event('fullscreenchange', { bubbles: true }));
    target.dispatchEvent(new Event('webkitfullscreenchange', { bubbles: true }));
  }
  function notifyParent(value) { if (!isTop()) try { window.parent.postMessage({ __rl_fs: value }, '*'); } catch (_) {} }
  function refresh() {
    var on = !!current();
    document.documentElement.classList.toggle('__redline_fs_on', on);
    if (isTop()) window.__redline_fs = on;
    if (on && !watchdog) watchdog = setInterval(function () {
      if (tracked && !tracked.isConnected || pinnedIframes.some(function (frame) { return !frame.isConnected; })) exitAll(false);
    }, 1000);
    if (!on) {
      clearInterval(watchdog); watchdog = null;
      clearTimeout(hintTimer); if (hint) hint.remove(); hint = null;
      lifted.forEach(function (entry) { if (entry.previous === null) entry.el.removeAttribute('data-rl-fs-lift'); else entry.el.setAttribute('data-rl-fs-lift', entry.previous); }); lifted = [];
    }
  }
  function showHint() {
    clearTimeout(hintTimer); if (hint) hint.remove();
    hint = document.createElement('div');
    hint.style.cssText = 'all:initial!important;position:fixed!important;top:20px!important;left:0!important;width:100%!important;z-index:2147483647!important;pointer-events:none!important;';
    var shadow = hint.attachShadow({ mode: 'closed' });
    var pill = document.createElement('div');
    pill.style.cssText = 'width:max-content;max-width:90%;margin:auto;padding:9px 16px;border-radius:20px;background:#222e;color:white;font:13px -apple-system,system-ui,sans-serif;text-align:center;pointer-events:none';
    pill.textContent = 'Press Esc to exit · ⌃⌘F for full screen'; shadow.appendChild(pill);
    document.documentElement.appendChild(hint);
    hintTimer = setTimeout(function () { if (hint) hint.remove(); hint = null; }, 2500);
  }
  function exitAll(fromParent) {
    var previous = current();
    if (tracked) tracked.classList.remove(PIN);
    tracked = null;
    var frames = pinnedIframes; pinnedIframes = [];
    frames.forEach(function (frame) {
      frame.classList.remove(IPIN);
      try { frame.contentWindow.postMessage({ __rl_fs: 'force-exit' }, '*'); } catch (_) {}
    });
    refresh();
    if (previous) { if (!fromParent) notifyParent('exit'); fire(previous); }
  }
  function enterEl(el) {
    el = el || document.documentElement;
    if (tracked === el) return;
    if (current()) exitAll(true);
    tracked = el; lift(el); el.classList.add(PIN);
    refresh(); notifyParent('enter'); fire(el); showHint();
  }
  function defGet(obj, name, fn) { try { Object.defineProperty(obj, name, { configurable: true, get: fn }); } catch (_) {} }
  window.__redline_fs_exit = function () { exitAll(false); };
  Element.prototype.requestFullscreen = function () { enterEl(this); return Promise.resolve(); };
  Element.prototype.webkitRequestFullscreen = Element.prototype.webkitRequestFullScreen = function () { enterEl(this); };
  document.exitFullscreen = function () { exitAll(false); return Promise.resolve(); };
  document.webkitExitFullscreen = document.webkitCancelFullScreen = function () { exitAll(false); };
  ['fullscreenElement', 'webkitFullscreenElement', 'webkitCurrentFullScreenElement'].forEach(function (key) { defGet(document, key, current); });
  ['fullscreen', 'webkitIsFullScreen'].forEach(function (key) { defGet(document, key, function () { return !!current(); }); });
  ['fullscreenEnabled', 'webkitFullscreenEnabled'].forEach(function (key) { defGet(document, key, function () { return true; }); });
  if (typeof HTMLVideoElement !== 'undefined') {
    var proto = HTMLVideoElement.prototype;
    var originalMode = proto.webkitSetPresentationMode;
    var originalExit = proto.webkitExitFullscreen || proto.webkitExitFullScreen;
    var modeGetter = Object.getOwnPropertyDescriptor(proto, 'webkitPresentationMode');
    var redirectingNative = false;
    proto.webkitEnterFullscreen = proto.webkitEnterFullScreen = function () { enterEl(this); };
    proto.webkitExitFullscreen = proto.webkitExitFullScreen = function () { if (tracked === this) exitAll(false); };
    defGet(proto, 'webkitSupportsFullscreen', function () { return true; });
    defGet(proto, 'webkitDisplayingFullscreen', function () { return tracked === this; });
    defGet(proto, 'webkitPresentationMode', function () { return tracked === this ? 'fullscreen' : modeGetter && modeGetter.get ? modeGetter.get.call(this) : 'inline'; });
    proto.webkitSetPresentationMode = function (mode) {
      if (mode === 'fullscreen') enterEl(this);
      else if (mode === 'inline') { if (tracked === this) exitAll(false); if (originalMode) originalMode.call(this, mode); }
      else { if (tracked === this) exitAll(false); if (originalMode) return originalMode.call(this, mode); }
    };
    function nativeFullscreen(event) {
      var video = event.target;
      if (redirectingNative || !(video instanceof HTMLVideoElement)) return;
      var nativeMode = modeGetter && modeGetter.get ? modeGetter.get.call(video) : video.webkitPresentationMode;
      if (event.type !== 'webkitbeginfullscreen' && nativeMode !== 'fullscreen') return;
      redirectingNative = true;
      try { if (originalMode) originalMode.call(video, 'inline'); else if (originalExit) originalExit.call(video); } catch (_) {}
      redirectingNative = false;
      enterEl(video);
    }
    document.addEventListener('webkitbeginfullscreen', nativeFullscreen, true);
    document.addEventListener('webkitpresentationmodechanged', nativeFullscreen, true);
  }
  window.addEventListener('keydown', function (event) {
    if ((event.key === 'Escape' || event.keyCode === 27) && current()) {
      event.preventDefault(); event.stopImmediatePropagation(); exitAll(false);
    }
  }, true);
  window.addEventListener('message', function (event) {
    var data = event && event.data;
    if (!data) return;
    if (data.__rl_fs === 'force-exit') { if (!isTop() && event.source === window.parent) exitAll(true); return; }
    if (data.__rl_fs !== 'enter' && data.__rl_fs !== 'exit') return;
    var frames = document.querySelectorAll('iframe'), match = null;
    for (var i = 0; i < frames.length; i++) if (frames[i].contentWindow === event.source) { match = frames[i]; break; }
    if (!match) return;
    if (data.__rl_fs === 'enter') {
      if (pinnedIframes.indexOf(match) !== -1) return;
      if (current()) exitAll(true);
      lift(match); match.classList.add(IPIN); pinnedIframes.push(match);
      refresh(); notifyParent('enter'); fire(match);
    } else if (pinnedIframes.indexOf(match) !== -1) { exitAll(false); }
  });
  window.addEventListener('pagehide', function () { exitAll(false); });
  // Single-page navigations can remove the player without unloading the frame.
  ['popstate', 'hashchange'].forEach(function (name) { window.addEventListener(name, function () { exitAll(false); }); });
})();

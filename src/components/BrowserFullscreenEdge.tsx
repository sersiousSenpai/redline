// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { Maximize2, X } from "lucide-react";

export function BrowserFullscreenEdge({ title, onScreen, onExit }: { title: string; onScreen: () => void; onExit: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const edge = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const open = () => { clearTimeout(timer.current); setExpanded(true); };
  const close = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (!edge.current?.contains(document.activeElement)) setExpanded(false); }, 700);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return <div ref={edge} className="rb-fullscreen-edge" data-expanded={expanded || undefined}
    onPointerEnter={open} onPointerLeave={close} onFocus={open} onBlur={close}
    role="toolbar" aria-label="Video fullscreen controls" tabIndex={0}>
    <span className="rb-fullscreen-title">{title}</span>
    <button type="button" onClick={onScreen}><Maximize2 size={13}/> Full screen <kbd>⌃⌘F</kbd></button>
    <button type="button" onClick={onExit}><X size={14}/> Exit <kbd>Esc</kbd></button>
  </div>;
}

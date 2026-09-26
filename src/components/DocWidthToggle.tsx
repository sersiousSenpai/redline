import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronsLeftRight, ChevronsRightLeft } from "lucide-react";
import { ZoomButton } from "./ZoomButton";
import { docArticleWidth, docMeasureDrag, docMeasureSettle, docMeasureStart, DOC_MEASURE_MIN } from "../lib/docControl";
import { rafCoalesce } from "../lib/raf";
import { beginResizeSession, endResizeSession } from "../lib/resizeSession";

export function DocWidthToggle({ wide, measure, articleRef, onToggle, onCommit }: {
  wide: boolean;
  measure: number;
  articleRef: RefObject<HTMLElement | null>;
  onToggle: () => void;
  onCommit: (value: { wide: boolean; measure: number }) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const chip = useRef<HTMLSpanElement>(null);
  const cancel = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => () => cancel.current?.(), []);

  return <span style={{ position: "relative", display: "flex" }}>
    <ZoomButton
      active={wide}
      label={wide ? <ChevronsRightLeft size={12} strokeWidth={2} /> : <ChevronsLeftRight size={12} strokeWidth={2} />}
      title={`${wide ? "Narrow view — your reading column" : "Wide view — fill the pane with text"} — hold and drag ↕ to adjust`}
      style={{ touchAction: "none", cursor: dragging ? "ns-resize" : "pointer" }}
      onClick={(e) => {
        if (suppressClick.current && e.detail !== 0) { suppressClick.current = false; return; }
        suppressClick.current = false;
        onToggle();
      }}
      onPointerDown={(e) => {
        if (e.button !== 0 || cancel.current) return;
        suppressClick.current = false;
        const button = e.currentTarget;
        const article = articleRef.current;
        const parent = article?.parentElement;
        const css = parent ? getComputedStyle(parent) : null;
        const full = parent ? Math.floor(parent.clientWidth - (parseFloat(css!.paddingLeft) || 0) - (parseFloat(css!.paddingRight) || 0)) : 0;
        const enabled = !!article && full > DOC_MEASURE_MIN;
        const t0 = docMeasureStart({ wide, measure, full });
        const startY = e.clientY;
        const pointerId = e.pointerId;
        let active = false, moved = false, held = false, done = false;
        let last = docMeasureDrag({ t0, dy: 0, full });
        const previousCursor = document.documentElement.style.cursor;
        const apply = (atMax: boolean, px: number) => {
          if (article) Object.assign(article.style, docArticleWidth(atMax, px));
        };
        const draw = rafCoalesce(() => {
          apply(last.atMax, last.px);
          if (chip.current) chip.current.textContent = last.atMax ? "Full width" : last.atMin ? "Narrow" : `${last.px}px`;
        });
        const start = () => {
          held = true;
          suppressClick.current = true;
          if (!enabled || active) return;
          active = true;
          beginResizeSession();
          setDragging(true);
          document.documentElement.style.cursor = "ns-resize";
          if (chip.current) chip.current.textContent = wide ? "Full width" : measure <= DOC_MEASURE_MIN ? "Narrow" : `${Math.min(measure, full)}px`;
        };
        const timer = window.setTimeout(start, 250);
        const finish = (revert: boolean) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", abort);
          window.removeEventListener("keydown", key, true);
          window.removeEventListener("blur", abort);
          button.removeEventListener("lostpointercapture", abort);
          if (button.hasPointerCapture?.(pointerId)) button.releasePointerCapture(pointerId);
          if (revert) { draw.cancel(); if (active) apply(wide, measure); }
          else if (active && moved) { draw.flush(); onCommit(docMeasureSettle(last.px, full, measure)); }
          else draw.cancel();
          if (active) { document.documentElement.style.cursor = previousCursor; endResizeSession(); setDragging(false); }
          suppressClick.current = held || moved || revert;
          cancel.current = null;
        };
        const move = (ev: PointerEvent) => {
          if (ev.pointerId !== pointerId) return;
          const dy = ev.clientY - startY;
          if (Math.abs(dy) >= 4) { moved = true; start(); }
          if (active && dy !== 0) { moved = true; last = docMeasureDrag({ t0, dy, full }); draw(); }
        };
        const up = (ev: PointerEvent) => { if (ev.pointerId === pointerId) { move(ev); finish(false); } };
        const abort = () => finish(true);
        const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopImmediatePropagation(); finish(true); } };
        cancel.current = abort;
        button.setPointerCapture?.(pointerId);
        button.addEventListener("lostpointercapture", abort);
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", abort);
        window.addEventListener("keydown", key, true);
        window.addEventListener("blur", abort);
      }}
    />
    <span ref={chip} role="status" hidden={!dragging} style={{ position: "absolute", right: 30, top: -2, whiteSpace: "nowrap", padding: "3px 7px", borderRadius: 8, fontSize: 11, background: "var(--color-paper)", color: "var(--color-ink)", border: "1px solid var(--color-rule)", pointerEvents: "none" }} />
  </span>;
}

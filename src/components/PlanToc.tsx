// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useMemo, useRef, useState } from "react";
import type { Section } from "../types";

// A table of contents for the plan. It walks the already-computed heading tree
// (`Revision.sections`) — no markdown re-parsing — and scrolls the matching
// block into view by the `data-anchor-id` the editor already stamps on every
// top-level block (see docModel.applyAnchorIds). Presentational + self-scoped,
// so the share viewer (which also renders `.rl-prose`) reuses it verbatim by
// passing its own `scopeSelector`.

interface TocItem {
  anchorId: string;
  title: string;
  /** Nesting depth in the heading tree (0 = top level), for indentation. */
  depth: number;
}

// Flatten the section tree to a render list, carrying depth. Sections with an
// empty title (e.g. a synthetic pre-heading root) are skipped but still
// recursed into, so their real sub-headings still appear.
function flatten(sections: Section[], depth: number, out: TocItem[]): void {
  for (const s of sections) {
    const title = s.title.trim();
    if (title) {
      out.push({ anchorId: s.anchorId, title, depth });
      flatten(s.children, depth + 1, out);
    } else {
      // No heading text here — keep children at the same depth.
      flatten(s.children, depth, out);
    }
  }
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/["\\\n]/g, "\\$&");
}

interface PlanTocProps {
  sections: Section[];
  /** Container holding the rendered plan (where `data-anchor-id` lives).
   *  Defaults to the app's center document column. The viewer overrides it. */
  scopeSelector?: string;
}

export function PlanToc({
  sections,
  scopeSelector = ".doc-article",
}: PlanTocProps) {
  const items = useMemo(() => {
    const out: TocItem[] = [];
    flatten(sections, 0, out);
    return out;
  }, [sections]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  // While a click-triggered smooth scroll is in flight, the scrollspy must not
  // fight it: the animation passes through intermediate headings and would
  // flicker the highlight between them and the target. Lock the active id to
  // the clicked heading until the scroll settles.
  const lockedRef = useRef(false);
  const lockTimerRef = useRef<number | null>(null);

  const scrollTo = (anchorId: string) => {
    const scope = document.querySelector(scopeSelector);
    const el = scope?.querySelector(`[data-anchor-id="${cssEscape(anchorId)}"]`);
    if (el instanceof HTMLElement) {
      setActiveId(anchorId);
      lockedRef.current = true;
      if (lockTimerRef.current !== null) clearTimeout(lockTimerRef.current);
      // Release after the smooth scroll has had time to settle. `scrollend`
      // isn't in every engine, so a timeout is the portable backstop.
      lockTimerRef.current = window.setTimeout(() => {
        lockedRef.current = false;
        lockTimerRef.current = null;
      }, 700);
      el.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  };

  useEffect(
    () => () => {
      if (lockTimerRef.current !== null) clearTimeout(lockTimerRef.current);
    },
    [],
  );

  // Scrollspy: highlight the heading the reader is currently under. Driven by
  // scroll-position math (not IntersectionObserver's rootMargin trick, which
  // can never activate the last heading once you reach the bottom — there's no
  // more scroll left to push it into the "active" band). The active heading is
  // the last one whose top has crossed an activation line just below the pane
  // top; and when the pane is scrolled to the very bottom we force the LAST
  // heading active, so scrolling to the end always lights up the final section.
  useEffect(() => {
    if (items.length === 0) return;
    if (typeof window === "undefined") return; // SSR / test env
    const scope = document.querySelector<HTMLElement>(scopeSelector);
    if (!scope) return;

    // Find the nearest scrollable ancestor of the rendered plan.
    let node: HTMLElement | null = scope;
    let container: HTMLElement | null = null;
    while (node && node !== document.body) {
      const oy = getComputedStyle(node).overflowY;
      if (oy === "auto" || oy === "scroll") {
        container = node;
        break;
      }
      node = node.parentElement;
    }
    const target: HTMLElement | Window = container ?? window;

    const compute = () => {
      if (lockedRef.current) return; // a click-scroll owns the highlight
      const rows = items
        .map((it) => ({
          id: it.anchorId,
          el: scope.querySelector<HTMLElement>(
            `[data-anchor-id="${cssEscape(it.anchorId)}"]`,
          ),
        }))
        .filter((r): r is { id: string; el: HTMLElement } => !!r.el);
      if (rows.length === 0) return;

      // At the bottom of the scroll region, the last heading is active.
      const atBottom = container
        ? container.scrollTop + container.clientHeight >=
          container.scrollHeight - 4
        : window.innerHeight + window.scrollY >=
          document.documentElement.scrollHeight - 4;
      if (atBottom) {
        setActiveId(rows[rows.length - 1].id);
        return;
      }

      // Otherwise: the last heading whose top has passed the activation line
      // (a little below the pane's top edge).
      const paneTop = container ? container.getBoundingClientRect().top : 0;
      const activationLine = paneTop + 96;
      let active = rows[0].id;
      for (const { id, el } of rows) {
        if (el.getBoundingClientRect().top <= activationLine) active = id;
        else break;
      }
      setActiveId(active);
    };

    // Coalesce scroll bursts to one measure per frame.
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        compute();
      });
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    compute();
    return () => {
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [items, scopeSelector]);

  if (items.length === 0) {
    return (
      <div
        className="font-sans"
        style={{
          padding: "16px 14px",
          fontSize: "12px",
          color: "var(--color-ink-muted)",
        }}
      >
        No headings in this plan yet.
      </div>
    );
  }

  return (
    <nav
      ref={navRef}
      aria-label="Table of contents"
      className="font-sans"
      style={{ padding: "8px 6px", overflowY: "auto" }}
    >
      {items.map((it) => {
        const active = it.anchorId === activeId;
        return (
          <button
            key={it.anchorId}
            type="button"
            onClick={() => scrollTo(it.anchorId)}
            title={it.title}
            className="rl-toc-item w-full text-left"
            style={{
              display: "block",
              width: "100%",
              paddingTop: "3px",
              paddingBottom: "3px",
              paddingRight: "8px",
              paddingLeft: `${8 + it.depth * 12}px`,
              fontSize: it.depth === 0 ? "12.5px" : "12px",
              fontWeight: it.depth === 0 ? 600 : 400,
              lineHeight: 1.35,
              cursor: "pointer",
              background: "transparent",
              border: "none",
              borderLeft: active
                ? "2px solid var(--color-info)"
                : "2px solid transparent",
              color: active ? "var(--color-info)" : "var(--color-ink)",
              opacity: active ? 1 : it.depth === 0 ? 0.95 : 0.75,
              // Color-only tween (no transform/opacity-of-large-surface) so the
              // active highlight glides between items instead of snapping —
              // the scroll-lock already prevents mid-scroll flicker.
              transition:
                "color 150ms cubic-bezier(0.4,0,0.2,1), border-color 150ms cubic-bezier(0.4,0,0.2,1), background-color 150ms cubic-bezier(0.4,0,0.2,1)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {it.title}
          </button>
        );
      })}
    </nav>
  );
}

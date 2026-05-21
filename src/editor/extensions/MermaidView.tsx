// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";

/**
 * Renders a `mermaid` diagram from its source text — the rich presentation of
 * a ` ```mermaid ` fenced block (Planning-IDE Phase 1).
 *
 * `mermaid` is a heavy dependency only needed when a diagram is actually on
 * screen, so it is dynamically `import()`-ed inside the render effect. That
 * keeps it off the app's initial paint path and out of the headless vitest
 * module graph (no test instantiates this component).
 *
 * Rendering is deterministic — plan markdown → diagram, no agent in the path.
 */

/** mermaid.initialize() is process-global and idempotent; run it at most once. */
let initialized = false;

async function loadMermaid() {
  const mermaid = (await import("mermaid")).default;
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      // The diagram source is plan content under review — never grant it raw
      // HTML or click handlers.
      securityLevel: "strict",
      theme: "neutral",
      fontFamily:
        'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    });
    initialized = true;
  }
  return mermaid;
}

interface MermaidViewProps {
  /** The mermaid source — the code-block node's text content. */
  code: string;
}

export function MermaidView({ code }: MermaidViewProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const source = code.trim();
    if (!source) {
      setSvg(null);
      setError(null);
      return;
    }
    // Track-change edits to the source arrive in bursts — debounce the (async,
    // non-trivial) render so only the settled diagram is drawn.
    const timer = setTimeout(() => {
      // Unique per render: mermaid keys the temporary nodes it injects while
      // measuring by this id, so a fresh id can never collide with a sibling
      // diagram or a node left behind by a previous render.
      const renderId = `rl-mermaid-${Math.random().toString(36).slice(2)}`;
      void (async () => {
        try {
          const mermaid = await loadMermaid();
          const out = await mermaid.render(renderId, source);
          if (cancelled) return;
          setSvg(out.svg);
          setError(null);
        } catch (err) {
          if (cancelled) return;
          setSvg(null);
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          // Best-effort sweep of any temp node mermaid left behind on error.
          document.getElementById(renderId)?.remove();
        }
      })();
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code]);

  if (error) {
    return (
      <div className="rl-mermaid rl-mermaid--error" contentEditable={false}>
        <span className="rl-mermaid-error-label">Diagram error</span>
        <span className="rl-mermaid-error-msg">{error}</span>
      </div>
    );
  }
  if (svg === null) {
    return (
      <div className="rl-mermaid rl-mermaid--pending" contentEditable={false}>
        Rendering diagram…
      </div>
    );
  }
  return (
    <div
      className="rl-mermaid"
      contentEditable={false}
      // mermaid output, sanitized by `securityLevel: "strict"`.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

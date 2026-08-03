// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// One card's thumbnail box, and the stage the live capture performs on.
//
// Z-ORDER CAVEAT, worth stating plainly: while this card is being captured, a
// native WKWebView is parked exactly over the inner box below. Native views
// paint ABOVE the whole React tree, so nothing rendered inside that rect is
// visible during the capture and nothing there can receive a pointer event
// (the page itself is disarmed with pointer-events:none — see useThumbCapture).
// Exposure is roughly 1.5–2.5s per card, once per card per staleness window,
// and the queue stops the moment the surface is hidden.
//
// The outer container is what carries the shimmer, and the INNER box is what
// registers its rect — so the sweep stays visible as a frame around the live
// page rather than being covered by it. The whole thing reads as: shimmer →
// the page boots in-card → it freezes to a picture → the shimmer stops.

import { useEffect, useRef } from "react";
import { Cog, FileCode, Hexagon, RotateCw, Server, Zap } from "lucide-react";
import { placeholderFor, type Placeholder } from "../lib/thumbs";

const GLYPHS: Record<Placeholder["glyph"], typeof Server> = {
  zap: Zap,
  hexagon: Hexagon,
  "file-code": FileCode,
  cog: Cog,
  server: Server,
};

export function ProjectThumb({
  thumbKey,
  stack,
  projectName,
  dataUrl,
  capturing,
  live,
  canRefresh,
  registerRect,
  onRefresh,
}: {
  thumbKey: string;
  stack: string;
  projectName: string;
  dataUrl: string | null;
  capturing: boolean;
  /** A dead server's last picture is dimmed — it's history, not a live view.
   *  Kept separate from `canRefresh`: on a platform without native capture a
   *  running server is still running, and dimming it would say otherwise. */
  live: boolean;
  /** Whether retaking is possible at all (false where capture is unsupported). */
  canRefresh: boolean;
  registerRect: (key: string, el: HTMLElement | null) => void;
  onRefresh: (key: string) => void;
}) {
  const innerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    registerRect(thumbKey, innerRef.current);
    return () => registerRect(thumbKey, null);
  }, [thumbKey, registerRect]);

  const ph = placeholderFor(stack, projectName);
  const Glyph = GLYPHS[ph.glyph];

  return (
    <div
      className={capturing ? "rl-thumb-capturing" : undefined}
      style={{
        position: "relative",
        padding: capturing ? "2px" : 0,
        borderBottom: "1px solid var(--color-rule)",
      }}
    >
      <div
        ref={innerRef}
        style={{
          aspectRatio: "16 / 10",
          width: "100%",
          overflow: "hidden",
          background: "var(--color-bg)",
          position: "relative",
          opacity: live ? 1 : 0.6,
        }}
      >
        {dataUrl ? (
          <img
            src={dataUrl}
            alt=""
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "top center",
              display: "block",
            }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
              background: `color-mix(in srgb, ${ph.tint} 8%, var(--color-bg-elevated))`,
            }}
          >
            <span
              aria-hidden
              style={{
                position: "absolute",
                fontSize: "44px",
                fontWeight: 700,
                lineHeight: 1,
                color: `color-mix(in srgb, ${ph.tint} 22%, transparent)`,
                userSelect: "none",
              }}
            >
              {ph.initial}
            </span>
            <Glyph size={18} strokeWidth={2} color={ph.tint} />
          </div>
        )}
      </div>
      {canRefresh && (
        <button
          type="button"
          className="rl-thumb-refresh"
          onClick={() => onRefresh(thumbKey)}
          title="Retake this screenshot"
          style={{
            position: "absolute",
            top: "6px",
            right: "6px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "22px",
            height: "22px",
            borderRadius: "4px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            color: "var(--color-ink-muted)",
            cursor: "pointer",
            padding: 0,
          }}
        >
          <RotateCw size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

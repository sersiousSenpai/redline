// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useLayoutEffect, useRef, type ReactNode } from "react";

import {
  fadeOutKeyframes,
  inverseTransform,
  shouldSwap,
  springInKeyframes,
  SWAP_MS,
  SWAP_OUT_EASING,
  SWAP_SPRING,
  type SwapRect,
} from "../lib/springSwap";

// Two separate surfaces, one transition. Neither component knows about the
// other; this holds them both for the length of the spring and gets out of the
// way. The outgoing layer is handed in already-rendered by the host, so this
// never has to know what either surface is.

export function SpringSwap({
  from,
  leaving,
  onArrived,
  children,
}: {
  /** The island's box, measured on the gesture. Null renders the child
   *  untouched — the alternative routes into this surface have nothing to
   *  spring from. */
  from: SwapRect | null;
  /** The outgoing surface, still mounted so it can fade rather than vanish. */
  leaving?: ReactNode;
  onArrived: () => void;
  children: ReactNode;
}) {
  const inRef = useRef<HTMLDivElement | null>(null);
  const outRef = useRef<HTMLDivElement | null>(null);
  const onArrivedRef = useRef(onArrived);
  onArrivedRef.current = onArrived;
  // One shot. A re-render mid-flight must not restart the spring.
  const ran = useRef(false);

  useLayoutEffect(() => {
    const el = inRef.current;
    if (!from || !el || ran.current) return;
    ran.current = true;

    // Measured from the PANE, not from `.rl-swap-in`. The pane is already laid
    // out — it existed before the surface changed — whereas the incoming layer
    // is brand new this frame, and on a cold first switch its box can still be
    // resolving. An oversized host makes the inverse transform fly the content
    // toward the WINDOW's corner instead of the pane's. They are the same box
    // once settled, so this is strictly the more reliable of the two reads.
    const pane = el.closest(".rl-surface-pane");
    const host = (pane ?? el).getBoundingClientRect();
    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    )?.matches;
    if (!shouldSwap(from, host, !!reduced)) {
      onArrivedRef.current();
      return;
    }

    // Written before paint, so the surface's first frame is already the
    // island's box — never a flash at full size followed by a shrink.
    el.style.transformOrigin = "top left";
    el.style.transform = inverseTransform(from, host);
    el.style.willChange = "transform, opacity";
    // The blur is suspended for the flight. A `backdrop-filter` under a
    // transforming ancestor forces WebKit to re-sample and re-blur the backdrop
    // every frame at a changing scale — the single most expensive thing that
    // could be happening during this animation, and it buys nothing while the
    // surface is moving.
    el.dataset.springing = "1";

    const anim = el.animate(springInKeyframes(from, host), {
      duration: SWAP_MS,
      easing: SWAP_SPRING,
      // `both`, and this is the whole ballgame. With `backwards` the effect
      // stops applying the instant the animation ENDS, and the element falls
      // back to its underlying style — which is the inline transform two lines
      // above, i.e. the tiny box at the island's position. The surface
      // therefore snapped back to island-size for a frame or two at the exact
      // moment it landed, and then jumped to full size when `onfinish` ran and
      // cleared the inline. That is content leaping from the middle of the pane
      // out to its top-left corner: the flying text.
      //
      // `both` holds the FIRST keyframe before the start and the LAST one after
      // the end. The last is `transform: none`, which is precisely what settle
      // clears to — so there is no frame in between that belongs to neither.
      fill: "both",
    });

    const out = outRef.current;
    // INERT for its whole short life. The outgoing surface is a fresh mount of
    // a live component: the Front Door autofocuses its composer on mount, and
    // focusing an element inside an absolutely-positioned, transform-animated
    // container makes the browser scroll it into view — which is content
    // visibly flying — while also stealing focus from the editor that just
    // opened. `inert` stops both, and set imperatively so it lands before the
    // first paint rather than one render later.
    out?.setAttribute("inert", "");
    out?.animate(fadeOutKeyframes(), {
      duration: SWAP_MS * 0.55,
      easing: SWAP_OUT_EASING,
      fill: "forwards",
    });

    let done = false;
    const settle = () => {
      if (done) return; // cancel() below re-enters through `oncancel`
      done = true;
      // Drop the forwards fill BEFORE clearing the inline styles, so there is
      // no frame where the animation is still overriding them. Both are
      // `transform: none` by now, so this is invisible — but a forwards-filling
      // animation left alive on a live surface is a permanent style override.
      anim.cancel();
      el.style.transform = "";
      el.style.transformOrigin = "";
      el.style.willChange = "";
      delete el.dataset.springing;
      onArrivedRef.current();
    };
    anim.onfinish = settle;
    anim.oncancel = settle;
    return settle;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="rl-swap">
      {leaving && (
        <div ref={outRef} className="rl-swap-layer rl-swap-out" aria-hidden>
          {leaving}
        </div>
      )}
      <div ref={inRef} className="rl-swap-layer rl-swap-in">
        {children}
      </div>
    </div>
  );
}

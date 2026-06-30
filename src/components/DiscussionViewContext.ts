// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { createContext, useContext } from "react";

/** Adjust the shared sidecar-discussion text size by `delta` (clamped in the
 *  provider). Exposed as a *stable* callback via context so the A−/A+ controls
 *  deep inside each CommentThread can change the zoom without the current value
 *  ever being threaded down as a prop — the size itself rides the
 *  `--rl-discussion-zoom` CSS variable set once on the discussion pane. The net
 *  effect: a zoom change re-renders nothing in the comment list. */
export const DiscussionZoomContext = createContext<(delta: number) => void>(
  () => {},
);

export const useAdjustDiscussionZoom = () => useContext(DiscussionZoomContext);

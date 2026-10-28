// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The review pane (W6): the code review's whole body — the diff, its
// threads' anchors and the Repository view — over the one `useReview` App
// holds (polled only while a review pane is on screen). A lazy chunk, as it
// was in App: it carries the diff view and the push dialog.

import { lazy, Suspense, type ComponentProps } from "react";

import { ErrorBoundary } from "../../components/ErrorBoundary";
import { surfaceFallback } from "./fallback";

/** The code-review surface's whole body, including DiffView and the push
 *  dialog. Reached by opening a review, never on boot. */
const ReviewPanel = lazy(() => import("../../components/ReviewPanel"));

export type ReviewPaneProps = ComponentProps<typeof ReviewPanel>;

export function ReviewPane(props: ReviewPaneProps) {
  return (
    <ErrorBoundary region="review pane" fallback={surfaceFallback("review pane")}>
      <Suspense fallback={null}>
        <ReviewPanel {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The file pane (W6): the viewer / editor on one path, scrolled to a line
// when one was asked for. A preview pane (a plain click in the Files rail)
// pins itself on the first edit. The viewer is a lazy chunk, as it was in
// App.

import { lazy, Suspense } from "react";

import type { PaneDataByKind } from "../model";

const FileViewer = lazy(() => import("../../components/FileViewer").then((m) => ({ default: m.FileViewer })));

export function FilePane({ data, preview, onPin, onClose, onSaved }: {
  data: PaneDataByKind["file"];
  preview: boolean;
  /** Pin the preview (its first edit). */
  onPin: () => void;
  onClose: () => void;
  onSaved: (path: string) => void;
}) {
  return (
    <Suspense fallback={null}>
      <FileViewer path={data.path} line={data.line} lineAt={data.at} onClose={onClose} onSaved={onSaved} onEdit={preview ? onPin : undefined} />
    </Suspense>
  );
}

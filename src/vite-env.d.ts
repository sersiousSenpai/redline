// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/// <reference types="vite/client" />

// markdown-it-task-lists ships no type declarations. It's a standard
// markdown-it plugin: `md.use(taskLists, opts)`.
declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";
  const plugin: (
    md: MarkdownIt,
    opts?: { enabled?: boolean; label?: boolean; labelAfter?: boolean },
  ) => void;
  export default plugin;
}

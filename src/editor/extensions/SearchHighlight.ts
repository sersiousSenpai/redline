// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** A single matched range, in absolute ProseMirror document positions. */
export interface SearchMatch {
  from: number;
  to: number;
}

interface SearchHighlightStorage {
  query: string;
  matches: SearchMatch[];
  /** Index into `matches` of the "current" match (the one the viewport
   *  scrolls to and that paints in the stronger active style). -1 when there
   *  are no matches. */
  activeIndex: number;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    searchHighlight: {
      /** Set the query, recompute matches, and reset the active match to the
       *  first one. An empty query clears all highlights. */
      setSearchQuery: (query: string) => ReturnType;
      /** Advance the active match (wraps around). No-op with no matches. */
      nextMatch: () => ReturnType;
      /** Step the active match back (wraps around). No-op with no matches. */
      prevMatch: () => ReturnType;
      /** Clear the query and all highlights. */
      clearSearch: () => ReturnType;
    };
  }
}

export const searchHighlightKey = new PluginKey("searchHighlight");

/** Scan the document for case-insensitive occurrences of `query`, returning
 *  their absolute positions. Matches are found within a single text node, so a
 *  query split across inline marks won't match — fine for prose find. Exported
 *  for unit testing the scan in isolation. */
export function findMatches(
  doc: import("@tiptap/pm/model").Node,
  query: string,
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  if (!query) return matches;
  const needle = query.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const hay = node.text.toLowerCase();
    let idx = hay.indexOf(needle);
    while (idx !== -1) {
      matches.push({ from: pos + idx, to: pos + idx + needle.length });
      idx = hay.indexOf(needle, idx + needle.length);
    }
  });
  return matches;
}

/** In-document find for the plan editor: a Cmd/Ctrl+F search box (wired in
 *  PlanEditor) drives these commands, which paint match decorations on top of
 *  the existing decoration layers. Mirrors the storage + meta-dispatch pattern
 *  of {@link CommentHighlights}. */
export const SearchHighlight = Extension.create<
  unknown,
  SearchHighlightStorage
>({
  name: "searchHighlight",

  addStorage() {
    return { query: "", matches: [], activeIndex: -1 };
  },

  addCommands() {
    return {
      setSearchQuery:
        (query) =>
        ({ editor, tr, dispatch }) => {
          const s = editor.storage.searchHighlight;
          s.query = query;
          s.matches = findMatches(editor.state.doc, query);
          s.activeIndex = s.matches.length > 0 ? 0 : -1;
          if (dispatch) dispatch(tr.setMeta(searchHighlightKey, true));
          return true;
        },
      nextMatch:
        () =>
        ({ editor, tr, dispatch }) => {
          const s = editor.storage.searchHighlight;
          if (s.matches.length === 0) return false;
          s.activeIndex = (s.activeIndex + 1) % s.matches.length;
          if (dispatch) dispatch(tr.setMeta(searchHighlightKey, true));
          return true;
        },
      prevMatch:
        () =>
        ({ editor, tr, dispatch }) => {
          const s = editor.storage.searchHighlight;
          if (s.matches.length === 0) return false;
          s.activeIndex =
            (s.activeIndex - 1 + s.matches.length) % s.matches.length;
          if (dispatch) dispatch(tr.setMeta(searchHighlightKey, true));
          return true;
        },
      clearSearch:
        () =>
        ({ editor, tr, dispatch }) => {
          const s = editor.storage.searchHighlight;
          s.query = "";
          s.matches = [];
          s.activeIndex = -1;
          if (dispatch) dispatch(tr.setMeta(searchHighlightKey, true));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const extension = this;
    return [
      new Plugin({
        key: searchHighlightKey,
        props: {
          decorations(state) {
            const storage: SearchHighlightStorage =
              extension.editor.storage.searchHighlight;
            if (storage.matches.length === 0) return DecorationSet.empty;
            const decos = storage.matches.map((m, i) =>
              Decoration.inline(m.from, m.to, {
                class:
                  i === storage.activeIndex
                    ? "rl-search-match rl-search-match--active"
                    : "rl-search-match",
              }),
            );
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

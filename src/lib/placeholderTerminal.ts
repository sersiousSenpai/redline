// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

/** The id of a pristine convenience shell that a session should replace.
 *  A shell beside other terminals is the user's to keep. */
export function replaceablePlaceholder(
  tabs: readonly { id: string; cwd: string | null; placeholder?: boolean }[],
  liveCwds: ReadonlyMap<string, string>,
  home: string | null,
): string | null {
  if (tabs.length !== 1 || !tabs[0].placeholder) return null;
  const tab = tabs[0];
  const current = liveCwds.get(tab.id);
  if (current) {
    const initial = tab.cwd ?? home;
    // If HOME isn't known, don't gamble with a shell that has a live cwd.
    const norm = (path: string) => path.replace(/\/+$/, "") || "/";
    if (!initial || norm(current) !== norm(initial)) return null;
  }
  return tab.id;
}

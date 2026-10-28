// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// ⌘P (W4): go to a file in the project. The folder is walked once per open
// (`lib/quickOpen.indexFiles`, the Files rail's own `list_dir`), ranked
// fuzzily as you type. ⏎ opens it pinned, ⌘⏎ in a tab of its own, Esc or a
// click outside closes. Lazy; nothing here is on the boot path.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { DirEntry } from "../types";
import { indexFiles, rankFiles } from "../lib/quickOpen";
import type { FileOpenMode } from "../components/FileTree";
import { Spinner } from "../components/Spinner";
import { useMenuOverlay } from "../components/menuOverlay";
import "./rail.css";

export interface QuickOpenProps {
  root: string;
  onOpen: (path: string, mode: FileOpenMode) => void;
  onClose: () => void;
}

export default function QuickOpen({ root, onOpen, onClose }: QuickOpenProps) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const base = root.replace(/\/+$/, "");
  // The native browser webview hides beneath it, like the ⌘K palette.
  useMenuOverlay(true);

  useEffect(() => {
    const signal = { aborted: false };
    setFiles(null);
    void indexFiles(base, (path) => invoke<DirEntry[]>("list_dir", { path }), { signal }).then((r) => {
      if (signal.aborted) return;
      setFiles(r.files);
      setTruncated(r.truncated);
    });
    return () => {
      signal.aborted = true;
    };
  }, [base]);
  useEffect(() => inputRef.current?.focus(), []);

  const results = useMemo(() => (files ? rankFiles(query, files) : []), [files, query]);
  useEffect(() => setIndex(0), [query]);

  const open = (rel: string | undefined, mode: FileOpenMode) => {
    if (!rel) return;
    onOpen(`${base}/${rel}`, mode);
    onClose();
  };

  return (
    <div className="rl-qo-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rl-qo" role="dialog" aria-label="Go to file">
        <input
          ref={inputRef}
          className="rl-qo-input"
          placeholder={`Go to a file in ${base.split("/").pop() || base}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              open(results[index], e.metaKey ? "tab" : "pin");
            }
          }}
          aria-activedescendant={results[index] ? `rl-qo-${index}` : undefined}
          aria-controls="rl-qo-list"
        />
        <div id="rl-qo-list" className="rl-qo-list" role="listbox">
          {files === null ? (
            <div className="rl-qo-note">
              <Spinner /> Reading the folder…
            </div>
          ) : results.length === 0 ? (
            <div className="rl-qo-note">No file matches.</div>
          ) : (
            results.map((rel, i) => {
              const slash = rel.lastIndexOf("/");
              return (
                <div
                  key={rel}
                  id={`rl-qo-${i}`}
                  role="option"
                  aria-selected={i === index}
                  className="rl-qo-row"
                  onMouseEnter={() => setIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    open(rel, e.metaKey ? "tab" : "pin");
                  }}
                >
                  <span className="rl-qo-name">{rel.slice(slash + 1)}</span>
                  {slash > 0 && <span className="rl-qo-dir">{rel.slice(0, slash)}</span>}
                </div>
              );
            })
          )}
          {truncated && <div className="rl-qo-note">Showing the first {files?.length ?? 0} files of a large folder.</div>}
        </div>
      </div>
    </div>
  );
}

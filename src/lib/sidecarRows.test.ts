// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import type { ThreadMessage } from "../types";
import { askedMode, isChatRow, reportItems } from "./sidecarRows";

const row = (id: string, role: "user" | "assistant", chat = false): ThreadMessage => ({
  id,
  sessionId: "s-1",
  commentId: "c-1",
  role,
  body: id,
  status: "complete",
  createdAt: 1,
  ...(chat ? { mode: "chat" as const } : {}),
});

describe("sidecar rows", () => {
  it("reads only a stamped row as chat; every legacy row is the report's", () => {
    expect(isChatRow(row("a", "user", true))).toBe(true);
    expect(isChatRow(row("b", "assistant"))).toBe(false);
  });

  it("files a reply under its question's mode", () => {
    expect(askedMode([])).toBeUndefined();
    expect(askedMode([row("q", "user", true)])).toBe("chat");
    expect(askedMode([row("q", "user", true), row("r", "assistant", true), row("q2", "user")])).toBeUndefined();
    // The latest question wins even with replies after it.
    expect(askedMode([row("q", "user"), row("c", "user", true), row("r", "assistant")])).toBe("chat");
  });

  it("folds each run of chat turns into one counted chip", () => {
    const items = reportItems([
      row("seed", "user"),
      row("report", "assistant"),
      row("c1", "user", true),
      row("c2", "assistant", true),
      row("c3", "user", true),
      row("follow", "user"),
      row("answer", "assistant"),
      row("c4", "user", true),
      row("c5", "assistant", true),
    ]);
    expect(items.map((item) => (item.kind === "row" ? item.msg.id : `chat×${item.count}${item.last ? " last" : ""}`))).toEqual([
      "seed",
      "report",
      "chat×3",
      "follow",
      "answer",
      "chat×2 last",
    ]);
  });

  it("marks no chip last when a report row ends the thread", () => {
    const items = reportItems([row("c1", "user", true), row("c2", "assistant", true), row("w", "user"), row("r", "assistant")]);
    expect(items[0]).toMatchObject({ kind: "chat", count: 2, last: false, key: "c1" });
    expect(reportItems([])).toEqual([]);
  });
});

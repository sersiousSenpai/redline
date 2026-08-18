// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  dayBounds,
  dayKey,
  deriveTrails,
  fmtBytes,
  groupItems,
  machineBytes,
  corpusBannerText,
  CORPUS_ROLES,
  CORPUS_ROLE_LABEL,
  CORPUS_ROLE_HINT,
  type TimelineItem,
} from "./timeline";

let seq = 0;
function item(partial: Partial<TimelineItem>): TimelineItem {
  seq += 1;
  return {
    seq,
    ts: 0,
    kind: "prompt",
    author: "human",
    promptId: null,
    sessionId: null,
    versionNumber: null,
    refKind: null,
    refId: null,
    payloadHash: "ph",
    prevHash: "pv",
    entryHash: "eh",
    surface: null,
    projectPath: null,
    threadKind: null,
    model: null,
    preview: null,
    bodyChars: null,
    role: null,
    compacted: false,
    browseId: null,
    url: null,
    title: null,
    action: null,
    fromEventId: null,
    shotKey: null,
    caption: null,
    classNodeId: null,
    classTitle: null,
    starred: false,
    note: null,
    ...partial,
  };
}

function page(browseId: string, rowId: number, url: string, from: number | null): TimelineItem {
  return item({
    kind: "browse_event",
    browseId,
    refKind: "browse_event",
    refId: String(rowId),
    url,
    fromEventId: from,
    ts: rowId * 1000,
  });
}

describe("dayKey / dayBounds", () => {
  it("round-trips a timestamp through its local day bucket", () => {
    const noon = new Date(2026, 7, 3, 12, 30).getTime();
    const key = dayKey(noon);
    expect(key).toBe("2026-08-03");
    const { sinceTs, untilTs } = dayBounds(key);
    expect(noon).toBeGreaterThanOrEqual(sinceTs);
    expect(noon).toBeLessThanOrEqual(untilTs);
    expect(untilTs - sinceTs).toBe(86_400_000 - 1);
  });
});

describe("groupItems — day", () => {
  it("buckets a newest-first page into consecutive day groups", () => {
    const d1 = new Date(2026, 7, 3, 9).getTime();
    const d2 = new Date(2026, 7, 2, 9).getTime();
    const rows = groupItems(
      [item({ ts: d1 + 60_000 }), item({ ts: d1 }), item({ ts: d2 })],
      "day",
    );
    expect(rows.map((r) => r.type)).toEqual([
      "header",
      "event",
      "event",
      "header",
      "event",
    ]);
    expect(rows[0]).toMatchObject({ type: "header", count: 2 });
    expect(rows[3]).toMatchObject({ type: "header", count: 1 });
  });
});

describe("groupItems — session", () => {
  it("degrades unthreaded events into one labeled bucket, never dropping them", () => {
    const rows = groupItems(
      [
        item({ sessionId: "sess-aaaa-1111" }),
        item({ sessionId: null }),
        item({ sessionId: "sess-aaaa-1111" }),
        item({ sessionId: null }),
      ],
      "session",
    );
    const headers = rows.filter((r) => r.type === "header");
    expect(headers).toHaveLength(2);
    expect(headers.map((h) => (h.type === "header" ? h.label : ""))).toContain(
      "Unthreaded",
    );
    const unthreaded = headers.find(
      (h) => h.type === "header" && h.label === "Unthreaded",
    );
    expect(unthreaded).toMatchObject({ count: 2, meta: "no session recorded" });
    expect(rows.filter((r) => r.type === "event")).toHaveLength(4);
  });
});

describe("groupItems — class", () => {
  it("groups by filed class with an Unfiled fallback bucket", () => {
    const rows = groupItems(
      [
        item({ classNodeId: "cn-1", classTitle: "Loop Engineering" }),
        item({}),
        item({ classNodeId: "cn-1", classTitle: "Loop Engineering" }),
      ],
      "class",
    );
    const headers = rows.filter((r) => r.type === "header");
    expect(headers[0]).toMatchObject({ label: "Loop Engineering", count: 2 });
    expect(headers[1]).toMatchObject({ label: "Unfiled", count: 1 });
  });
});

describe("deriveTrails", () => {
  it("computes content-distinct returns and edge-chain depth from recorded rows", () => {
    // A → B → A: three rows (the insert dedup is consecutive-only), one return.
    const items = [
      page("t1", 1, "https://a", null),
      page("t1", 2, "https://b", 1),
      page("t1", 3, "https://a", 2),
    ];
    const [trail] = deriveTrails(items);
    expect(trail.pageCount).toBe(3);
    expect(trail.returnCount).toBe(1);
    expect(trail.depth).toBe(3);
    // Oldest-first: the sequence as walked.
    expect(trail.events.map((e) => e.url)).toEqual([
      "https://a",
      "https://b",
      "https://a",
    ]);
  });

  it("a trail root without edges has depth 1 per page chain", () => {
    const [trail] = deriveTrails([
      page("t2", 10, "https://x", null),
      page("t2", 11, "https://y", null),
    ]);
    expect(trail.depth).toBe(1);
    expect(trail.returnCount).toBe(0);
  });

  it("ranks trails by returns, then depth", () => {
    const shallow = [page("flat", 20, "https://p", null), page("flat", 21, "https://q", null)];
    const looping = [
      page("loop", 30, "https://a", null),
      page("loop", 31, "https://b", 30),
      page("loop", 32, "https://a", 31),
    ];
    const trails = deriveTrails([...shallow, ...looping]);
    expect(trails.map((t) => t.browseId)).toEqual(["loop", "flat"]);
  });

  it("survives a cyclic edge without recursing forever", () => {
    const a = page("cyc", 40, "https://a", 41);
    const b = page("cyc", 41, "https://b", 40);
    const [trail] = deriveTrails([a, b]);
    expect(trail.depth).toBeGreaterThanOrEqual(1);
  });
});

describe("groupItems — trail", () => {
  it("shows only browse events, ranked, with the derived meta line", () => {
    const rows = groupItems(
      [
        item({ kind: "prompt", preview: "not a page" }),
        page("t1", 50, "https://a", null),
        page("t1", 51, "https://b", 50),
      ],
      "trail",
    );
    expect(rows[0]).toMatchObject({
      type: "header",
      meta: "2 pages · 0 returns · depth 2",
    });
    expect(rows.filter((r) => r.type === "event")).toHaveLength(2);
  });

  it("does not mutate the input page order", () => {
    const items = [page("t9", 61, "https://b", 60), page("t9", 60, "https://a", null)];
    const before = items.map((i) => i.seq);
    groupItems(items, "trail");
    expect(items.map((i) => i.seq)).toEqual(before);
  });
});

describe("fmtBytes", () => {
  it("scales through B / KB / MB", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(12_600)).toBe("12.3 KB");
    expect(fmtBytes(4_300_000)).toBe("4.1 MB");
  });
});

describe("corpus role facet", () => {
  const real = [
    // The live composition, measured 08/16.
    { role: "agent", rows: 447, bytes: 5_747_000 },
    { role: "system", rows: 110, bytes: 1_877_300 },
    { role: "user", rows: 658, bytes: 212_500 },
  ];

  it("counts everything that is not the user's own words", () => {
    expect(machineBytes(real)).toBe(5_747_000 + 1_877_300);
    expect(machineBytes(undefined)).toBe(0);
    expect(machineBytes([{ role: "user", rows: 1, bytes: 999 }])).toBe(0);
  });

  it("states the amount, that nothing was deleted, and where to look", () => {
    const text = corpusBannerText(real, fmtBytes);
    expect(text).toContain("7.3 MB");
    // The reassurance is not optional — the honest version of this change is
    // "reclassified", never "removed".
    expect(text).toContain("Nothing was deleted");
    expect(text).toContain("Whose words");
  });

  it("says nothing when there is nothing worth interrupting for", () => {
    expect(corpusBannerText(undefined, fmtBytes)).toBeNull();
    expect(corpusBannerText([{ role: "user", rows: 10, bytes: 5_000 }], fmtBytes)).toBeNull();
    // Just under a megabyte of machine text is not worth a banner.
    expect(corpusBannerText([{ role: "agent", rows: 3, bytes: 999_000 }], fmtBytes)).toBeNull();
  });

  it("labels each role in the user's terms, not the schema's", () => {
    expect(CORPUS_ROLES).toEqual(["user", "agent", "system"]);
    expect(CORPUS_ROLE_LABEL.user).toBe("Yours");
    expect(CORPUS_ROLE_LABEL.agent).toBe("Redline's");
    for (const r of CORPUS_ROLES) expect(CORPUS_ROLE_HINT[r].length).toBeGreaterThan(10);
  });
});

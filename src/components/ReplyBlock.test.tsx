// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// One reply anatomy (design decision 4), pinned on the component every chat
// surface renders its replies with: the skeleton a reply streams in is the
// skeleton it settles into — the same boxes, in the same order, with the
// same byline and the same markup for its text — so a settle moves nothing.
// Only the tail row's contents and the steps line's words change.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./StreamInspector", () => ({ default: () => <div data-inspector>raw stream</div> }));

import { ReplyBlock, UserTurn, type ReplyBlockProps } from "./ReplyBlock";
import { emptyMeter, type TurnMeter } from "../lib/turnMeter";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FENCE = "```";
const REPLY = [
  "The conversation keeps its history and source anchors.",
  "",
  "## What carries over",
  "",
  "- The bounded recap.",
  "- Source anchors on each item.",
  "",
  `${FENCE}ts`,
  "const recap = summarize(thread);",
  FENCE,
  "",
  "Existing items stay attached.",
].join("\n");
const HEADING_FIRST = "## Meter\n\nThe meter rides with the row.";

const meter = (patch: Partial<TurnMeter> = {}): TurnMeter => ({
  ...emptyMeter(),
  model: "claude-opus-4-6",
  effort: "xhigh",
  inputTokens: 4,
  outputTokens: 1400,
  cacheReadTokens: 30_200,
  cacheCreationTokens: 2_100,
  contextTokens: 32_304,
  toolCalls: 2,
  lastTool: "Grep",
  lastToolLabel: "Grep(seat_burn)",
  rev: 9,
  ...patch,
});
const ACTIVITY = [
  { at: 2_000, kind: "thinking", label: "Thinking…" },
  { at: 3_000, kind: "tool", label: "Read…" },
  { at: 4_000, kind: "tool", label: "Grep(seat_burn)" },
];
/** The row's meter once the turn has settled: the live one, finished, with
 *  its steps kept (what the reducer and `meter::settle` store). */
const settledMeter = (live: TurnMeter): TurnMeter => ({
  ...live,
  stopReason: "end_turn",
  durationMs: 12_400,
  steps: ACTIVITY.filter((a) => a.kind === "tool"),
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const render = (props: ReplyBlockProps) => act(async () => root.render(<ReplyBlock {...props} />));
const reply = () => host.querySelector<HTMLElement>("[data-reply]")!;
/** The reply's skeleton: each slot's tag, classes and data attributes, in
 *  order — text ignored. */
const skeleton = () =>
  Array.from(reply().children).map((el) => {
    const data = Array.from(el.attributes).filter((a) => a.name.startsWith("data-")).map((a) => a.name).sort();
    return [el.tagName.toLowerCase(), el.getAttribute("class") ?? "", ...data].join(" ");
  });
const statuses = () => host.querySelectorAll("[role=status]").length;
const byline = () => host.querySelector(".rl-reply-byline")!.textContent;
const textMarkup = () => host.querySelector(".rl-reply-text")!.innerHTML;

/** Render a reply live and then settled, as a surface swaps them at done. */
async function phases(base: Omit<ReplyBlockProps, "phase">, settled: Partial<ReplyBlockProps> = {}) {
  await render({ ...base, phase: "live" });
  const live = { skeleton: skeleton(), byline: byline(), text: textMarkup(), statuses: statuses(), tail: host.querySelector("[data-reply-tail]")!.className };
  await render({ ...base, activity: undefined, startedAt: undefined, actions: <button type="button" className="rl-reply-action">Copy</button>, ...settled, phase: "settled" });
  const done = { skeleton: skeleton(), byline: byline(), text: textMarkup(), statuses: statuses(), tail: host.querySelector("[data-reply-tail]")!.className };
  return { live, done };
}

describe("one skeleton, streaming and settled", () => {
  it.each([
    ["a reply that used tools", { text: REPLY, meter: meter(), activity: ACTIVITY, startedAt: 1_000 }],
    ["a heading-first reply", { text: HEADING_FIRST, meter: meter(), activity: ACTIVITY, startedAt: 1_000 }],
    ["a reply with no tools", { text: REPLY, meter: meter({ toolCalls: 0, lastTool: null, lastToolLabel: null }), activity: [], startedAt: 1_000 }],
    ["a reply with no meter at all", { text: REPLY, meter: null, activity: [], startedAt: 1_000 }],
    ["the room at plate scale", { text: REPLY, meter: meter(), activity: ACTIVITY, startedAt: 1_000, room: true }],
  ])("%s keeps its boxes, byline and text markup at settle", async (_, props) => {
    const base = { byline: "Claude", ...props } as Omit<ReplyBlockProps, "phase">;
    const { live, done } = await phases(base, { meter: base.meter ? settledMeter(base.meter) : null });
    expect(done.skeleton).toEqual(live.skeleton);
    expect(done.byline).toBe(live.byline);
    expect(done.text).toBe(live.text);
    expect(done.tail).toBe(live.tail);
    expect(live.skeleton[live.skeleton.length - 1]).toMatch(/^div rl-reply-tail data-reply-tail$/);
  });

  it("signs a reply with the model only when it isn't the one asked for, in both phases", async () => {
    const swapped = { byline: "Claude", seat: "sonnet", text: "Hi.", meter: meter(), activity: ACTIVITY, startedAt: 1_000 };
    const { live, done } = await phases(swapped, { meter: settledMeter(meter()) });
    expect(live.byline).toBe("Claude · opus-4-6");
    expect(done.byline).toBe(live.byline);
    // An alias matches its full id, and nothing asked for is nothing to differ from.
    for (const seat of ["opus", "claude-opus-4-6[1m]", null]) {
      await render({ phase: "settled", byline: "Claude", seat, text: "Hi.", meter: meter() });
      expect(byline()).toBe("Claude");
    }
  });

  it("has exactly one status line while live and none once settled, and never a caret", async () => {
    const { live, done } = await phases({ byline: "Claude", text: REPLY, meter: meter(), activity: ACTIVITY, startedAt: 1_000 });
    expect(live.statuses).toBe(1);
    expect(done.statuses).toBe(0);
    await render({ phase: "live", byline: "Claude", text: "", meter: null, startedAt: 1_000 });
    expect(statuses()).toBe(1);
    expect(host.textContent).not.toContain("▌");
  });
});

describe("the steps line", () => {
  it("names the current tool live and what the turn took once settled", async () => {
    await render({ phase: "live", byline: "Claude", text: "", meter: meter(), activity: ACTIVITY, startedAt: 1_000 });
    expect(host.querySelector("[data-reply-steps]")?.textContent).toBe("▸Used 2 tools · Grep(seat_burn)");
    await render({ phase: "settled", byline: "Claude", text: REPLY, meter: settledMeter(meter()) });
    expect(host.querySelector("[data-reply-steps]")?.textContent).toBe("▸Used 2 tools · 12.4s");
  });

  it("expands to the steps, folding reads and searches and keeping what acted", async () => {
    const steps = [
      { at: 1, kind: "tool", label: "Read…" },
      { at: 2, kind: "tool", label: "Grep(seat_burn)" },
      { at: 3, kind: "tool", label: "searching your memory…" },
      { at: 4, kind: "tool", label: "Bash(git status)" },
      { at: 5, kind: "tool", label: "Read…" },
    ];
    await render({ phase: "settled", byline: "Claude", text: REPLY, meter: { ...settledMeter(meter({ toolCalls: 5 })), steps } });
    const toggle = host.querySelector<HTMLButtonElement>("[data-reply-steps]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle.click());
    expect(Array.from(host.querySelectorAll(".rl-reply-steplist li")).map((li) => li.textContent)).toEqual([
      "Explored · 1 read, 2 searches",
      "Bash(git status)",
      "Explored · 1 read",
    ]);
    // The fold covers only steps: the reply's own text is never behind it.
    expect(host.querySelector(".rl-reply-text")?.textContent).toContain("Existing items stay attached.");
  });

  it("adds no box when a tool fires after the reply has started writing", async () => {
    // Text first, then a tool (the agent says what it will check, then
    // checks): the steps arrive on the byline's row, which was there from
    // the first frame, never as a line above text being read.
    const text = "Let me check the seat table first.";
    await render({ phase: "live", byline: "Claude", text, meter: meter({ toolCalls: 0, lastTool: null, lastToolLabel: null }), activity: [], startedAt: 1_000 });
    const before = skeleton();
    expect(host.querySelector("[data-reply-steps]")).toBeNull();
    await render({ phase: "live", byline: "Claude", text, meter: meter({ toolCalls: 1 }), activity: [{ at: 2_000, kind: "tool", label: "Read…" }], startedAt: 1_000 });
    expect(skeleton()).toEqual(before);
    expect(host.querySelector(".rl-reply-head [data-reply-steps]")?.textContent).toBe("▸Used 1 tool · Read…");
    expect(byline()).toBe("Claude");
  });

  it("is a line that can't open where no steps were kept", async () => {
    await render({ phase: "settled", byline: "Claude", text: REPLY, meter: meter({ durationMs: 900 }) });
    expect(host.querySelector<HTMLButtonElement>("[data-reply-steps]")?.disabled).toBe(true);
  });
});

describe("the tail row", () => {
  it("says what the live turn is doing, with its clock outside the live region", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    await render({ phase: "live", byline: "Claude", text: "", meter: null, activity: [], startedAt: 10_000 });
    const tail = () => host.querySelector("[data-reply-tail]")!;
    const status = () => tail().querySelector<HTMLElement>("[role=status]")!;
    // Waiting is the quiet typing state (D28): the shared Spinner, the word
    // for a screen reader only.
    const quiet = () => status().hasAttribute("data-typing") && !!status().querySelector(".rl-spinner") && status().textContent === "Replying";
    expect(quiet()).toBe(true);
    await act(async () => vi.advanceTimersByTime(8_000));
    expect(tail().textContent).toContain("8s");
    expect(tail().querySelector("[role=status]")?.textContent).not.toContain("8s");
    await render({ phase: "live", byline: "Claude", text: "", meter: meter(), activity: [{ at: 15_000, kind: "tool", label: "Grep…" }], startedAt: 10_000 });
    expect(tail().querySelector("[role=status]")?.textContent).toBe("Searching source files");
    await render({ phase: "live", byline: "Claude", text: "Because", meter: meter(), activity: [{ at: 15_000, kind: "tool", label: "Grep…" }], startedAt: 10_000 });
    expect(quiet()).toBe(true);
    // A retry, and a rate-limit warning on a request still going through, are
    // the wait: never "retrying…" or "Rate limited" words mid-turn.
    await render({ phase: "live", byline: "Claude", text: "Because", meter: meter(), startedAt: 10_000, retrying: true });
    expect(quiet()).toBe(true);
    await render({ phase: "live", byline: "Claude", text: "Because", meter: meter({ rateLimited: { status: "allowed_warning", resetsAt: null, kind: "five_hour" } }), activity: [{ at: 16_000, kind: "rateLimit", label: "Rate limited (five_hour) · waiting" }], startedAt: 10_000 });
    expect(quiet()).toBe(true);
    expect(tail().textContent).not.toMatch(/Rate limited|waiting|quiet/i);
  });

  it("holds the surface's actions, the ⋯ to the raw stream and one meter line once settled", async () => {
    await render({
      phase: "settled",
      byline: "Claude",
      text: REPLY,
      meter: { ...settledMeter(meter()), stopReason: "max_tokens" },
      inspect: { surface: "companion", key: "chat-1" },
      actions: <button type="button" className="rl-reply-action">Copy</button>,
    });
    const tail = host.querySelector("[data-reply-tail]")!;
    expect(tail.querySelector("[role=status]")).toBeNull();
    // The model is the byline's to name; `truncated` leads so no ellipsis cuts it.
    const line = tail.querySelector(".rl-reply-meter")!;
    expect(line.textContent).toBe("truncated · 32.3k in (93% cached) · 1.4k out · 12.4s");
    expect(line.getAttribute("title")).toContain("claude-opus-4-6");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="More for this reply"]')!.click());
    const show = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent?.includes("Show the raw stream"))!;
    await act(async () => show.click());
    await act(async () => {});
    expect(host.querySelector("[data-inspector]")).not.toBeNull();
  });

  it("marks a reply the user stopped where the meter sits, adding no line under its text", async () => {
    const { live, done } = await phases({ byline: "Claude", text: "The gist is", meter: null, activity: [], startedAt: 1_000 }, { interrupted: true });
    expect(done.skeleton).toEqual(live.skeleton);
    const line = () => host.querySelector("[data-reply-tail] .rl-reply-meter")?.textContent;
    expect(line()).toBe("(interrupted)");
    await render({ phase: "settled", byline: "Claude", text: "The gist is", meter: settledMeter(meter()), interrupted: true });
    expect(line()).toMatch(/^\(interrupted\) · 32\.3k in/);
  });

  it("reaches the raw stream from a live reply too, and keeps it open as the reply settles", async () => {
    const live = { phase: "live", byline: "Claude", text: "Because", meter: meter(), startedAt: 1_000, inspect: { surface: "companion", key: "chat-1" } } as const;
    const open = async () => {
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="More for this reply"]')!.click());
      const show = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent?.includes("Show the raw stream"))!;
      await act(async () => show.click());
    };
    await render(live);
    const tail = host.querySelector("[data-reply-tail]")!;
    // Still the turn's one status line, with the ⋯ beside its clock.
    expect(tail.querySelectorAll("[role=status]")).toHaveLength(1);
    expect(tail.querySelector('.rl-reply-actions [aria-label="More for this reply"]')).not.toBeNull();
    await open();
    expect(host.querySelector('[data-reply="live"] [data-inspector]')).not.toBeNull();
    // The surface swaps the live block for the settled row (a remount, as
    // at done): the row it settled into keeps the raw stream open...
    const settled = { ...live, phase: "settled", activity: undefined, startedAt: undefined } as const;
    await act(async () => root.render(<div key="settled"><ReplyBlock {...settled} /></div>));
    expect(host.querySelector('[data-reply="settled"] [data-inspector]')).not.toBeNull();
    // ...and only that row: an older row of the thread mounting later doesn't.
    await act(async () => root.render(<div key="settled"><ReplyBlock {...settled} /><ReplyBlock {...settled} /></div>));
    expect(host.querySelectorAll("[data-inspector]")).toHaveLength(1);
    // A live reply whose stream was shut hands nothing over.
    await act(async () => root.render(<div key="live"><ReplyBlock {...live} /></div>));
    await act(async () => root.render(<div key="again"><ReplyBlock {...settled} /></div>));
    expect(host.querySelector("[data-inspector]")).toBeNull();
  });

  it("offers no ⋯ where the surface captures nothing", async () => {
    await render({ phase: "settled", byline: "Claude", text: REPLY, meter: meter() });
    expect(host.querySelector('[aria-label="More for this reply"]')).toBeNull();
  });

  it("is offered live wherever the surface's settled replies offer it, on the same stream", () => {
    // A thread's first turn has no settled reply to open it from; the live
    // block names the stream its settled row will, so the pane carries over.
    for (const file of ["ChatRoom", "BrowserChat", "MissionChat", "MemoryAsk", "DrafterSidecar", "ReviewThread", "CommentThread"]) {
      const source = readFileSync(join(process.cwd(), `src/components/${file}.tsx`), "utf8");
      const block = /<ReplyBlock\s+phase="live"([\s\S]*?)\n\s*\/?>/g;
      const stream = (props: string) => /inspect=\{\{ surface: "(\w+)", key: /.exec(props)?.[1];
      const live = [...source.matchAll(block)].map((m) => stream(m[1]));
      const settled = [...source.replace(block, "").matchAll(/inspect=\{\{ surface: "(\w+)", key: /g)].map((m) => m[1]);
      expect(live.length, file).toBeGreaterThan(0);
      expect(settled.length, file).toBeGreaterThan(0);
      for (const surface of live) expect(settled, `${file}'s live reply`).toContain(surface);
    }
  });

  it("signs an error row as Redline's and keeps its text verbatim", async () => {
    await render({ phase: "settled", byline: "Redline", text: "Couldn't reach the agent: <busy>", error: true });
    expect(byline()).toBe("Redline");
    expect(host.querySelector(".rl-reply-error")?.textContent).toBe("Couldn't reach the agent: <busy>");
  });
});

describe("the user's turn", () => {
  it("is a compact card with no You byline, offering a resend when it never went", async () => {
    const resend = vi.fn();
    await act(async () => root.render(<UserTurn body="Why there?" unsent onResend={resend} />));
    const card = host.querySelector("[data-user-turn]")!;
    expect(card.className).toBe("rl-user-turn");
    expect(card.textContent).not.toMatch(/\bYou\b/);
    await act(async () => Array.from(card.querySelectorAll("button")).find((b) => b.textContent === "resend")!.click());
    expect(resend).toHaveBeenCalledOnce();
  });

  it("opens a link the reviewer sent where the surface opens links", async () => {
    const open = vi.fn();
    await act(async () => root.render(<UserTurn body="Compare with https://example.com/spec" onOpenLink={open} />));
    await act(async () => host.querySelector<HTMLAnchorElement>("[data-user-turn] a")!.click());
    expect(open).toHaveBeenCalledWith("https://example.com/spec");
  });
});

describe("the stylesheet", () => {
  const css = readFileSync(join(process.cwd(), "src/components/ReplyBlock.css"), "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("draws a reply as prose: no border, no fill", () => {
    expect(rule(".rl-reply")).not.toMatch(/border|background/);
  });

  it("holds the tail row at one height in each scale", () => {
    expect(rule(".rl-reply-tail")).toMatch(/\bheight: \d+px;/);
    expect(css).toMatch(/\.rl-reply\[data-room\] \.rl-reply-tail \{ height: \d+px;/);
  });

  it("holds the head row at one height, so the steps arrive without moving the text", () => {
    expect(rule(".rl-reply-head")).toMatch(/\bheight: calc\(16px \* var\(--rl-discussion-zoom, 1\)\);/);
    expect(css).toMatch(/\.rl-reply\[data-room\] \.rl-reply-head \{ height: \d+px; \}/);
    expect(rule(".rl-reply-steps")).toMatch(/height: 100%;/);
  });

  it("keeps every tail action in reach: the meter gives way first, then the actions scroll", () => {
    // The meter takes only the room left over, so it ellipsizes before an
    // action is pushed off; past that, the actions scroll rather than clip.
    expect(rule(".rl-reply-meter")).toMatch(/flex: 1 1 0;/);
    expect(rule(".rl-reply-actions")).toMatch(/min-width: 0;[^}]*overflow-x: auto;/);
  });

  it("reveals the actions by opacity, never by taking or giving space", () => {
    expect(rule(".rl-reply-actions")).toMatch(/opacity: 0;/);
    // A live reply's ⋯ waits for a hover or focus even when it is the newest.
    expect(css).toMatch(/\.rl-reply\[data-reply="live"\]:not\(:hover, :focus-within\) \.rl-reply-actions \{ opacity: 0; \}/);
    expect(css).not.toMatch(/\.rl-reply-actions[^{]*\{[^}]*display: none/);
  });

  it("hangs the queue tray over the thread rather than taking its height", () => {
    const tray = readFileSync(join(process.cwd(), "src/components/ChatWorkbench.css"), "utf8");
    expect(tray).toMatch(/\.rl-queue-anchor \{ position: relative; height: 0;/);
    expect(tray).toMatch(/\.rl-queue-tray \{ position: absolute;/);
    expect(tray).toMatch(/\.rl-send \{[^}]*width: 28px; height: 28px;/);
  });
});

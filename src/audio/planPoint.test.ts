// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  POINT_MS,
  holdPoint,
  planBlock,
  pointAt,
  scrollToSection,
  sectionInView,
  sectionTitles,
  showComment,
  titleFor,
} from "./planPoint";
import type { Section } from "../types";

const section = (anchorId: string, title: string, children: Section[] = []): Section => ({
  anchorId,
  blockId: `blk-${anchorId}`,
  level: anchorId.split(".").length,
  title,
  bodyMarkdown: "",
  children,
  paragraphs: [],
});

const SECTIONS = [section("A", "Plan", [section("A.1", "Rollout"), section("A.2", "Risks")])];

let scrolled: Element[];
beforeEach(() => {
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  document.body.innerHTML = `
    <div class="doc-article">
      <h1 data-anchor-id="A">Plan</h1>
      <h2 data-anchor-id="A.1">Rollout</h2>
      <p data-anchor-id="A.1.p1">Ship it <span data-comment-id="c1">behind a flag</span>.</p>
      <h2 data-anchor-id="A.2">Risks</h2>
    </div>`;
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const block = (id: string) => document.querySelector(`[data-anchor-id="${id}"]`)!;

describe("planPoint", () => {
  it("reads every heading's title, and a block anchor as its section", () => {
    const titles = sectionTitles(SECTIONS);
    expect([...titles]).toEqual([["A", "Plan"], ["A.1", "Rollout"], ["A.2", "Risks"]]);
    expect(titleFor(titles, "A.1.p1")).toBe("Rollout");
    // An anchor the plan does not have gets no chip.
    expect(titleFor(titles, "Z.9")).toBeNull();
  });

  it("finds a block, falling back to its section", () => {
    expect(planBlock("A.1.p1")).toBe(block("A.1.p1"));
    expect(planBlock("A.2.p4")).toBe(block("A.2"));
    expect(planBlock("Q")).toBeNull();
  });

  it("outlines a section for a moment and never scrolls to it", () => {
    vi.useFakeTimers();
    pointAt("A.2");
    expect(block("A.2").classList.contains("rl-voice-point")).toBe(true);
    vi.advanceTimersByTime(POINT_MS);
    expect(block("A.2").classList.contains("rl-voice-point")).toBe(false);
    expect(scrolled).toEqual([]);
  });

  it("keeps a hovered section outlined past a spoken point", () => {
    vi.useFakeTimers();
    const release = holdPoint("A.1");
    pointAt("A.1");
    vi.advanceTimersByTime(POINT_MS);
    expect(block("A.1").classList.contains("rl-voice-point")).toBe(true);
    release();
    expect(block("A.1").classList.contains("rl-voice-point")).toBe(false);
  });

  it("scrolls only when a chip is clicked", () => {
    expect(scrollToSection("A.2")).toBe(true);
    expect(scrolled).toEqual([block("A.2")]);
    expect(scrollToSection("Q")).toBe(false);
  });

  it("shows a comment through its highlight's own click, else its block", () => {
    const highlight = document.querySelector<HTMLElement>('[data-comment-id="c1"]')!;
    const click = vi.fn();
    highlight.addEventListener("click", click);
    showComment("c1", "A.1.p1");
    expect(click).toHaveBeenCalledTimes(1);
    showComment("gone", "A.2");
    expect(scrolled).toEqual([block("A.2")]);
  });

  it("names the section in view the way the contents sidebar would", () => {
    // jsdom lays nothing out, so the window reads as scrolled to the bottom —
    // where the rule makes the last heading the one in view.
    expect(sectionInView(sectionTitles(SECTIONS))).toEqual({ anchorId: "A.2", title: "Risks" });
    document.body.innerHTML = "";
    expect(sectionInView(sectionTitles(SECTIONS))).toBeNull();
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  attachmentBody,
  classifyStep,
  composeTurn,
  follows,
  FOLLOW_WITHIN_PX,
  liveStepLabel,
  liveSteps,
  parkAt,
  userTurnParts,
  workRows,
  type TurnChip,
} from "./transcript";
import { promptForSelection } from "../browseSelection";
import { quoteItem } from "../browseList";
import { inspectorSeed } from "../../hooks/useElementPicker";
import contract from "./contract.json";

// Conformance: how a turn is drawn. Each title starts with the rule it pins.

const steps = (...labels: string[]) => labels.map((label, i) => ({ at: i + 1, kind: "tool", label }));
const row = (r: ReturnType<typeof workRows>[number]) => (r.kind === "explored" ? `Explored ${r.object}` : `${r.step.verb} ${r.step.object}`.trim());

describe("work rows", () => {
  it("BC-34 every phrase the bridge writes reads as a past-tense verb and its object", () => {
    const phrases = [...Object.values(contract.activityLabels), ...Object.values(contract.actionLabels), ...Object.values(contract.tabActivityLabels).map((p) => p.replace("{n}", "2"))];
    for (const phrase of phrases) {
      const step = classifyStep(phrase);
      // A phrase with no verb of its own would read back as itself, capitalized.
      expect(step.verb, phrase).not.toBe(phrase.charAt(0).toUpperCase() + phrase.slice(1).replace(/…$/, ""));
      expect(step.verb).toMatch(/^[A-Z]/);
    }
    expect(classifyStep("reading the page…")).toMatchObject({ kind: "read", verb: "Read", object: "the page", unit: "page" });
    expect(classifyStep("reading tab 2…")).toMatchObject({ kind: "read", object: "tab 2", unit: "page" });
    expect(classifyStep("checking in with a colleague…")).toMatchObject({ kind: "consult", verb: "Checked in with" });
    expect(classifyStep("clicking…")).toMatchObject({ kind: "act", verb: "Clicked" });
    expect(classifyStep("Grep(seat_burn)")).toMatchObject({ kind: "search", verb: "Searched", object: "seat_burn" });
    expect(classifyStep("Read…")).toMatchObject({ kind: "read", verb: "Read", object: "a file", unit: "file" });
    expect(classifyStep("Bash…")).toMatchObject({ kind: "act", verb: "Ran", object: "a command" });
  });

  it("BC-34 a run of reads and searches folds into one Explored row; actions and consults never fold", () => {
    const rows = workRows(steps("reading the page…", "searching the web…", "fetching a page…", "clicking…", "Clicked “Buy” · tab 2", "checking in with a colleague…", "reading tab 2…", "Grep…", "Read…"));
    expect(rows.map(row)).toEqual([
      "Explored 2 pages, 1 search",
      "Clicked “Buy” · tab 2",
      "Checked in with a colleague",
      "Explored 1 page, 1 file, 1 search",
    ]);
    // A lone look is a row of its own, not "Explored 1 page".
    expect(workRows(steps("reading the page…", "navigating…")).map(row)).toEqual(["Read the page", "Navigated"]);
  });

  it("BC-34 a page action's outcome takes the place of the call that asked for it", () => {
    expect(workRows(steps("navigating…", "Navigated to example.com/pricing · tab 2")).map(row)).toEqual(["Navigated to example.com/pricing · tab 2"]);
    expect(workRows(steps("acting on the page…", "Click failed — Target is not actionable · tab 1")).map(row)).toEqual(["Click failed — Target is not actionable · tab 1"]);
    // An outcome with no call before it (a ring that dropped the call) still reads.
    expect(workRows(steps("reading the page…", "Typed into “Email” · tab 1")).map(row)).toEqual(["Read the page", "Typed into “Email” · tab 1"]);
    // Two clicks are two rows.
    expect(workRows(steps("clicking…", "Clicked “Next” · tab 1", "clicking…", "Clicked “Next” · tab 1")).map(row)).toHaveLength(2);
  });

  it("BC-41 an action the user interrupted says they took over the page", () => {
    const [stopped] = workRows(steps("clicking…", `${contract.actionOutcomes.tookOver} · tab 2`));
    expect(stopped).toMatchObject({ kind: "step", step: { kind: "act", verb: "Stopped —", object: "you took over the page · tab 2", failed: true } });
  });

  it("BC-34 a live step becomes its past-tense row once anything comes after it", () => {
    const ring = [{ at: 1, kind: "thinking", label: "Thinking…" }, { at: 5, kind: "tool", label: "reading the page…" }];
    const quiet = () => false;
    expect(liveSteps(ring, quiet)).toEqual({ finished: [], running: ring[1] });
    // Text arrived after the step: it is done.
    expect(liveSteps(ring, (step) => step === ring[1])).toEqual({ finished: [ring[1]], running: null });
    // So did a thought.
    const thought = [...ring, { at: 7, kind: "thinking", label: "Thinking…" }];
    expect(liveSteps(thought, quiet)).toEqual({ finished: [ring[1]], running: null });
    // An outcome is never running: the action already has one.
    const acted = [...ring, { at: 8, kind: "tool", label: "Clicked “Buy” · tab 2" }];
    expect(liveSteps(acted, quiet).running).toBeNull();
  });

  it("BC-41 the live line names the step running now, a page action by its kind and tab", () => {
    expect(liveStepLabel("reading the page…")).toBe("Reading the page");
    expect(liveStepLabel("acting on the page…", { kind: "click", tab: 2 })).toBe("Clicking · tab 2");
    expect(liveStepLabel("acting on the page…", { kind: "navigate", tab: null })).toBe("Navigating");
    expect(liveStepLabel("Grep(seat_burn)")).toBe("Searching seat_burn");
    expect(liveStepLabel("Bash…")).toBe("Running a command");
    expect(liveStepLabel("checking in with a colleague…")).toBe("Checking in with a colleague");
  });
});

describe("the user's card", () => {
  const screenshot: TurnChip = { kind: "screenshot", label: "tab 2 — Docs", path: "/tmp/shot.png", width: 1200, height: 800, body: attachmentBody("screenshot", "tab 2 — Docs", "/tmp/shot.png", 1200, 800) };

  it("BC-40 chips survive sending: a message reads back into the chips it was composed from", () => {
    const quote = userTurnParts(promptForSelection({ id: 1, action: "ask", text: "Token buckets refill\nat a fixed rate.", url: "", title: "", note: "", locator: null })).chips[0];
    const element = userTurnParts(inspectorSeed({ tag: "button", accessibleName: "Buy now", selectors: ["#buy"] }).text).chips[0];
    expect(quote).toMatchObject({ kind: "quote", label: "Token buckets refill at a fixed rate." });
    expect(element).toMatchObject({ kind: "element", label: "<button> Buy now" });
    const chips = [quote, element, screenshot];
    const body = composeTurn(chips, "  Why does this cost more?  ");
    expect(userTurnParts(body)).toEqual({ chips, text: "Why does this cost more?" });
    // The agent reads the screenshot as a file it can open.
    expect(body).toContain("/tmp/shot.png");
  });

  it("BC-40 a Task-list item is a quote chip; a message with no context is all text", () => {
    const item = userTurnParts(quoteItem({ body: "Fix the hero padding", locator: "Hero" }, 3));
    expect(item.chips.map((c) => c.label)).toEqual(["Item 3: [Hero] — Fix the hero padding"]);
    expect(item.text).toBe("");
    expect(userTurnParts("Summarize this page.")).toEqual({ chips: [], text: "Summarize this page." });
    // Only leading context is a chip: a quote written mid-message is text.
    expect(userTurnParts("Compare:\n\n> theirs")).toEqual({ chips: [], text: "Compare:\n\n> theirs" });
  });
});

describe("following the thread", () => {
  it("BC-38 follows only within 48 px of the bottom", () => {
    expect(FOLLOW_WITHIN_PX).toBe(48);
    expect(follows({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(follows({ scrollHeight: 1000, scrollTop: 553, clientHeight: 400 })).toBe(true);
    expect(follows({ scrollHeight: 1000, scrollTop: 552, clientHeight: 400 })).toBe(false);
  });
  it("BC-38 parks a followed reply at its start once it outgrows the view, never one the reader left", () => {
    expect(parkAt({ following: true, replyTop: 900, replyHeight: 300, viewHeight: 500 })).toBeNull();
    expect(parkAt({ following: true, replyTop: 900, replyHeight: 600, viewHeight: 500 })).toBe(888);
    expect(parkAt({ following: false, replyTop: 900, replyHeight: 600, viewHeight: 500 })).toBeNull();
  });
});

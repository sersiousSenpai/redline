// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Never interrupt the user between tasks (10/10, R11–R16): what merely
// happens — a plan arriving, an agent asking for review, a run's report, a
// decision countdown, setup drifting — is news, never a move. Only a gesture
// opens a surface, switches one or takes the caret. These pins hold App's
// wiring; the rules themselves are tested where they live (planArrival,
// osNotice, TerminalView, Footer, FrontDoor, DecisionWindowBanner, the tour).
const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");
const between = (from: string, to: string) => {
  const start = app.indexOf(from);
  expect(start, `moved: ${from}`).toBeGreaterThan(-1);
  const end = app.indexOf(to, start);
  expect(end, `moved: ${to}`).toBeGreaterThan(start);
  return app.slice(start, end);
};

describe("a plan arriving while you are busy flashes", () => {
  const arrival = between("const planUnlisten =", "const detachedUnlisten =");

  it("asks whether you are writing, and which version you are reading, at the moment it lands", () => {
    expect(arrival).toContain("const writing = frontDoorOpenRef.current || writingNow(document.activeElement, typedAtRef.current, Date.now());");
    const focus = arrival.slice(arrival.indexOf("const focus = arrivalFocus({"), arrival.indexOf("});", arrival.indexOf("const focus = arrivalFocus({")));
    expect(focus).toContain("viewedVersion: viewedVersionRef.current");
    expect(focus).toContain("writing,");
    // The writing clock counts keys aimed at text fields, app-wide.
    expect(app).toMatch(/if \(isWritingKey\(event\.target\)\) typedAtRef\.current = Date\.now\(\);/);
  });

  it("a chat turns into its plan in place only while you sit idle in it", () => {
    expect(arrival).toMatch(/if \(!writing && dockScopeRef\.current === "home" && currentChatIdRef\.current === chatId/);
    expect(arrival).toContain('notice("Your chat became a plan", "Open");');
  });

  it("flashes with a glow, a badge on the pill and a notice — and opens nothing", () => {
    const flash = arrival.slice(arrival.indexOf("// flash"));
    expect(flash).toContain("setUnseenPlanIds(");
    // A new version under an older one you chose: fresh data, same view.
    expect(flash).toContain("if (revision) void loadSession(payload.sessionId);");
    expect(flash).not.toContain("setViewedVersionNumber");
    expect(flash).toContain("setArrivalGlow(");
    expect(flash).toContain('notice(arrivalMessage(title, revision), "Open");');
    expect(flash).not.toMatch(/setFrontDoorOpen\(true\)|setDoorCompact\(true\)|selectSurface/);
    expect(app.slice(app.indexOf("<MonochatIsland"), app.indexOf("</MonochatIsland>"))).toContain("arrivals={unseenPlanIds.size}");
  });

  it("only its notice's Open — a gesture — puts the door away for the plan", () => {
    const open = arrival.slice(arrival.indexOf("const openArrival = () => {"), arrival.indexOf("const notice ="));
    expect(open).toContain("setFrontDoorOpen(false);");
    expect(open).toContain("setDoorCompact(false);");
    // Nowhere else does an arrival close the door or the card.
    const rest = arrival.replace(open, "");
    expect(rest).not.toMatch(/setFrontDoorOpen\(|setDoorCompact\(/);
    // The notice is read where it can be seen: on the browser, above the page.
    expect(arrival).toContain('mainSurfaceRef.current === "browser" ? { placement: "top" as const } : {}');
  });
});

describe("an agent's review request or a run's report never switches the surface", () => {
  it("both events tell, and neither moves", () => {
    const review = between('const p = listen("review-requested"', "return () => {");
    expect(review).toContain('tellReview("review")');
    expect(review).not.toContain("selectSurface");
    const report = between('const rep = listen<{ sessionId: string }>("orchestration-report"', "return () => {");
    expect(report).toContain("setRunReportFor(e.payload.sessionId);");
    expect(report).toContain('tellReview("report")');
    expect(report).not.toContain("selectSurface");
  });

  it("a notice once, the footer's chip, and the OS only from another app", () => {
    const tell = between("const tellReview = useCallback(", "}, []);");
    // The only way to the review surface is the notice's own Open.
    expect(tell.match(/selectSurfaceRef\.current\("review"\)/g)).toHaveLength(1);
    expect(tell).toContain('action: { label: "Open", onAction: () => selectSurfaceRef.current("review") }');
    expect(tell).toContain('import("./lib/osNotice")');
    expect(tell).toContain("noticeWhenAway(");
    const footer = between("<Footer", "/>\n      </ChromeSlot>");
    expect(footer).toContain('reviewNews={reviewNews === "report" ? "Run report ready" : reviewNews === "review" ? "Review ready" : null}');
    expect(footer).toContain('onOpenReviewNews={() => selectSurface("review")}');
    // Over once you are there, or once the agent stops waiting.
    expect(app).toMatch(/if \(mainSurface === "review"\) setReviewNews\(null\);/);
    expect(app).toMatch(/if \(!codeReview\.holdActive\) setReviewNews\(/);
  });
});

describe("the decision countdown never brings Redline forward", () => {
  it("bounces the Dock and notifies instead of un-minimizing or focusing the window", () => {
    const decision = between("const decisionUnlisten = listen<PlanDecisionWindowEvent>(", "return () => {");
    expect(decision).toContain("noticeWhenAway(");
    expect(decision).not.toMatch(/unminimize|setFocus/);
    expect(app).not.toMatch(/\.unminimize\(\)|getCurrentWindow\(\)\.setFocus\(\)|w\.setFocus\(\)/);
  });
});

describe("boot takes no caret", () => {
  it("the door rests on the empty plate alone; every other restored surface shows only the pill", () => {
    expect(app).toContain('const plateAtRest = mainSurface === "document" && plateMode === "door";');
    expect(app).toMatch(/landing=\{plateAtRest && shellReady/);
    // Nothing at boot opens it, so its composer's autofocus never fires.
    expect(between("const [frontDoorOpen, setFrontDoorOpen] = useState(", "const [doorCompact")).toContain("return false;");
  });

  it("the terminal hands itself the caret only through the guard", () => {
    const view = readFileSync(join(process.cwd(), "src/components/TerminalView.tsx"), "utf8");
    const reveal = view.slice(view.indexOf("// Becoming visible:"), view.indexOf("return (", view.indexOf("// Becoming visible:")));
    expect(reveal).toMatch(/if \(host && revealMayFocus\(host\)\) term\?\.focus\(\);/);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { AiReviewDoneEvent } from "../types";
import RouterVerdictBanner, {
  routerBannerDetail,
  routerBannerLine,
} from "./RouterVerdictBanner";

// The contracts under test: the banner is SHADOW-labeled (the user must never
// read it as an action the app took), it renders nothing for verdict-less
// payloads (older backends), and it carries zero interactive surface — no
// buttons, no links — because the verdict drives no behavior.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

beforeEach(() => {
  document.body.innerHTML = "";
});

const attendSummary: AiReviewDoneEvent = {
  reviewId: "rev-1",
  added: 2,
  important: 1,
  nits: 1,
  preExisting: 0,
  verdict: "attend",
  verdictReason: "touches the auth scope table",
  verdictSignals: ["auth_surface", "important_findings"],
  verdictBar: 1,
  verdictCitedSeq: null,
};

function render(summary: AiReviewDoneEvent | null): {
  root: Root;
  host: HTMLElement;
} {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(RouterVerdictBanner, { summary }));
  });
  return { root, host };
}

describe("routerBannerLine", () => {
  it("labels the verdict as shadow / would-have", () => {
    expect(routerBannerLine(attendSummary)).toBe(
      "router (shadow): attend — touches the auth scope table",
    );
  });

  it("yields nothing without a verdict (null or an older payload)", () => {
    expect(routerBannerLine(null)).toBeNull();
    expect(
      routerBannerLine({
        reviewId: "r",
        added: 0,
        important: 0,
        nits: 0,
        preExisting: 0,
      }),
    ).toBeNull();
  });

  it("keeps the record self-describing: signals + bar in the detail", () => {
    expect(routerBannerDetail(attendSummary)).toBe(
      "signals: auth_surface, important_findings · bar: 1",
    );
    expect(
      routerBannerDetail({ ...attendSummary, verdictSignals: [], verdictBar: 2 }),
    ).toBe("signals: none · bar: 2");
  });
});

describe("RouterVerdictBanner", () => {
  it("renders the shadow verdict with no interactive surface", () => {
    const { host } = render(attendSummary);
    const banner = host.querySelector('[data-testid="router-verdict-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("data-verdict")).toBe("attend");
    expect(banner?.textContent).toContain("router (shadow): attend");
    expect(banner?.textContent).toContain("signals: auth_surface");
    // Shadow guard, FE side: nothing to click — the verdict does nothing.
    expect(banner?.querySelectorAll("button, a, input").length).toBe(0);
  });

  it("renders an auto verdict the same informational way", () => {
    const { host } = render({
      ...attendSummary,
      verdict: "auto",
      verdictReason: "no risk signals fired",
      verdictSignals: [],
    });
    const banner = host.querySelector('[data-testid="router-verdict-banner"]');
    expect(banner?.getAttribute("data-verdict")).toBe("auto");
    expect(banner?.textContent).toContain("router (shadow): auto");
  });

  it("renders nothing at all without a verdict", () => {
    const { host } = render(null);
    expect(host.querySelector('[data-testid="router-verdict-banner"]')).toBeNull();
  });
});
